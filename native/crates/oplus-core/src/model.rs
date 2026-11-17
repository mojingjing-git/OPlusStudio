use crate::{Result, protocol::Identity};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub const MACRO_KEYS: [u8; 18] = [
    18, 19, 13, 14, 15, 16, 1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 93, 94,
];
pub const LABELS: [&str; 6] = ["M1", "M2", "LM", "RM", "LK", "RK"];
pub const SLOT_ORDER: [&str; 8] = ["M1", "M2", "M3", "M4", "M5", "M6", "ML", "MR"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SupportTier {
    Verified,
    Compatible,
    ReadOnly,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capabilities {
    pub sticks: u8,
    pub triggers: u8,
    pub motors: u8,
    pub turbo: u8,
    pub macros: u8,
    pub changekey: u8,
    pub lighting: u8,
    pub engine: u8,
    pub nfc: u8,
    pub sensor: u8,
    pub raw_hex: String,
}
impl Capabilities {
    pub fn parse(record: &Record) -> Result<Self> {
        let d = record.bytes()?;
        if d.len() < 10 {
            return Err("能力描述符不足 10 字节".into());
        }
        Ok(Self {
            sticks: d[0],
            triggers: d[1],
            motors: d[2],
            turbo: d[3],
            macros: d[4],
            changekey: d[5],
            lighting: d[6],
            engine: d[7],
            nfc: d[8],
            sensor: d[9],
            raw_hex: hex::encode(&d),
        })
    }
    pub fn active_slots(&self) -> Vec<u8> {
        (0..8u8).filter(|&s| (self.macros >> s) & 1 != 0).collect()
    }
    pub fn motor_channels(&self) -> Vec<u8> {
        (0..4u8).filter(|&c| (self.motors >> c) & 1 != 0).collect()
    }
    pub fn lighting_zones(&self) -> Vec<u8> {
        (0..4u8).filter(|&z| (self.lighting >> z) & 1 != 0).collect()
    }
    /// D8.bit1: per-slot macro step limits queried via 0xB0 kind 6.
    pub fn has_per_slot_macro_limits(&self) -> bool {
        (self.engine & 0x02) != 0
    }
    /// D6.bit1: remapping selectable target list queried via 0xB0 kind 7.
    pub fn has_remap_select_list(&self) -> bool {
        (self.changekey & 0x02) != 0
    }
}

pub fn unhex(text: &str) -> Result<Vec<u8>> {
    hex::decode(
        text.chars()
            .filter(|c| !c.is_whitespace())
            .collect::<String>(),
    )
    .map_err(|_| "无效十六进制记录".into())
}
pub fn hex_spaced(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .join(" ")
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Record {
    pub declared: usize,
    pub hex: String,
    #[serde(default)]
    pub text: Option<String>,
}
impl Record {
    pub fn new(bytes: &[u8]) -> Self {
        Self {
            declared: bytes.len(),
            hex: hex_spaced(bytes),
            text: None,
        }
    }
    pub fn bytes(&self) -> Result<Vec<u8>> {
        let data = unhex(&self.hex)?;
        if data.len() != self.declared || data.len() > 239 {
            return Err("记录长度不匹配".into());
        }
        Ok(data)
    }
    pub fn payload(&self) -> Result<Vec<u8>> {
        let mut p = vec![self.declared as u8];
        p.extend(self.bytes()?);
        Ok(p)
    }
    pub fn from_payload(p: &[u8]) -> Result<Self> {
        if p.is_empty() || p[0] as usize != p.len() - 1 {
            return Err("记录长度前缀不匹配".into());
        }
        Ok(Self::new(&p[1..]))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub address: String,
    pub identity: Identity,
    pub raw: BTreeMap<String, Record>,
    pub decoded: Value,
    pub capabilities: Record,
    #[serde(default)]
    pub errors: Vec<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}
impl Snapshot {
    pub fn keys(&self, name: &str) -> Result<Vec<u8>> {
        self.decoded
            .get(name)
            .and_then(Value::as_array)
            .ok_or_else(|| format!("缺少设备按键表 {name}"))?
            .iter()
            .map(|n| {
                n.as_u64()
                    .filter(|n| *n <= 255)
                    .map(|n| n as u8)
                    .ok_or_else(|| "无效按键码".into())
            })
            .collect()
    }
    pub fn parsed_capabilities(&self) -> Result<Capabilities> {
        Capabilities::parse(&self.capabilities)
    }
    pub fn active_slots(&self) -> Vec<u8> {
        self.parsed_capabilities()
            .map(|c| c.active_slots())
            .unwrap_or_default()
    }
    pub fn remap_targets(&self) -> Result<Vec<u8>> {
        let caps = self.parsed_capabilities()?;
        if caps.has_remap_select_list() {
            self.keys("remap_targets")
        } else {
            self.keys("remap_keys")
        }
    }
    pub fn slot_step_limit(&self, slot: u8) -> usize {
        self.decoded
            .get("macro_limits")
            .and_then(Value::as_array)
            .and_then(|arr| arr.get(slot as usize))
            .and_then(Value::as_u64)
            .filter(|&lim| lim > 0)
            .map(|lim| (lim as usize).clamp(1, 47))
            .unwrap_or(42)
    }
    pub fn support_tier(&self) -> SupportTier {
        if self.identity.effective_generation() != 2 {
            return SupportTier::ReadOnly;
        }
        let Ok(caps) = self.parsed_capabilities() else {
            return SupportTier::ReadOnly;
        };
        if caps.macros == 0 && caps.motors == 0 && caps.changekey == 0 && caps.lighting == 0 {
            return SupportTier::ReadOnly;
        }
        if caps.macros != 0 {
            let slots = caps.active_slots();
            if slots.is_empty() {
                return SupportTier::ReadOnly;
            }
            let Ok(mk) = self.keys("macro_keys") else {
                return SupportTier::ReadOnly;
            };
            let Ok(layout) = Layout::new(&mk) else {
                return SupportTier::ReadOnly;
            };
            if caps.has_per_slot_macro_limits()
                && self
                    .decoded
                    .get("macro_limits")
                    .and_then(Value::as_array)
                    .is_none()
            {
                return SupportTier::ReadOnly;
            }
            for s in slots {
                let Ok(rec) = self.record(&format!("macro_{s}")) else {
                    return SupportTier::ReadOnly;
                };
                if layout.validate(&rec).is_err() {
                    return SupportTier::ReadOnly;
                }
            }
        }
        if caps.motors != 0 {
            let Ok(m) = self.record("motors") else {
                return SupportTier::ReadOnly;
            };
            if m.len() < 5 {
                return SupportTier::ReadOnly;
            }
        }
        if caps.changekey != 0 {
            let Ok(rk) = self.keys("remap_keys") else {
                return SupportTier::ReadOnly;
            };
            if rk.is_empty() || self.remap_targets().map(|t| t.is_empty()).unwrap_or(true) {
                return SupportTier::ReadOnly;
            }
            let Ok(rem) = self.record("remapping") else {
                return SupportTier::ReadOnly;
            };
            let norm = normalize_payload_for(self, "remapping", rem);
            if norm.len() != rk.len() + 1 {
                return SupportTier::ReadOnly;
            }
        }
        if caps.lighting != 0 {
            let Ok(l) = self.record("lighting") else {
                return SupportTier::ReadOnly;
            };
            if l.len() < 7 || !(l.len() - 1).is_multiple_of(6) {
                return SupportTier::ReadOnly;
            }
        }
        if self.identity.is_verified_137()
            && self.keys("macro_keys").ok().as_deref() == Some(&MACRO_KEYS)
            && self
                .capabilities
                .bytes()
                .is_ok_and(|b| b == [3, 3, 15, 0, 63, 1, 11, 0, 192, 0])
        {
            SupportTier::Verified
        } else {
            SupportTier::Compatible
        }
    }
    pub fn layout(&self) -> Result<Layout> {
        if self.support_tier() == SupportTier::ReadOnly {
            return Err("当前设备处于只读模式，不支持编辑宏布局".into());
        }
        Layout::new(&self.keys("macro_keys")?)
    }
    pub fn record(&self, key: &str) -> Result<Vec<u8>> {
        self.raw
            .get(key)
            .ok_or_else(|| format!("缺少 {key} 记录"))?
            .payload()
    }
    pub fn validate_rear(&self) -> Result<()> {
        if self.support_tier() == SupportTier::ReadOnly {
            return Err("当前设备处于只读模式".into());
        }
        let caps = self.parsed_capabilities()?;
        if caps.macros == 0 {
            return Ok(());
        }
        let spec = self.layout()?;
        for i in caps.active_slots() {
            spec.validate(&self.record(&format!("macro_{i}"))?)?;
        }
        Ok(())
    }
    pub fn preset(&self) -> BTreeMap<u8, String> {
        if self.support_tier() == SupportTier::ReadOnly {
            return BTreeMap::new();
        }
        let slots = self.active_slots();
        if self.identity.vid == "1005" && slots.as_slice() == [0, 1, 2, 3, 4, 5] {
            LABELS
                .iter()
                .enumerate()
                .map(|(i, n)| (i as u8, (*n).to_string()))
                .collect()
        } else {
            slots
                .into_iter()
                .map(|s| (s, SLOT_ORDER[s as usize].to_string()))
                .collect()
        }
    }
}

#[derive(Debug, Clone)]
pub struct Layout {
    pub digital: BTreeMap<u8, u8>,
    pub analog: BTreeMap<u8, u8>,
    pub neutral: u32,
}
impl Layout {
    pub fn new(keys: &[u8]) -> Result<Self> {
        if keys.is_empty()
            || keys.contains(&0)
            || keys.iter().collect::<BTreeSet<_>>().len() != keys.len()
        {
            return Err("宏按键表为空、包含键码 0 或存在重复项".into());
        }
        let (mut digital, mut analog, mut pos, mut neutral) =
            (BTreeMap::new(), BTreeMap::new(), 0u8, 0u32);
        for &key in keys {
            if key == 18 || key == 19 {
                if pos > 20 {
                    return Err("宏布局超过 24 位".into());
                }
                analog.insert(key, pos);
                neutral |= 8 << pos;
                pos += 4;
            } else {
                if pos >= 24 {
                    return Err("宏布局超过 24 位".into());
                }
                digital.insert(key, pos);
                pos += 1;
            }
        }
        Ok(Self {
            digital,
            analog,
            neutral,
        })
    }
    pub fn mask(&self, tokens: &[&str]) -> Result<u32> {
        if tokens.is_empty() {
            return Err("请选择输出按键".into());
        }
        let mut mask = self.neutral;
        let mut seen = BTreeMap::new();
        for token in tokens {
            let t = token.trim().to_uppercase().replace('-', "_");
            if t == "WAIT" {
                continue;
            }
            let stick = if t.starts_with("LS_") {
                Some(18)
            } else if t.starts_with("RS_") {
                Some(19)
            } else {
                None
            };
            if let Some(stick) = stick {
                let name = &t[3..];
                let dir = DIRECTIONS
                    .iter()
                    .position(|x| *x == name)
                    .ok_or("无效摇杆方向")? as u32;
                if seen.insert(stick, dir).is_some_and(|old| old != dir) {
                    return Err("同一摇杆不能同时指向两个方向".into());
                }
                let shift = *self.analog.get(&stick).ok_or("设备不支持该摇杆宏")?;
                mask = (mask & !(15 << shift)) | (dir << shift);
            } else {
                let key = key_code(&t).ok_or_else(|| format!("未知按键：{t}"))?;
                mask |= 1 << *self.digital.get(&key).ok_or("设备不支持该宏按键")?;
            }
        }
        Ok(mask)
    }
    pub fn names(&self, mask: u32) -> Vec<String> {
        let mut names = vec![];
        // The Python reference describes digital keys in device-list bit order.
        let mut digital = self.digital.iter().collect::<Vec<_>>();
        digital.sort_by_key(|(_, bit)| **bit);
        for (&key, &bit) in digital {
            if mask & (1 << bit) != 0 {
                names.push(
                    key_name(key)
                        .map(String::from)
                        .unwrap_or_else(|| format!("KEY_{key}")),
                );
            }
        }
        for (&key, &shift) in &self.analog {
            let nib = (mask >> shift) & 15;
            if nib < 8 {
                names.push(format!(
                    "{}_{}",
                    if key == 18 { "LS" } else { "RS" },
                    DIRECTIONS[nib as usize]
                ));
            }
        }
        names
    }
    pub fn validate(&self, p: &[u8]) -> Result<()> {
        if p == [0] {
            return Ok(());
        }
        if p.len() < 8
            || p.len() > 238
            || p[0] as usize != p.len() - 1
            || !(p.len() - 3).is_multiple_of(5)
            || p[2] & 0x70 != 0
        {
            return Err("宏记录结构或保留位无效".into());
        }
        let mut allowed = 0u32;
        for &bit in self.digital.values() {
            allowed |= 1 << bit;
        }
        for &shift in self.analog.values() {
            allowed |= 15 << shift;
        }
        for step in p[3..].chunks_exact(5) {
            let mask = step[0] as u32 | ((step[1] as u32) << 8) | ((step[2] as u32) << 16);
            if mask & !allowed != 0 || self.analog.values().any(|s| ((mask >> s) & 15) > 8) {
                return Err("宏记录使用未知位或无效摇杆方向".into());
            }
        }
        Ok(())
    }
}

const DIRECTIONS: [&str; 8] = [
    "UP",
    "UP_RIGHT",
    "RIGHT",
    "DOWN_RIGHT",
    "DOWN",
    "DOWN_LEFT",
    "LEFT",
    "UP_LEFT",
];
const KEY_NAMES: [(u8, &str); 25] = [
    (1, "A"),
    (2, "B"),
    (3, "X"),
    (4, "Y"),
    (5, "LB"),
    (6, "RB"),
    (7, "LT"),
    (8, "RT"),
    (9, "SELECT_LEGACY"),
    (10, "START_LEGACY"),
    (11, "L3"),
    (12, "R3"),
    (13, "DPAD_DOWN"),
    (14, "DPAD_UP"),
    (15, "DPAD_RIGHT"),
    (16, "DPAD_LEFT"),
    (17, "HOME"),
    (18, "LSTICK_ANALOG"),
    (19, "RSTICK_ANALOG"),
    (93, "SELECT"),
    (94, "START"),
    (95, "CAPTURE"),
    (96, "TURBO"),
    (97, "M_LEFT"),
    (104, "M2"),
];
pub fn key_name(code: u8) -> Option<&'static str> {
    KEY_NAMES.iter().find(|(c, _)| *c == code).map(|(_, n)| *n)
}
pub fn key_code(name: &str) -> Option<u8> {
    match name {
        "LS" => Some(11),
        "RS" => Some(12),
        "BACK" => Some(93),
        _ => {
            if let Some((_, code)) = KEY_NAMES.iter().find(|(_, n)| *n == name).map(|(c, n)| (n, *c)) {
                return Some(code);
            }
            if let Some(rest) = name.strip_prefix("KEY_") {
                if let Ok(code) = rest.parse::<u8>() {
                    if code != 0 && format!("KEY_{code}") == name {
                        return Some(code);
                    }
                }
            }
            None
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Step {
    pub mask: u32,
    pub duration_ms: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Program {
    pub steps: Vec<Step>,
    pub loop_ms: u32,
    pub trigger: u8,
}
impl Program {
    pub fn parse(p: &[u8], layout: &Layout) -> Result<Self> {
        layout.validate(p)?;
        if p == [0] {
            return Ok(Self {
                steps: vec![],
                loop_ms: 0,
                trigger: 0,
            });
        }
        let steps = p[3..]
            .chunks_exact(5)
            .map(|s| Step {
                mask: s[0] as u32 | ((step_b(s, 1)) << 8) | ((step_b(s, 2)) << 16),
                duration_ms: u16::from_le_bytes([s[3], s[4]]) as u32 * 5,
            })
            .collect();
        Ok(Self {
            steps,
            loop_ms: (p[1] as u32 | (((p[2] & 15) as u32) << 8)) * 5,
            trigger: p[2] >> 7,
        })
    }
    pub fn encode(&self, layout: &Layout) -> Result<Vec<u8>> {
        self.encode_with_limit(layout, 42)
    }
    pub fn encode_with_limit(&self, layout: &Layout, max_steps: usize) -> Result<Vec<u8>> {
        let cap = max_steps.clamp(1, 47);
        if self.steps.is_empty()
            || self.steps.len() > cap
            || self.loop_ms > 20000
            || !self.loop_ms.is_multiple_of(5)
            || self.trigger > 1
        {
            return Err("宏步骤数、循环时间或触发模式无效".into());
        }
        let ticks = self.loop_ms / 5;
        let mut data = vec![
            (2 + self.steps.len() * 5) as u8,
            ticks as u8,
            ((ticks >> 8) as u8) | (self.trigger << 7),
        ];
        for step in &self.steps {
            if step.mask > 0xffffff || !step.duration_ms.is_multiple_of(5) || step.duration_ms / 5 > 65535 {
                return Err("宏步骤超出格式范围".into());
            }
            data.extend_from_slice(&[
                (step.mask & 255) as u8,
                ((step.mask >> 8) & 255) as u8,
                ((step.mask >> 16) & 255) as u8,
            ]);
            data.extend_from_slice(&((step.duration_ms / 5) as u16).to_le_bytes());
        }
        layout.validate(&data)?;
        Ok(data)
    }
    pub fn translate(&self, src: &Layout, dst: &Layout) -> Result<Self> {
        let mut out_steps = Vec::with_capacity(self.steps.len());
        for step in &self.steps {
            let mut new_mask = dst.neutral;
            for (&key, &src_bit) in &src.digital {
                if (step.mask & (1 << src_bit)) != 0 {
                    let &dst_bit = dst.digital.get(&key).ok_or_else(|| {
                        format!(
                            "当前手柄不支持导入配置中的按键 {}",
                            key_name(key)
                                .map(String::from)
                                .unwrap_or_else(|| format!("KEY_{key}"))
                        )
                    })?;
                    new_mask |= 1 << dst_bit;
                }
            }
            for (&stick, &src_shift) in &src.analog {
                let nib = (step.mask >> src_shift) & 15;
                if nib < 8 {
                    let &dst_shift = dst
                        .analog
                        .get(&stick)
                        .ok_or("当前手柄不支持导入配置中的摇杆方向宏")?;
                    new_mask = (new_mask & !(15 << dst_shift)) | (nib << dst_shift);
                } else if nib > 8 {
                    return Err("导入配置包含无效摇杆方向".into());
                }
            }
            out_steps.push(Step {
                mask: new_mask,
                duration_ms: step.duration_ms,
            });
        }
        Ok(Self {
            steps: out_steps,
            loop_ms: self.loop_ms,
            trigger: self.trigger,
        })
    }
    pub fn sequence(&self, layout: &Layout) -> String {
        let mut groups: Vec<(String, u32, u32)> = vec![];
        for step in &self.steps {
            let keys = layout.names(step.mask);
            if keys.is_empty() {
                if let Some(last) = groups.last_mut() {
                    last.2 += step.duration_ms;
                } else {
                    groups.push(("WAIT".into(), step.duration_ms, 0));
                }
            } else {
                groups.push((keys.join("+"), step.duration_ms, 0));
            }
        }
        groups
            .into_iter()
            .map(|(k, h, g)| format!("{k}:{h}/{g}"))
            .collect::<Vec<_>>()
            .join(", ")
    }
}
#[inline]
fn step_b(s: &[u8], i: usize) -> u32 {
    s[i] as u32
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Change {
    Hold {
        keys: Vec<u8>,
    },
    Macro {
        sequence: String,
        #[serde(default)]
        loop_ms: u32,
        #[serde(default)]
        trigger: u8,
    },
    Record {
        payload: String,
    },
}
impl Change {
    pub fn encode(&self, snapshot: &Snapshot) -> Result<Vec<u8>> {
        self.encode_with_limit(snapshot, 42)
    }
    pub fn encode_for_slot(&self, snapshot: &Snapshot, slot: u8) -> Result<Vec<u8>> {
        if !snapshot.active_slots().contains(&slot) {
            return Err("该背键槽位在当前手柄上未启用".into());
        }
        self.encode_with_limit(snapshot, snapshot.slot_step_limit(slot))
    }
    fn encode_with_limit(&self, snapshot: &Snapshot, max_steps: usize) -> Result<Vec<u8>> {
        let layout = snapshot.layout()?;
        let cap = max_steps.clamp(1, 47);
        let p = match self {
            Self::Record { payload } => {
                let raw = unhex(payload)?;
                layout.validate(&raw)?;
                if raw != [0] && (raw.len() - 3) / 5 > cap {
                    return Err("宏步骤数超出该背键槽位上限".into());
                }
                raw
            }
            Self::Hold { keys } => {
                if keys.is_empty() || keys.iter().collect::<BTreeSet<_>>().len() != keys.len() {
                    return Err("保持映射不能为空或重复".into());
                }
                if [[13u8, 14], [15, 16]]
                    .iter()
                    .any(|pair| pair.iter().all(|k| keys.contains(k)))
                {
                    return Err("不能同时选择相反十字键".into());
                }
                let mut mask = layout.neutral;
                for key in keys {
                    mask |= 1 << *layout.digital.get(key).ok_or("保持映射目标不受支持")?;
                }
                Program {
                    steps: vec![Step {
                        mask,
                        duration_ms: 0,
                    }],
                    loop_ms: 0,
                    trigger: 0,
                }
                .encode_with_limit(&layout, cap)?
            }
            Self::Macro {
                sequence,
                loop_ms,
                trigger,
            } => {
                if sequence.trim().is_empty() {
                    return Err("请添加宏步骤".into());
                }
                let mut steps = vec![];
                for group in sequence.split(',') {
                    let (keys, timing) = group
                        .trim()
                        .split_once(':')
                        .unwrap_or((group.trim(), "100/60"));
                    let (hold, gap) = timing.split_once('/').unwrap_or((timing, "60"));
                    let h = hold.parse::<u32>().map_err(|_| "按住时间无效")?;
                    let g = gap.parse::<u32>().map_err(|_| "间隔时间无效")?;
                    if !(5..=10000).contains(&h) || g > 10000 || !h.is_multiple_of(5) || !g.is_multiple_of(5) {
                        return Err("按住 5–10000 ms、间隔 0–10000 ms，按 5 ms 步进".into());
                    }
                    let mask = layout.mask(&keys.split('+').collect::<Vec<_>>())?;
                    steps.push(Step {
                        mask,
                        duration_ms: h,
                    });
                    if g > 0 {
                        steps.push(Step {
                            mask: layout.neutral,
                            duration_ms: g,
                        });
                    }
                }
                Program {
                    steps,
                    loop_ms: *loop_ms,
                    trigger: *trigger,
                }
                .encode_with_limit(&layout, cap)?
            }
        };
        layout.validate(&p)?;
        Ok(p)
    }
}

pub fn form(snapshot: &Snapshot, slot: u8) -> Result<Change> {
    if !snapshot.active_slots().contains(&slot) {
        return Err("无效背键槽位".into());
    }
    let layout = snapshot.layout()?;
    let p = snapshot.record(&format!("macro_{slot}"))?;
    let program = Program::parse(&p, &layout)?;
    if program.steps.len() == 1
        && program.steps[0].duration_ms == 0
        && program.loop_ms == 0
        && program.trigger == 0
        && layout
            .analog
            .values()
            .all(|s| ((program.steps[0].mask >> s) & 15) == 8)
    {
        return Ok(Change::Hold {
            keys: layout
                .digital
                .iter()
                .filter(|(_, bit)| program.steps[0].mask & (1 << **bit) != 0)
                .map(|(k, _)| *k)
                .collect(),
        });
    }
    if program.steps.is_empty() {
        return Ok(Change::Record {
            payload: "00".into(),
        });
    }
    let change = Change::Macro {
        sequence: program.sequence(&layout),
        loop_ms: program.loop_ms,
        trigger: program.trigger,
    };
    if change.encode_for_slot(snapshot, slot).ok().as_deref() == Some(&p) {
        Ok(change)
    } else {
        Ok(Change::Record {
            payload: hex_spaced(&p),
        })
    }
}

pub fn validate_record(snapshot: &Snapshot, key: &str, p: &[u8]) -> Result<()> {
    if snapshot.support_tier() == SupportTier::ReadOnly {
        return Err("当前设备处于只读模式，禁止写入配置".into());
    }
    let caps = snapshot.parsed_capabilities()?;
    let record = Record::from_payload(p)?;
    match key {
        k if k.starts_with("macro_") => {
            let slot = k[6..].parse::<u8>().map_err(|_| "无效槽位")?;
            if !caps.active_slots().contains(&slot) {
                return Err("无效或未启用的背键槽位".into());
            }
            snapshot.layout()?.validate(p)?;
            if p != [0] && (p.len() - 3) / 5 > snapshot.slot_step_limit(slot) {
                return Err("宏步骤数超出该槽位上限".into());
            }
        }
        "motors" => {
            if caps.motors == 0 {
                return Err("设备不支持振动配置".into());
            }
            let orig = snapshot.record("motors")?;
            if orig.len() < 5 || p.len() != orig.len() {
                return Err("马达记录长度不匹配".into());
            }
        }
        "remapping" => {
            if caps.changekey == 0 {
                return Err("设备不支持标准按键改键".into());
            }
            let sources = snapshot.keys("remap_keys")?;
            let targets = snapshot.remap_targets()?;
            if record.declared != sources.len() {
                return Err("标准映射长度与按键表不匹配".into());
            }
            if record.bytes()?.iter().any(|v| *v != 0 && !targets.contains(v)) {
                return Err("标准映射包含不支持的目标按键".into());
            }
        }
        "lighting" => {
            if caps.lighting == 0 {
                return Err("设备不支持灯光配置".into());
            }
            let orig = snapshot.record("lighting")?;
            if orig.len() < 7 || !(orig.len() - 1).is_multiple_of(6) || p.len() != orig.len() {
                return Err("灯光记录长度不匹配".into());
            }
        }
        _ => return Err("不允许写入该记录".into()),
    }
    Ok(())
}

pub fn normalize_payload(key: &str, p: Vec<u8>) -> Vec<u8> {
    if key == "remapping" && p == [0] {
        let mut data = vec![16];
        data.extend([0; 16]);
        data
    } else {
        p
    }
}

pub fn normalize_payload_for(snapshot: &Snapshot, key: &str, p: Vec<u8>) -> Vec<u8> {
    if key == "remapping" && p == [0] {
        let len = snapshot.keys("remap_keys").map(|k| k.len()).unwrap_or(16);
        let mut data = vec![len as u8];
        data.extend(std::iter::repeat_n(0, len));
        data
    } else {
        p
    }
}

pub fn desired_setting(snapshot: &Snapshot, feature: &str, change: &Value) -> Result<Vec<u8>> {
    if snapshot.support_tier() == SupportTier::ReadOnly {
        return Err("当前设备处于只读模式，禁止修改配置".into());
    }
    let caps = snapshot.parsed_capabilities()?;
    let orig = normalize_payload_for(snapshot, feature, snapshot.record(feature)?);
    let mut p = orig.clone();
    match feature {
        "motors" => {
            if caps.motors == 0 || p.len() < 5 {
                return Err("马达记录不可写或不完整".into());
            }
            if let Some(ch) = change.get("channel").and_then(Value::as_u64) {
                let ch = ch as usize;
                if ch >= 4 || (caps.motors & (1 << ch)) == 0 {
                    return Err("该振动通道未在设备上启用".into());
                }
                let lvl = change
                    .get("level")
                    .and_then(Value::as_u64)
                    .filter(|&v| v <= 100)
                    .ok_or("强度应为 0–100")?;
                p[1 + ch] = ((lvl as f64 * 255.0 / 100.0).round_ties_even()) as u8;
            } else {
                let values = change["levels"]
                    .as_array()
                    .filter(|v| v.len() == 4)
                    .ok_or("需要四个强度值")?;
                for (i, n) in values.iter().enumerate() {
                    if n.is_null() {
                        p[i + 1] = orig[i + 1];
                        continue;
                    }
                    let v = n.as_u64().filter(|n| *n <= 100).ok_or("强度应为 0–100")?;
                    if (caps.motors & (1 << i)) != 0 {
                        p[i + 1] = ((v as f64 * 255.0 / 100.0).round_ties_even()) as u8;
                    } else {
                        p[i + 1] = orig[i + 1];
                    }
                }
            }
        }
        "remapping" => {
            if caps.changekey == 0 {
                return Err("设备不支持标准按键改键".into());
            }
            let sources = snapshot.keys("remap_keys")?;
            let targets = snapshot.remap_targets()?;
            if p.len() != sources.len() + 1 {
                return Err("标准映射记录不完整".into());
            }
            let source = change["source"]
                .as_u64()
                .filter(|v| *v <= 255)
                .ok_or("无效来源键")? as u8;
            let target = change["target"]
                .as_u64()
                .filter(|v| *v <= 255)
                .ok_or("无效目标键")? as u8;
            let i = sources
                .iter()
                .position(|x| *x == source)
                .ok_or("来源键不支持")?;
            if matches!(source, 93 | 94) {
                if target != 0 && target != source {
                    return Err("固件不支持将 Back / Start 作为改键来源（仅允许恢复默认或作为其他键的目标）".into());
                }
                p[i + 1] = 0;
            } else {
                if target != 0 && target != source && !targets.contains(&target) {
                    return Err("目标键不支持".into());
                }
                p[i + 1] = if target == 0 || target == source {
                    0
                } else {
                    target
                };
            }
        }
        "lighting" => {
            let zone = change["zone"]
                .as_u64()
                .filter(|v| *v < 4)
                .ok_or("无效灯区")? as usize;
            if p.len() < 7 || !(p.len() - 1).is_multiple_of(6) {
                return Err("灯光记录不完整".into());
            }
            let zone_count = (p.len() - 1) / 6;
            if zone >= zone_count || (caps.lighting & (1 << zone)) == 0 {
                return Err("灯区不支持".into());
            }
            let text = change["rgb"]
                .as_str()
                .filter(|s| s.starts_with('#') && s.len() == 7)
                .ok_or("颜色应为 #RRGGBB")?;
            let rgb = unhex(&text[1..])?;
            p[1 + zone * 6..4 + zone * 6].copy_from_slice(&rgb);
        }
        _ => return Err("未知设置".into()),
    }
    validate_record(snapshot, feature, &p)?;
    Ok(p)
}

pub fn profile(snapshot: &Snapshot, labels: &BTreeMap<u8, String>) -> Result<Value> {
    snapshot.validate_rear()?;
    let active = snapshot.active_slots();
    if active.is_empty() {
        return Err("当前手柄没有可导出的背键宏槽".into());
    }
    let mut slots = vec![];
    for i in active {
        slots.push(json!({
            "slot": i,
            "payload": hex_spaced(&snapshot.record(&format!("macro_{i}"))?),
            "label": labels.get(&i).cloned().unwrap_or_default()
        }));
    }
    Ok(json!({
        "format": "oplus-rear-v1",
        "identity": snapshot.identity,
        "macro_keys": snapshot.keys("macro_keys")?,
        "slots": slots
    }))
}

pub fn import_profile(data: &[u8], snapshot: &Snapshot) -> Result<BTreeMap<u8, Change>> {
    if snapshot.support_tier() == SupportTier::ReadOnly {
        return Err("当前设备为只读模式，无法导入背键配置".into());
    }
    if data.len() > 65536 {
        return Err("配置文件超过 64 KiB".into());
    }
    let text = std::str::from_utf8(data)
        .map_err(|_| "配置必须为 UTF-8")?
        .trim_start_matches('\u{feff}');
    let mut v: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    if v.get("format").is_none() {
        let backup: Snapshot = serde_json::from_value(v).map_err(|e| e.to_string())?;
        v = profile(&backup, &BTreeMap::new())?;
    }
    if v["format"] != "oplus-rear-v1" {
        return Err("不支持的背键配置文件格式".into());
    }
    let identity: Identity =
        serde_json::from_value(v["identity"].clone()).map_err(|_| "缺少设备身份")?;
    if identity.effective_generation() != 2 {
        return Err("导入配置非第二代协议格式".into());
    }
    let src_macro_keys: Vec<u8> = v["macro_keys"]
        .as_array()
        .ok_or("缺少源文件宏按键表")?
        .iter()
        .map(|n| {
            n.as_u64()
                .filter(|&x| x <= 255)
                .map(|x| x as u8)
                .ok_or_else(|| "源文件宏按键码无效".into())
        })
        .collect::<Result<_>>()?;
    let src_layout = Layout::new(&src_macro_keys)?;
    let dst_macro_keys = snapshot.keys("macro_keys")?;
    let dst_layout = snapshot.layout()?;
    let active_slots = snapshot.active_slots();

    let slots = v["slots"]
        .as_array()
        .filter(|s| (1..=8).contains(&s.len()))
        .ok_or("配置必须包含 1–8 个背键槽")?;
    let (mut seen, mut changes) = (BTreeSet::new(), BTreeMap::new());
    for row in slots {
        let slot = row["slot"]
            .as_u64()
            .filter(|s| *s < 8)
            .ok_or("无效槽位")? as u8;
        if !seen.insert(slot) {
            return Err("重复槽位".into());
        }
        if !active_slots.contains(&slot) {
            return Err(format!("当前手柄不存在背键槽位 {}", slot + 1));
        }
        let text = row["payload"].as_str().ok_or("缺少宏记录")?;
        let src_bytes = unhex(text)?;
        src_layout.validate(&src_bytes)?;
        let current_bytes = snapshot.record(&format!("macro_{slot}"))?;
        if src_bytes == [0] {
            if current_bytes != [0] {
                return Err("空槽清空尚未验证".into());
            }
            continue;
        }
        let limit = snapshot.slot_step_limit(slot);
        let dst_bytes = if src_macro_keys == dst_macro_keys {
            dst_layout.validate(&src_bytes)?;
            let prog = Program::parse(&src_bytes, &dst_layout)?;
            if prog.steps.len() > limit {
                return Err(format!("槽位 {} 的宏步数超出当前手柄上限（{} 步）", slot + 1, limit));
            }
            src_bytes
        } else {
            let src_prog = Program::parse(&src_bytes, &src_layout)?;
            let dst_prog = src_prog.translate(&src_layout, &dst_layout)?;
            dst_prog.encode_with_limit(&dst_layout, limit)?
        };
        if dst_bytes != current_bytes {
            changes.insert(
                slot,
                Change::Record {
                    payload: hex_spaced(&dst_bytes),
                },
            );
        }
    }
    Ok(changes)
}

pub fn diagnostic_bundle(snapshot: &Snapshot) -> Value {
    let tier = snapshot.support_tier();
    let caps = snapshot.parsed_capabilities().ok();
    json!({
        "format": "oplus-diagnostic-v1",
        "app_version": "0.6.0",
        "address": snapshot.address,
        "support_tier": tier,
        "effective_generation": snapshot.identity.effective_generation(),
        "verified_137": snapshot.identity.is_verified_137(),
        "device_name": snapshot.decoded.get("device_name").cloned().unwrap_or(Value::Null),
        "identity": snapshot.identity,
        "capabilities_raw": snapshot.capabilities,
        "capabilities_decoded": caps.as_ref().map(|c| json!({
            "sticks": c.sticks,
            "triggers": c.triggers,
            "motors": c.motors,
            "motor_channels": c.motor_channels(),
            "turbo": c.turbo,
            "macros": c.macros,
            "active_slots": c.active_slots(),
            "changekey": c.changekey,
            "has_remap_select_list": c.has_remap_select_list(),
            "lighting": c.lighting,
            "lighting_zones": c.lighting_zones(),
            "engine": c.engine,
            "has_per_slot_macro_limits": c.has_per_slot_macro_limits(),
            "nfc": c.nfc,
            "sensor": c.sensor,
        })),
        "decoded": snapshot.decoded,
        "raw": snapshot.raw,
        "errors": snapshot.errors,
    })
}
