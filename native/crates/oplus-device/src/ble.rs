use async_trait::async_trait;
use btleplug::{
    api::{
        Central, CharPropFlags, Characteristic, Manager as _, Peripheral as _, ScanFilter,
        ValueNotification, WriteType,
    },
    platform::{Manager, Peripheral},
};
use futures::{Stream, StreamExt};
use oplus_core::{
    Result,
    model::{Capabilities, Record, Snapshot, SupportTier, VERIFIED_137_CAPS},
    protocol::{self as p, Identity, Packet, name_claims_oplus},
    transaction::Device,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{collections::BTreeMap, pin::Pin, time::Duration};
use tokio::time::{sleep, timeout};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Candidate {
    pub name: String,
    pub address: String,
    pub rssi: Option<i16>,
    pub likely: bool,
    pub confirmed_service: bool,
}

async fn peripherals(seconds: u64) -> Result<Vec<Peripheral>> {
    let manager = Manager::new().await.map_err(|e| e.to_string())?;
    let adapters = manager.adapters().await.map_err(|e| e.to_string())?;
    if adapters.is_empty() {
        return Err("Windows 未发现可用蓝牙适配器，请检查系统蓝牙开关".into());
    }
    let mut out = vec![];
    for adapter in adapters {
        adapter
            .start_scan(ScanFilter::default())
            .await
            .map_err(|e| e.to_string())?;
        sleep(Duration::from_secs(seconds)).await;
        let result = adapter.peripherals().await;
        let _ = adapter.stop_scan().await;
        out.extend(result.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

pub async fn scan() -> Result<Vec<Candidate>> {
    let mut out = vec![];
    for d in peripherals(5).await? {
        if let Some(props) = d.properties().await.map_err(|e| e.to_string())? {
            let name = props.local_name.unwrap_or_else(|| "未命名设备".into());
            let address = d.address().to_string();
            let confirmed_service = props
                .services
                .contains(&Uuid::parse_str(p::SERVICE).unwrap());
            let lower = name.to_lowercase();
            let likely = confirmed_service
                || address.to_uppercase().starts_with("98:B6:E")
                || ["o+", "oplus", "o plus", "致动", "zd", "keylink"]
                    .iter()
                    .any(|t| lower.contains(t));
            out.push(Candidate {
                name,
                address,
                rssi: props.rssi,
                likely,
                confirmed_service,
            });
        }
    }
    out.sort_by_key(|d| (!d.confirmed_service, !d.likely, -d.rssi.unwrap_or(-127)));
    out.dedup_by(|a, b| a.address == b.address);
    Ok(out)
}

pub struct Session {
    peripheral: Peripheral,
    write_char: Characteristic,
    notify_char: Characteristic,
    notifications: Pin<Box<dyn Stream<Item = ValueNotification> + Send>>,
    pub identity: Identity,
    pub address: String,
    pub local_name: Option<String>,
    pub is_oplus: bool,
    power_query_unsupported: bool,
    pub can_write: bool,
    pub writable_slots: Vec<u8>,
    serial: u32,
    write_counter: u32,
    host_counter: u8,
    pub trace: Vec<serde_json::Value>,
}

impl Session {
    pub async fn connect(address: &str) -> Result<Self> {
        if address.len() != 17 || address.chars().any(|c| !c.is_ascii_hexdigit() && c != ':') {
            return Err("请选择有效的蓝牙设备".into());
        }
        let devices = peripherals(2).await?;
        let peripheral = devices
            .into_iter()
            .find(|d| d.address().to_string().eq_ignore_ascii_case(address))
            .ok_or("没有发现手柄，请开机、退出手机 KeyLinker 后重试")?;
        let local_name = peripheral
            .properties()
            .await
            .ok()
            .flatten()
            .and_then(|pr| pr.local_name)
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty());
        let init = async {
            peripheral
                .connect_with_timeout(Duration::from_secs(12))
                .await
                .map_err(|e| e.to_string())?;
            peripheral
                .discover_services_with_timeout(Duration::from_secs(12))
                .await
                .map_err(|e| e.to_string())?;
            if !peripheral
                .services()
                .iter()
                .any(|s| s.uuid == Uuid::parse_str(p::SERVICE).unwrap())
            {
                return Err("该设备没有 KeyLinker 配置服务".into());
            }
            let chars = peripheral.characteristics();
            let write_char = chars
                .iter()
                .find(|c| c.uuid == Uuid::parse_str(p::WRITE).unwrap())
                .cloned()
                .ok_or("缺少配置写入特征")?;
            let notify_char = chars
                .iter()
                .find(|c| c.uuid == Uuid::parse_str(p::NOTIFY).unwrap())
                .cloned()
                .ok_or("缺少配置通知特征")?;
            let notifications = peripheral
                .notifications()
                .await
                .map_err(|e| e.to_string())?;
            timeout(Duration::from_secs(3), peripheral.subscribe(&notify_char))
                .await
                .map_err(|_| "订阅超时")?
                .map_err(|e| e.to_string())?;
            let mut s = Self {
                peripheral: peripheral.clone(),
                write_char,
                notify_char,
                notifications,
                identity: Identity {
                    vid: "".into(),
                    pid: "".into(),
                    version_display: "".into(),
                    mode: 0,
                    generation: 0,
                    sensor: 0,
                },
                address: address.to_uppercase(),
                local_name,
                is_oplus: false,
                power_query_unsupported: false,
                can_write: false,
                writable_slots: vec![],
                serial: 0,
                write_counter: 0,
                host_counter: 0,
                trace: vec![],
            };
            s.identity = Identity::parse(&s.query(0x91, &[]).await?.payload)?;
            s.is_oplus = s.identity.is_oplus_id()
                || s.local_name.as_deref().is_some_and(name_claims_oplus);
            Ok(s)
        }
        .await;
        if init.is_err() {
            let _ = timeout(Duration::from_secs(3), peripheral.disconnect()).await;
        }
        init
    }

    fn nonce(&self) -> u8 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .subsec_nanos() as u8
    }

    fn push_trace(&mut self, entry: serde_json::Value) {
        if self.trace.len() >= 512 {
            self.trace.remove(0);
        }
        self.trace.push(entry);
    }

    async fn exchange(&mut self, wire: Vec<u8>) -> Result<Packet> {
        self.exchange_timeout(wire, Duration::from_secs(3)).await
    }

    async fn exchange_timeout(&mut self, wire: Vec<u8>, wait: Duration) -> Result<Packet> {
        let sent = p::parse(&wire)?;
        self.push_trace(json!({
            "direction": "tx",
            "opcode": sent.opcode,
            "serial": sent.serial,
            "payload": hex::encode(&sent.payload),
            "wire": hex::encode(&wire)
        }));
        let mode = if self.write_char.properties.contains(CharPropFlags::WRITE) {
            WriteType::WithResponse
        } else {
            WriteType::WithoutResponse
        };
        timeout(wait, async {
            self.peripheral
                .write(&self.write_char, &wire, mode)
                .await
                .map_err(|e| e.to_string())?;
            while let Some(n) = self.notifications.next().await {
                if n.uuid != self.notify_char.uuid {
                    continue;
                }
                if let Ok(packet) = p::parse(&n.value) {
                    self.push_trace(json!({
                        "direction": "rx",
                        "opcode": packet.opcode,
                        "serial": packet.serial,
                        "payload": hex::encode(&packet.payload),
                        "wire": hex::encode(&n.value)
                    }));
                    if packet.opcode == 0x19 && packet.serial == sent.serial {
                        return Ok(packet);
                    }
                }
            }
            Err("设备通知已断开".into())
        })
        .await
        .map_err(|_| "手柄响应超时，请保持开机并关闭手机 KeyLinker".to_string())?
    }

    async fn read_battery(&mut self) -> Option<p::BatteryStatus> {
        if self.power_query_unsupported {
            return None;
        }
        self.serial += 1;
        let enter_serial =
            (self.serial % 128) as u8 | if self.serial.is_multiple_of(2) { 128 } else { 0 };
        let enter_wire = p::power_control_frame(false, enter_serial, self.nonce()).ok()?;
        let reply = self
            .exchange_timeout(enter_wire, Duration::from_millis(750))
            .await;
        // Immediately restore NORMAL_MODE (0x1E 02 DF AB) so live 0x1F streaming stops cleanly
        self.serial += 1;
        let exit_serial =
            (self.serial % 128) as u8 | if self.serial.is_multiple_of(2) { 128 } else { 0 };
        if let Ok(exit_wire) = p::power_control_frame(true, exit_serial, self.nonce()) {
            let _ = self
                .exchange_timeout(exit_wire, Duration::from_millis(600))
                .await;
        }
        match reply {
            Ok(pkt) => p::parse_power_reply(&pkt.payload),
            Err(_) => {
                self.power_query_unsupported = true;
                None
            }
        }
    }

    async fn query(&mut self, opcode: u8, payload: &[u8]) -> Result<Packet> {
        self.serial += 1;
        let serial = (self.serial % 128) as u8 | if self.serial.is_multiple_of(2) { 128 } else { 0 };
        let wire = p::query(
            opcode,
            payload,
            serial,
            self.nonce(),
            self.identity.effective_generation() == 2 || self.is_oplus,
        )?;
        self.exchange(wire).await
    }

    async fn record(&mut self, op: u8, args: &[u8]) -> Result<Record> {
        let first = self.query(op, args).await?;
        let (&declared, initial) = first.payload.split_first().ok_or("响应缺少记录长度")?;
        let mut data = initial.to_vec();
        for page in 1..32 {
            if data.len() >= declared as usize {
                break;
            }
            let mut query = args.to_vec();
            query[0] = page;
            let more = self.query(op, &query).await?;
            if more.payload.is_empty() {
                return Err("分段响应为空".into());
            }
            data.extend(more.payload);
        }
        if data.len() != declared as usize {
            return Err("记录声明长度与分段响应不一致".into());
        }
        Ok(Record::new(&data))
    }

    async fn snapshot_record(&mut self, op: u8, args: &[u8]) -> Result<Record> {
        match self.record(op, args).await {
            Ok(r) => Ok(r),
            Err(_) => {
                sleep(Duration::from_millis(60)).await;
                self.record(op, args).await
            }
        }
    }

    pub async fn close(&mut self) {
        let _ = timeout(
            Duration::from_secs(3),
            self.peripheral.unsubscribe(&self.notify_char),
        )
        .await;
        let _ = timeout(Duration::from_secs(3), self.peripheral.disconnect()).await;
    }
}

#[async_trait]
impl Device for Session {
    async fn snapshot(&mut self) -> Result<Snapshot> {
        self.can_write = false;
        self.writable_slots.clear();

        let mut raw = BTreeMap::new();
        let mut decoded = serde_json::Map::new();
        let mut errors = vec![];

        // Best-effort 0x90 controller internal name read (non-fatal on timeout)
        if let Ok(name_rec) = self.record(0x90, &[0]).await {
            if let Ok(bytes) = name_rec.bytes() {
                let clean: String = String::from_utf8_lossy(&bytes)
                    .trim_matches(|c: char| c == '\0' || c.is_control())
                    .trim()
                    .to_string();
                if !clean.is_empty() {
                    decoded.insert("device_name".into(), json!(clean));
                }
            }
        }
        if !decoded.contains_key("device_name") {
            if let Some(local) = &self.local_name {
                decoded.insert("device_name".into(), json!(local));
            }
        }
        if decoded
            .get("device_name")
            .and_then(|v| v.as_str())
            .is_some_and(name_claims_oplus)
        {
            self.is_oplus = true;
        }

        // Read capability descriptor 0xB0 kind 1; O+ controllers fall back to standard O+ capabilities
        let mut capabilities = match self.snapshot_record(0xb0, &[0, 1]).await {
            Ok(c) => c,
            Err(e) => {
                if !self.is_oplus {
                    errors.push(format!("读取能力描述符失败（已降级为只读诊断模式）：{e}"));
                    return Ok(Snapshot {
                        address: self.address.clone(),
                        identity: self.identity.clone(),
                        raw,
                        decoded: decoded.into(),
                        capabilities: Record::new(&[]),
                        errors,
                        extra: BTreeMap::from([("trace".into(), json!(self.trace))]),
                    });
                }
                errors.push(format!("读取能力描述符失败（已按 O+ 默认能力开放编辑）：{e}"));
                Record::new(&VERIFIED_137_CAPS)
            }
        };

        if self.identity.effective_generation() != 2 && !self.is_oplus {
            for (name, kind) in [("all_keys", 2u8), ("remap_keys", 3), ("macro_keys", 5)] {
                if let Ok(r) = self.record(0xb0, &[0, kind]).await {
                    if let Ok(bytes) = r.bytes() {
                        if let Ok(keys) = p::decode_keys(&bytes) {
                            decoded.insert(name.into(), json!(keys));
                        }
                    }
                    raw.insert(name.into(), r);
                }
            }
            if let Some(batt) = self.read_battery().await {
                decoded.insert("battery".into(), json!(batt));
            }
            errors.push(format!(
                "设备协议有效代际为 {}（非 KeyLinker 第二代协议），已开放只读查看与诊断导出",
                self.identity.effective_generation()
            ));
            return Ok(Snapshot {
                address: self.address.clone(),
                identity: self.identity.clone(),
                raw,
                decoded: decoded.into(),
                capabilities,
                errors,
                extra: BTreeMap::from([("trace".into(), json!(self.trace))]),
            });
        }

        let caps = match Capabilities::parse(&capabilities) {
            Ok(c) => c,
            Err(e) => {
                if !self.is_oplus {
                    errors.push(format!("解析能力描述符失败（已降级为只读模式）：{e}"));
                    return Ok(Snapshot {
                        address: self.address.clone(),
                        identity: self.identity.clone(),
                        raw,
                        decoded: decoded.into(),
                        capabilities,
                        errors,
                        extra: BTreeMap::from([("trace".into(), json!(self.trace))]),
                    });
                }
                errors.push(format!("解析能力描述符失败（已按 O+ 默认能力开放编辑）：{e}"));
                capabilities = Record::new(&VERIFIED_137_CAPS);
                Capabilities::parse(&capabilities)?
            }
        };

        // Always try reading all_keys (kind 2)
        match self.snapshot_record(0xb0, &[0, 2]).await {
            Ok(r) => {
                match r.bytes().and_then(|b| p::decode_keys(&b)) {
                    Ok(keys) => {
                        decoded.insert("all_keys".into(), json!(keys));
                    }
                    Err(e) => errors.push(format!("解码 all_keys 失败：{e}")),
                }
                raw.insert("all_keys".into(), r);
            }
            Err(e) => errors.push(format!("读取 all_keys 失败：{e}")),
        }

        // Read remap_keys (kind 3) and optional remap_targets (kind 7, D6.bit1) when changekey != 0
        if caps.changekey != 0 {
            match self.snapshot_record(0xb0, &[0, 3]).await {
                Ok(r) => {
                    match r.bytes().and_then(|b| p::decode_keys(&b)) {
                        Ok(keys) => {
                            decoded.insert("remap_keys".into(), json!(keys));
                        }
                        Err(e) => errors.push(format!("解码 remap_keys 失败：{e}")),
                    }
                    raw.insert("remap_keys".into(), r);
                }
                Err(e) => errors.push(format!("读取 remap_keys 失败：{e}")),
            }
            if caps.has_remap_select_list() {
                match self.snapshot_record(0xb0, &[0, 7]).await {
                    Ok(r) => {
                        match r.bytes().and_then(|b| p::decode_keys(&b)) {
                            Ok(keys) => {
                                decoded.insert("remap_targets".into(), json!(keys));
                            }
                            Err(e) => errors.push(format!("解码 remap_targets 失败：{e}")),
                        }
                        raw.insert("remap_targets".into(), r);
                    }
                    Err(e) => errors.push(format!("读取 remap_targets 失败：{e}")),
                }
            }
        }

        // Read macro_keys (kind 5) and optional macro_limits (kind 6, D8.bit1) when macros != 0
        if caps.macros != 0 {
            match self.snapshot_record(0xb0, &[0, 5]).await {
                Ok(r) => {
                    match r.bytes().and_then(|b| p::decode_keys(&b)) {
                        Ok(keys) => {
                            decoded.insert("macro_keys".into(), json!(keys));
                        }
                        Err(e) => errors.push(format!("解码 macro_keys 失败：{e}")),
                    }
                    raw.insert("macro_keys".into(), r);
                }
                Err(e) => errors.push(format!("读取 macro_keys 失败：{e}")),
            }
            if caps.has_per_slot_macro_limits() {
                match self.snapshot_record(0xb0, &[0, 6]).await {
                    Ok(r) => {
                        match r.bytes().and_then(|b| p::decode_macro_limits(&b)) {
                            Ok(limits) => {
                                decoded.insert("macro_limits".into(), json!(limits));
                            }
                            Err(e) => errors.push(format!("解码 macro_limits 失败：{e}")),
                        }
                        raw.insert("macro_limits".into(), r);
                    }
                    Err(e) => errors.push(format!("读取 macro_limits 失败：{e}")),
                }
            }
        }

        // Read setting records strictly on-demand according to capability bits
        for (enabled, name, op) in [
            (caps.sticks != 0, "sticks", 0xb1u8),
            (caps.triggers != 0, "triggers", 0xb2),
            (caps.motors != 0, "motors", 0xb3),
            (caps.changekey != 0, "remapping", 0xb6),
            (caps.lighting != 0, "lighting", 0xb7),
        ] {
            if enabled {
                match self.snapshot_record(op, &[0]).await {
                    Ok(r) => {
                        raw.insert(name.into(), r);
                    }
                    Err(e) => errors.push(format!("读取 {name} 失败：{e}")),
                }
            }
        }

        for slot in caps.active_slots() {
            match self.snapshot_record(0xb5, &[0, slot]).await {
                Ok(r) => {
                    raw.insert(format!("macro_{slot}"), r);
                }
                Err(e) => errors.push(format!("读取 macro_{slot} 失败：{e}")),
            }
        }

        if let Some(batt) = self.read_battery().await {
            decoded.insert("battery".into(), json!(batt));
        }

        let mut snapshot = Snapshot {
            address: self.address.clone(),
            identity: self.identity.clone(),
            raw,
            decoded: decoded.into(),
            capabilities,
            errors,
            extra: BTreeMap::from([("trace".into(), json!(self.trace))]),
        };

        if snapshot.claims_oplus() {
            self.is_oplus = true;
            snapshot.hydrate_oplus_defaults();
        }

        if snapshot.support_tier() != SupportTier::ReadOnly {
            self.can_write = true;
            self.writable_slots = snapshot.active_slots();
        }
        Ok(snapshot)
    }

    async fn read(&mut self, key: &str) -> Result<Vec<u8>> {
        let (op, args) = read_spec(key)?;
        self.record(op, &args).await?.payload()
    }

    async fn write(&mut self, key: &str, payload: &[u8]) -> Result<()> {
        if !self.can_write || (self.identity.effective_generation() != 2 && !self.is_oplus) {
            return Err("当前设备处于只读模式，禁止写入".into());
        }
        if payload.is_empty() || payload.len() > 240 || payload[0] as usize != payload.len() - 1 {
            return Err("记录前缀长度或分片边界无效".into());
        }
        let (op, slot) = if let Some(n) = key.strip_prefix("macro_") {
            let slot = n.parse::<u8>().map_err(|_| "无效槽位")?;
            if slot >= 8
                || !self.writable_slots.contains(&slot)
                || !(8..=238).contains(&payload.len())
                || !(payload.len() - 3).is_multiple_of(5)
            {
                return Err("宏记录结构或槽位无效".into());
            }
            (0x35, Some(slot))
        } else {
            let op = match key {
                "sticks" => {
                    if payload.len() != 15 {
                        return Err("摇杆记录长度超出安全边界".into());
                    }
                    0x31
                }
                "triggers" => {
                    if payload.len() != 15 {
                        return Err("扳机记录长度超出安全边界".into());
                    }
                    0x32
                }
                "motors" => {
                    if !(5..=240).contains(&payload.len()) {
                        return Err("马达记录长度超出安全边界".into());
                    }
                    0x33
                }
                "remapping" => {
                    if !(2..=240).contains(&payload.len()) {
                        return Err("改键记录长度超出安全边界".into());
                    }
                    0x36
                }
                "lighting" => {
                    if !(7..=240).contains(&payload.len())
                        || !(payload.len() - 1).is_multiple_of(6)
                    {
                        return Err("灯光记录长度超出安全边界".into());
                    }
                    0x37
                }
                _ => return Err("不支持写入此记录".into()),
            };
            (op, None)
        };

        for (chunk, piece) in payload.chunks(15).enumerate() {
            self.write_counter += 1;
            let serial = p::save_serial(chunk as u8, self.write_counter)?;
            let length = if let Some(slot) = slot {
                (slot << 5) | (piece.len() + 5) as u8
            } else {
                self.host_counter = self.host_counter.wrapping_sub(1) % 8;
                p::host_length(piece.len(), self.host_counter)?
            };
            let wire = p::frame(op, piece, serial, self.nonce(), Some(length))?;
            self.exchange(wire).await?;
            sleep(Duration::from_millis(120)).await;
        }
        Ok(())
    }

    async fn reconnect(&mut self) -> Result<()> {
        let expected = self.identity.clone();
        let prev_is_oplus = self.is_oplus;
        let prev_can_write = self.can_write;
        let prev_slots = self.writable_slots.clone();
        self.close().await;
        let mut new = Self::connect(&self.address).await?;
        if new.identity != expected {
            new.close().await;
            return Err("重连设备身份与原设备不同，已停止恢复".into());
        }
        new.is_oplus |= prev_is_oplus;
        new.can_write = prev_can_write;
        new.writable_slots = prev_slots;
        *self = new;
        Ok(())
    }
}

pub fn read_spec(key: &str) -> Result<(u8, Vec<u8>)> {
    if let Some(n) = key.strip_prefix("macro_") {
        let n = n.parse::<u8>().map_err(|_| "无效槽位")?;
        if n < 8 {
            return Ok((0xb5, vec![0, n]));
        }
        return Err("无效槽位".into());
    }
    let op = match key {
        "sticks" => 0xb1,
        "triggers" => 0xb2,
        "motors" => 0xb3,
        "remapping" => 0xb6,
        "lighting" => 0xb7,
        _ => return Err("不支持读取此记录".into()),
    };
    Ok((op, vec![0]))
}
