//! Durable, expected-value guarded writes. A failed write is considered attempted
//! even if no acknowledgement arrived. Every attempted record is restored.
use crate::{
    Result,
    model::{Snapshot, SupportTier, normalize_payload_for, validate_record},
    protocol::Identity,
    storage,
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};

#[async_trait]
pub trait Device: Send {
    async fn snapshot(&mut self) -> Result<Snapshot>;
    async fn read(&mut self, key: &str) -> Result<Vec<u8>>;
    async fn write(&mut self, key: &str, payload: &[u8]) -> Result<()>;
    async fn reconnect(&mut self) -> Result<()> {
        Err("设备不支持重新连接".into())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Edit {
    pub key: String,
    pub expected: Vec<u8>,
    pub target: Vec<u8>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    pub key: String,
    pub original: Vec<u8>,
    pub target: Vec<u8>,
    pub attempted: bool,
    pub state: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Journal {
    pub schema: u8,
    pub id: String,
    pub kind: String,
    pub address: String,
    pub identity: Identity,
    pub backup: String,
    pub backup_sha256: String,
    pub state: String,
    pub records: Vec<Entry>,
    pub errors: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Receipt {
    pub journal: Journal,
    pub snapshot: Snapshot,
}
impl Journal {
    pub fn terminal(&self) -> bool {
        self.state == "completed" || self.state == "rolled_back"
    }
    pub fn path(&self, root: &Path) -> PathBuf {
        root.join("journals").join(format!("{}.json", self.id))
    }
    pub fn persist(&self, root: &Path) -> Result<()> {
        storage::save(&self.path(root), self)
    }
}

pub fn normalize_against(key: &str, readback: Vec<u8>, reference: &[u8]) -> Vec<u8> {
    if key == "remapping" && readback == [0] && !reference.is_empty() {
        let count = reference[0] as usize;
        if reference.len() == count + 1 {
            let mut out = vec![reference[0]];
            out.extend(std::iter::repeat_n(0u8, count));
            return out;
        }
    }
    readback
}

pub fn boundary(snapshot: &Snapshot, key: &str, original: &[u8], target: &[u8]) -> Result<()> {
    validate_record(snapshot, key, target)?;
    if key.starts_with("macro_") && (original == [0] || target == [0]) {
        return Err("空背键记录的写入与恢复尚未验证".into());
    }
    if key == "sticks" {
        let caps = snapshot.parsed_capabilities()?;
        if original.len() != 15
            || target.len() != 15
            || original[0] != 14
            || target[0] != 14
        {
            return Err("摇杆记录长度不匹配".into());
        }
        for side in 0..2u8 {
            let off = 1 + (side as usize) * 7;
            if !caps.has_stick_side(side) && original[off..off + 7] != target[off..off + 7] {
                return Err("不能修改未启用的摇杆通道".into());
            }
            if (original[off + 6] & 0xF8) != (target[off + 6] & 0xF8) {
                return Err("不能修改摇杆的未知标志位".into());
            }
        }
    }
    if key == "triggers" {
        let caps = snapshot.parsed_capabilities()?;
        if original.len() != 15
            || target.len() != 15
            || original[0] != 14
            || target[0] != 14
        {
            return Err("扳机记录长度不匹配".into());
        }
        for side in 0..2u8 {
            let off = 1 + (side as usize) * 7;
            if !caps.has_trigger_side(side) && original[off..off + 7] != target[off..off + 7] {
                return Err("不能修改未启用的扳机通道".into());
            }
            if original[off + 6] != target[off + 6] {
                return Err("不能修改扳机的未知标志位".into());
            }
        }
    }
    if key == "motors" {
        let caps = snapshot.parsed_capabilities()?;
        if original.len() < 5 || target.len() != original.len() || original[5..] != target[5..] {
            return Err("不能修改电机的未知字段".into());
        }
        for ch in 0..4usize {
            if (caps.motors & (1 << ch)) == 0 && original[1 + ch] != target[1 + ch] {
                return Err("不能修改未启用的电机通道".into());
            }
        }
    }
    if key == "lighting" {
        let caps = snapshot.parsed_capabilities()?;
        if original.len() < 7
            || !(original.len() - 1).is_multiple_of(6)
            || target.len() != original.len()
        {
            return Err("灯光记录不完整".into());
        }
        for i in 1..original.len() {
            let zone = (i - 1) / 6;
            let rgb = (i - 1) % 6 < 3;
            let zone_supported = zone < 4 && (caps.lighting & (1 << zone)) != 0;
            if original[i] != target[i] && (!rgb || !zone_supported) {
                return Err("不能修改灯光的未知字段或未支持区域".into());
            }
        }
    }
    Ok(())
}

pub async fn prepare(
    device: &mut dyn Device,
    root: &Path,
    kind: &str,
    edits: Vec<Edit>,
) -> Result<(Journal, Snapshot)> {
    let snapshot = device.snapshot().await?;
    if snapshot.support_tier() == SupportTier::ReadOnly {
        return Err("当前设备处于只读诊断模式，禁止写入配置".into());
    }
    snapshot.validate_rear()?;
    if edits.len() > 20 {
        return Err("单次事务修改记录数超出上限".into());
    }
    let mut seen = BTreeSet::new();
    let mut records = vec![];
    for e in edits {
        if !seen.insert(e.key.clone()) {
            return Err("同一记录重复提交".into());
        }
        let original = normalize_payload_for(&snapshot, &e.key, snapshot.record(&e.key)?);
        let expected = normalize_against(&e.key, e.expected, &original);
        let target = normalize_against(&e.key, e.target, &original);
        if original != expected {
            return Err(format!("{} 已被其他软件修改，请重新读取后比较", e.key));
        }
        boundary(&snapshot, &e.key, &original, &target)?;
        if original != target {
            records.push(Entry {
                key: e.key,
                original,
                target,
                attempted: false,
                state: "prepared".into(),
            });
        }
    }
    if records.is_empty() {
        return Err("没有需要保存的更改".into());
    }
    if !["save", "undo", "identification", "recovery", "validation"].contains(&kind) {
        return Err("未知事务类型".into());
    }
    let id = storage::id();
    let backup = format!("backups/rust-{id}.json");
    let data = serde_json::to_vec_pretty(&snapshot).map_err(|e| e.to_string())?;
    storage::atomic(&root.join(&backup), &data)?;
    let j = Journal {
        schema: 1,
        id,
        kind: kind.into(),
        address: snapshot.address.clone(),
        identity: snapshot.identity.clone(),
        backup,
        backup_sha256: storage::hash(&data),
        state: "prepared".into(),
        records,
        errors: vec![],
    };
    j.persist(root)?;
    Ok((j, snapshot))
}

pub async fn apply(device: &mut dyn Device, root: &Path, j: &mut Journal) -> Result<()> {
    for i in 0..j.records.len() {
        j.records[i].attempted = true;
        j.records[i].state = "write_intent".into();
        j.state = "writing".into();
        j.persist(root)?;
        let e = &j.records[i];
        device.write(&e.key, &e.target).await?;
        if normalize_against(&e.key, device.read(&e.key).await?, &e.target) != e.target {
            return Err(format!("{} 保存后回读不一致", e.key));
        }
        j.records[i].state = "verified".into();
        j.persist(root)?;
    }
    j.state = if j.kind == "identification" {
        "sampling"
    } else {
        "completed"
    }
    .into();
    j.persist(root)
}

pub async fn rollback(device: &mut dyn Device, root: &Path, j: &mut Journal) -> bool {
    j.state = "restoring".into();
    if let Err(e) = j.persist(root) {
        j.errors.push(format!("恢复日志：{e}"));
    }
    let mut reconnected = false;
    let mut ok = true;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(180);
    for i in (0..j.records.len()).rev() {
        if !j.records[i].attempted || j.records[i].state == "restored" {
            continue;
        }
        j.records[i].state = "restore_intent".into();
        let _ = j.persist(root);
        let entry = j.records[i].clone();
        let restore = async {
            device.write(&entry.key, &entry.original).await?;
            if normalize_against(&entry.key, device.read(&entry.key).await?, &entry.original)
                != entry.original
            {
                return Err("恢复回读不一致".into());
            }
            Ok(())
        };
        let limit = deadline.min(tokio::time::Instant::now() + std::time::Duration::from_secs(25));
        let mut result: Result<()> = tokio::time::timeout_at(limit, restore)
            .await
            .unwrap_or_else(|_| Err("恢复记录超时".into()));
        if result.is_err() && !reconnected && tokio::time::Instant::now() < deadline {
            reconnected = true;
            if tokio::time::timeout_at(deadline, device.reconnect())
                .await
                .is_ok_and(|r| r.is_ok())
            {
                result = tokio::time::timeout_at(
                    deadline.min(tokio::time::Instant::now() + std::time::Duration::from_secs(25)),
                    async {
                        device.write(&entry.key, &entry.original).await?;
                        if normalize_against(
                            &entry.key,
                            device.read(&entry.key).await?,
                            &entry.original,
                        ) != entry.original
                        {
                            return Err("重连后恢复回读不一致".into());
                        }
                        Ok(())
                    },
                )
                .await
                .unwrap_or_else(|_| Err("重连恢复超时".into()));
            }
        }
        match result {
            Ok(()) => {
                j.records[i].state = "restored".into();
            }
            Err(e) => {
                ok = false;
                j.errors.push(format!("{} 未确认恢复：{e}", entry.key));
            }
        }
        if let Err(e) = j.persist(root) {
            ok = false;
            j.errors.push(format!("恢复状态落盘失败：{e}"));
        }
    }
    j.state = if ok {
        "rolled_back"
    } else {
        "recovery_required"
    }
    .into();
    if j.persist(root).is_err() {
        ok = false;
    }
    ok
}

pub async fn execute(
    device: &mut dyn Device,
    root: &Path,
    kind: &str,
    edits: Vec<Edit>,
) -> Result<Receipt> {
    let (mut j, before) = prepare(device, root, kind, edits).await?;
    if let Err(e) = apply(device, root, &mut j).await {
        j.errors.push(e.clone());
        let restored = rollback(device, root, &mut j).await;
        return Err(format!(
            "{e}。{}；日志 {}",
            if restored {
                "已恢复全部原始记录"
            } else {
                "存在未确认的恢复，请查看恢复中心"
            },
            j.id
        ));
    }
    // After the durable commit, a failed refresh must not report a failed save.
    let snapshot = match device.snapshot().await {
        Ok(s) => s,
        Err(e) => {
            let mut s = before;
            for entry in &j.records {
                s.raw.insert(
                    entry.key.clone(),
                    crate::model::Record::from_payload(&entry.target)?,
                );
            }
            s.errors.push(format!("保存已核对，额外刷新失败：{e}"));
            s
        }
    };
    Ok(Receipt {
        journal: j,
        snapshot,
    })
}

pub fn undo_edits(j: &Journal) -> Result<Vec<Edit>> {
    if j.state != "completed" || j.kind == "identification" {
        return Err("这项操作不可撤销".into());
    }
    Ok(j.records
        .iter()
        .map(|e| Edit {
            key: e.key.clone(),
            expected: e.target.clone(),
            target: e.original.clone(),
        })
        .collect())
}

pub fn pending(root: &Path) -> Vec<Journal> {
    let mut out = vec![];
    let Ok(paths) = std::fs::read_dir(root.join("journals")) else {
        return out;
    };
    for file in paths.flatten() {
        if file.path().extension().is_none_or(|x| x != "json") {
            continue;
        }
        if let Ok(j) = storage::read::<Journal>(&file.path(), 128 * 1024) {
            if !j.terminal() && validate_journal(root, &j).is_ok() {
                out.push(j);
            }
        }
    }
    out
}

pub fn validate_journal(root: &Path, j: &Journal) -> Result<Snapshot> {
    if j.schema != 1
        || j.identity.effective_generation() != 2
        || j.id.is_empty()
        || !j.id.chars().all(|c| c.is_ascii_digit() || c == '-')
        || j.records.len() > 20
    {
        return Err("日志格式无效".into());
    }
    if j.backup != format!("backups/rust-{}.json", j.id) {
        return Err("日志备份路径无效".into());
    }
    let path = root.join(&j.backup);
    if std::fs::metadata(&path).map_err(|e| e.to_string())?.len() > 128 * 1024 {
        return Err("备份过大".into());
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    if storage::hash(&bytes) != j.backup_sha256 {
        return Err("备份校验失败".into());
    }
    let snapshot: Snapshot = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if snapshot.address != j.address
        || snapshot.identity != j.identity
        || snapshot.support_tier() == SupportTier::ReadOnly
    {
        return Err("备份设备不匹配或处于只读模式".into());
    }
    let mut seen = BTreeSet::new();
    for e in &j.records {
        let orig_norm = normalize_against(
            &e.key,
            normalize_payload_for(&snapshot, &e.key, snapshot.record(&e.key)?),
            &e.original,
        );
        if !seen.insert(&e.key) || orig_norm != e.original {
            return Err("日志原始记录不匹配".into());
        }
        boundary(&snapshot, &e.key, &e.original, &e.target)?;
    }
    Ok(snapshot)
}

pub fn recovery_edits(root: &Path, j: &Journal, current: &Snapshot) -> Result<Vec<Edit>> {
    let backup = validate_journal(root, j)?;
    if current.support_tier() == SupportTier::ReadOnly
        || current.identity != j.identity
        || current.address != j.address
        || current.capabilities.bytes().ok() != backup.capabilities.bytes().ok()
        || current.decoded.get("macro_keys") != backup.decoded.get("macro_keys")
        || current.decoded.get("remap_keys") != backup.decoded.get("remap_keys")
    {
        return Err("当前设备与日志不匹配".into());
    }
    let mut edits = vec![];
    for e in &j.records {
        if !e.attempted || e.state == "restored" {
            continue;
        }
        let now = normalize_against(
            &e.key,
            normalize_payload_for(current, &e.key, current.record(&e.key)?),
            &e.original,
        );
        if now == e.original {
            continue;
        }
        if now != e.target {
            return Err(format!(
                "{} 存在未知外部修改，停止恢复。可将原备份作为草稿导入后比较",
                e.key
            ));
        }
        edits.push(Edit {
            key: e.key.clone(),
            expected: now,
            target: e.original.clone(),
        });
    }
    Ok(edits)
}
