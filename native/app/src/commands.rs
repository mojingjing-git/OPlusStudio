use oplus_core::{
    Result,
    keymap::{self, KeymapStore, PadButton},
    model::{self, Change, Snapshot, SupportTier},
    storage,
    transaction::{self as tx, Device, Edit, Journal},
};
use oplus_device::{Lease, MacroRunner, RunnerSnapshot, Session};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::Emitter;

pub struct Inner {
    pub busy: AtomicBool,
    pub cancel: Arc<AtomicBool>,
    pub close_requested: AtomicBool,
    pub macro_runner: MacroRunner,
    gate: Arc<tokio::sync::Mutex<()>>,
    snapshot: Mutex<Option<Snapshot>>,
    undo: Mutex<Option<Journal>>,
}

#[derive(Clone)]
pub struct State(pub Arc<Inner>);

impl Default for State {
    fn default() -> Self {
        let root = storage::data_dir();
        Self(Arc::new(Inner {
            busy: AtomicBool::new(false),
            cancel: Arc::new(AtomicBool::new(false)),
            close_requested: AtomicBool::new(false),
            macro_runner: MacroRunner::new(root),
            gate: Arc::new(tokio::sync::Mutex::new(())),
            snapshot: Mutex::new(None),
            undo: Mutex::new(None),
        }))
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum Request {
    Scan,
    Read {
        address: String,
    },
    Save {
        changes: BTreeMap<String, Change>,
        settings: Vec<Setting>,
    },
    Undo,
    Preview {
        slot: u8,
        change: Change,
    },
    Import,
    Export {
        changes: BTreeMap<String, Change>,
    },
    Backup,
    Diagnostic,
    Labels {
        labels: BTreeMap<String, String>,
    },
    Identify,
    RecoveryPreview {
        id: String,
    },
    Recover {
        id: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "feature", rename_all = "snake_case")]
pub enum Setting {
    StickCurve {
        side: u8,
        inner: u8,
        outer_raw: u8,
        point1: [u8; 2],
        point2: [u8; 2],
        invert_x: bool,
        invert_y: bool,
        swap: bool,
    },
    TriggerCurve {
        side: u8,
        inner: u8,
        outer_raw: u8,
        point1: [u8; 2],
        point2: [u8; 2],
    },
    Motors { levels: [u8; 4] },
    MotorChannel { channel: u8, level: u8 },
    Remapping { source: u8, target: u8 },
    Lighting { zone: u8, rgb: String },
}

fn baseline(state: &State) -> Result<Snapshot> {
    state
        .0
        .snapshot
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("请先连接并读取配置".into())
}

fn parse_slot_index(text: &str) -> Result<u8> {
    let n = text.parse::<u8>().map_err(|_| "无效槽位")?;
    if n >= 8 || n.to_string() != text {
        return Err("无效槽位".into());
    }
    Ok(n)
}

fn slot_for_snapshot(text: &str, s: &Snapshot) -> Result<u8> {
    let n = parse_slot_index(text)?;
    if !s.active_slots().contains(&n) {
        return Err("该背键槽位在当前手柄上未启用".into());
    }
    Ok(n)
}

fn labels(snapshot: &Snapshot) -> BTreeMap<u8, String> {
    let root = storage::data_dir();
    let active = snapshot.active_slots();
    let mut preset = snapshot.preset();
    if let Ok(v) = storage::read::<Value>(&storage::label_path(&root, &snapshot.address), 8192) {
        if v["address"] == snapshot.address {
            if let Ok(saved) = serde_json::from_value::<BTreeMap<u8, String>>(v["labels"].clone()) {
                let valid: BTreeMap<_, _> = saved
                    .into_iter()
                    .filter(|(k, v)| active.contains(k) && v.chars().count() <= 20)
                    .collect();
                preset.retain(|k, v| !valid.contains_key(k) && !valid.values().any(|x| x == v));
                preset.extend(valid);
            }
        }
    }
    preset
}

fn save_labels(s: &Snapshot, labels: &BTreeMap<u8, String>) -> Result<()> {
    if s.support_tier() == SupportTier::ReadOnly {
        return Err("只读诊断模式下不支持编辑背键名称".into());
    }
    let active = s.active_slots();
    let mut seen = std::collections::BTreeSet::new();
    for (i, label) in labels {
        if !active.contains(i)
            || label.trim().is_empty()
            || label.chars().count() > 20
            || !seen.insert(label.trim())
        {
            return Err("背键名称应为 1–20 字且不重复".into());
        }
    }
    storage::save(
        &storage::label_path(&storage::data_dir(), &s.address),
        &json!({"address": s.address, "labels": labels}),
    )
}

fn view(snapshot: &Snapshot) -> Result<Value> {
    let tier = snapshot.support_tier();
    let caps = snapshot.parsed_capabilities().ok();
    let active_slots = if tier != SupportTier::ReadOnly {
        snapshot.active_slots()
    } else {
        vec![]
    };
    let mut forms = BTreeMap::new();
    let mut programs = BTreeMap::new();
    let mut slot_limits = BTreeMap::new();
    if tier != SupportTier::ReadOnly && !active_slots.is_empty() {
        let layout = snapshot.layout()?;
        for &i in &active_slots {
            forms.insert(i, model::form(snapshot, i)?);
            programs.insert(
                i,
                model::Program::parse(&snapshot.record(&format!("macro_{i}"))?, &layout)?,
            );
            slot_limits.insert(i, snapshot.slot_step_limit(i));
        }
    }
    Ok(json!({
        "snapshot": snapshot,
        "support_tier": tier,
        "capabilities_info": caps.map(|c| json!({
            "sticks": c.sticks,
            "stick_sides": c.stick_sides(),
            "triggers": c.triggers,
            "trigger_sides": c.trigger_sides(),
            "motors": c.motors,
            "motor_channels": c.motor_channels(),
            "macros": c.macros,
            "active_slots": c.active_slots(),
            "changekey": c.changekey,
            "has_remap_select_list": c.has_remap_select_list(),
            "lighting": c.lighting,
            "lighting_zones": c.lighting_zones(),
            "has_per_slot_macro_limits": c.has_per_slot_macro_limits(),
        })),
        "active_slots": active_slots,
        "slot_limits": slot_limits,
        "forms": forms,
        "programs": programs,
        "labels": labels(snapshot),
        "recoveries": tx::pending(&storage::data_dir()),
    }))
}

fn install(state: &State, snapshot: Snapshot) -> Result<Value> {
    let v = view(&snapshot)?;
    *state.0.snapshot.lock().map_err(|e| e.to_string())? = Some(snapshot);
    Ok(v)
}

fn status(app: &tauri::AppHandle, text: &str) {
    let _ = app.emit("status", text);
}

#[tauri::command]
pub fn initial(state: tauri::State<'_, State>) -> Value {
    let root = storage::data_dir();
    let address = storage::read::<Value>(&root.join("device.json"), 4096)
        .ok()
        .and_then(|v| v["address"].as_str().map(String::from))
        .unwrap_or_default();
    json!({
        "address": address,
        "recoveries": tx::pending(&root),
        "version": "0.7.0",
        "keymap": state.0.macro_runner.store(),
        "runner": state.0.macro_runner.snapshot(),
    })
}

#[tauri::command]
pub fn inputs() -> Vec<oplus_device::Input> {
    oplus_device::inputs()
}

#[tauri::command]
pub fn runner_state(state: tauri::State<'_, State>) -> RunnerSnapshot {
    state.0.macro_runner.snapshot()
}

#[tauri::command]
pub fn keymap_set_enabled(state: tauri::State<'_, State>, enabled: bool) -> Result<RunnerSnapshot> {
    state.0.macro_runner.set_enabled(enabled)
}

#[tauri::command]
pub fn keymap_dismiss_warning(state: tauri::State<'_, State>) -> RunnerSnapshot {
    state.0.macro_runner.dismiss_warning()
}

#[tauri::command]
pub fn keymap_set_recording(state: tauri::State<'_, State>, recording: bool) -> RunnerSnapshot {
    state.0.macro_runner.set_recording_pause(recording)
}

#[tauri::command]
pub fn keymap_save_store(state: tauri::State<'_, State>, store: KeymapStore) -> Result<Value> {
    let (saved, runner) = state.0.macro_runner.update_store(store)?;
    Ok(json!({ "keymap": saved, "runner": runner }))
}

#[tauri::command]
pub fn keymap_sync_bridge(
    state: tauri::State<'_, State>,
    slot: u8,
    trigger: Vec<PadButton>,
) -> Result<Change> {
    let s = baseline(state.inner())?;
    keymap::bridge_hold_change(slot, &trigger, &s)
}

#[tauri::command]
pub async fn keymap_import(state: tauri::State<'_, State>) -> Result<Value> {
    let path = rfd::AsyncFileDialog::new()
        .add_filter("键盘宏方案 / 旧版 0.4.0 配置", &["json"])
        .pick_file()
        .await
        .ok_or("已取消导入")?;
    let meta = std::fs::metadata(path.path()).map_err(|e| e.to_string())?;
    if meta.len() > 256 * 1024 {
        return Err("键盘宏配置文件超过 256 KiB".into());
    }
    let data = std::fs::read(path.path()).map_err(|e| e.to_string())?;
    let imported = keymap::import_keymap_profile(&data)?;
    let imported_name = imported.name.clone();
    let imported_id = imported.id.clone();

    let mut store = state.0.macro_runner.store();
    if store.profiles.len() >= 32 {
        return Err("方案数量已达上限（32 个），请先删除不用的方案".into());
    }
    store.profiles.push(imported);
    store.active_profile_id = imported_id;
    let (saved, runner) = state.0.macro_runner.update_store(store)?;
    Ok(json!({
        "keymap": saved,
        "runner": runner,
        "message": format!("已导入电脑端键盘宏方案“{imported_name}”"),
    }))
}

#[tauri::command]
pub async fn keymap_export(state: tauri::State<'_, State>, profile_id: String) -> Result<Value> {
    let store = state.0.macro_runner.store();
    let profile = store
        .profiles
        .iter()
        .find(|p| p.id == profile_id)
        .or_else(|| store.active_profile())
        .ok_or("未找到要导出的方案")?;
    let exported = keymap::export_keymap_profile(profile)?;
    let default_name = format!("OPlus-keymap-{}.json", profile.name.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_"));
    let path = rfd::AsyncFileDialog::new()
        .set_file_name(&default_name)
        .add_filter("JSON", &["json"])
        .save_file()
        .await
        .ok_or("已取消导出")?;
    storage::save(path.path(), &exported)?;
    Ok(json!({ "message": format!("已导出方案“{}”", profile.name) }))
}

#[tauri::command]
pub async fn export_diagnostic(state: tauri::State<'_, State>) -> Result<Value> {
    let s = baseline(state.inner())?;
    let bundle = model::diagnostic_bundle(&s);
    let path = rfd::AsyncFileDialog::new()
        .set_file_name("OPlus-diagnostic-bundle.json")
        .add_filter("JSON", &["json"])
        .save_file()
        .await
        .ok_or("已取消导出诊断包")?;
    storage::save(path.path(), &bundle)?;
    Ok(json!({ "message": "已导出设备兼容诊断包" }))
}

#[tauri::command]
pub fn preview(state: tauri::State<'_, State>, slot: u8, change: Change) -> Result<Value> {
    let s = baseline(state.inner())?;
    let p = change.encode_for_slot(&s, slot)?;
    Ok(json!({
        "payload": model::hex_spaced(&p),
        "program": model::Program::parse(&p, &s.layout()?)?,
    }))
}

#[tauri::command]
pub fn cancel(state: tauri::State<'_, State>) {
    state.0.cancel.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub async fn run(
    app: tauri::AppHandle,
    state: tauri::State<'_, State>,
    request: Request,
) -> Result<Value> {
    let state = state.inner().clone();
    let guard = state
        .0
        .gate
        .clone()
        .try_lock_owned()
        .map_err(|_| "另一项操作正在进行，请等待完成".to_string())?;
    state.0.busy.store(true, Ordering::SeqCst);
    state.0.cancel.store(false, Ordering::SeqCst);
    // The task owns the operation. Dropping an IPC promise cannot abandon writes.
    tauri::async_runtime::spawn(async move {
        let result = dispatch(&app, &state, request).await;
        state.0.busy.store(false, Ordering::SeqCst);
        drop(guard);
        if state.0.close_requested.load(Ordering::SeqCst) {
            app.exit(0);
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn dispatch(app: &tauri::AppHandle, state: &State, request: Request) -> Result<Value> {
    let root = storage::data_dir();
    match request {
        Request::Preview { slot, change } => {
            let s = baseline(state)?;
            let p = change.encode_for_slot(&s, slot)?;
            Ok(json!({
                "payload": model::hex_spaced(&p),
                "program": model::Program::parse(&p, &s.layout()?)?,
            }))
        }
        Request::Labels { labels: l } => {
            let s = baseline(state)?;
            let l: BTreeMap<u8, String> = l
                .into_iter()
                .map(|(k, v)| Ok((slot_for_snapshot(&k, &s)?, v)))
                .collect::<Result<_>>()?;
            save_labels(&s, &l)?;
            view(&s)
        }
        Request::Import => {
            let s = baseline(state)?;
            let path = rfd::AsyncFileDialog::new()
                .add_filter("O+ 背键配置 / 备份", &["json"])
                .pick_file()
                .await
                .ok_or("已取消导入")?;
            if std::fs::metadata(path.path())
                .map_err(|e| e.to_string())?
                .len()
                > 65536
            {
                return Err("配置文件超过 64 KiB".into());
            }
            let data = std::fs::read(path.path()).map_err(|e| e.to_string())?;
            let changes = model::import_profile(&data, &s)?;
            Ok(json!({"changes": changes}))
        }
        Request::Export { changes } => {
            let mut s = baseline(state)?;
            for (slot_text, c) in changes {
                let slot = slot_for_snapshot(&slot_text, &s)?;
                let p = c.encode_for_slot(&s, slot)?;
                s.raw
                    .insert(format!("macro_{slot}"), model::Record::from_payload(&p)?);
            }
            let profile = model::profile(&s, &labels(&s))?;
            let path = rfd::AsyncFileDialog::new()
                .set_file_name("OPlus-rear-profile.json")
                .add_filter("JSON", &["json"])
                .save_file()
                .await
                .ok_or("已取消导出")?;
            storage::save(path.path(), &profile)?;
            Ok(json!({"message": "背键配置已导出（含当前草稿）"}))
        }
        Request::Backup => {
            let s = baseline(state)?;
            let path = rfd::AsyncFileDialog::new()
                .set_file_name("OPlus-board-backup.json")
                .add_filter("JSON", &["json"])
                .save_file()
                .await
                .ok_or("已取消备份")?;
            storage::save(path.path(), &s)?;
            Ok(json!({"message": "已导出最近读取的完整快照"}))
        }
        Request::Diagnostic => {
            let s = baseline(state)?;
            let bundle = model::diagnostic_bundle(&s);
            let path = rfd::AsyncFileDialog::new()
                .set_file_name("OPlus-diagnostic-bundle.json")
                .add_filter("JSON", &["json"])
                .save_file()
                .await
                .ok_or("已取消导出诊断包")?;
            storage::save(path.path(), &bundle)?;
            Ok(json!({"message": "已导出设备兼容诊断包"}))
        }
        Request::Scan => {
            let _ble_pause = state.0.macro_runner.pause_for_ble();
            let _lease = Lease::acquire(&root)?;
            status(app, "正在查找附近手柄…");
            Ok(json!({"devices": oplus_device::scan().await?}))
        }
        other => {
            let _ble_pause = state.0.macro_runner.pause_for_ble();
            let _lease = Lease::acquire(&root)?;
            let address = match &other {
                Request::Read { address } => address.clone(),
                _ => baseline(state)?.address,
            };
            if matches!(
                &other,
                Request::Save { .. } | Request::Undo | Request::Identify
            ) && tx::pending(&root).iter().any(|j| j.address == address)
            {
                return Err("此设备存在未完成操作，请先在恢复中心检查并恢复".into());
            }
            status(app, "正在连接手柄配置通道…");
            let mut device = Session::connect(&address).await?;
            let result = async {
                match other {
                    Request::Read { .. } => {
                        status(app, "正在读取手柄能力描述符与板载配置…");
                        let s = device.snapshot().await?;
                        if state
                            .0
                            .undo
                            .lock()
                            .unwrap()
                            .as_ref()
                            .is_some_and(|j| j.address != s.address)
                        {
                            *state.0.undo.lock().unwrap() = None;
                        }
                        storage::save(&root.join("device.json"), &json!({"address": s.address}))?;
                        install(state, s)
                    }
                    Request::Save { changes, settings } => {
                        let s = baseline(state)?;
                        if s.support_tier() == SupportTier::ReadOnly {
                            return Err("当前设备处于只读模式，禁止保存到手柄".into());
                        }
                        let mut edits = vec![];
                        for (slot_text, c) in changes {
                            let slot = slot_for_snapshot(&slot_text, &s)?;
                            let key = format!("macro_{slot}");
                            edits.push(Edit {
                                expected: s.record(&key)?,
                                target: c.encode_for_slot(&s, slot)?,
                                key,
                            });
                        }
                        let mut setting_targets: BTreeMap<String, Vec<u8>> = BTreeMap::new();
                        let mut staged = s.clone();
                        for setting in settings {
                            let (key, change) = match setting {
                                Setting::StickCurve {
                                    side,
                                    inner,
                                    outer_raw,
                                    point1,
                                    point2,
                                    invert_x,
                                    invert_y,
                                    swap,
                                } => (
                                    "sticks",
                                    json!({
                                        "side": side,
                                        "inner": inner,
                                        "outer_raw": outer_raw,
                                        "point1": point1,
                                        "point2": point2,
                                        "invert_x": invert_x,
                                        "invert_y": invert_y,
                                        "swap": swap,
                                    }),
                                ),
                                Setting::TriggerCurve {
                                    side,
                                    inner,
                                    outer_raw,
                                    point1,
                                    point2,
                                } => (
                                    "triggers",
                                    json!({
                                        "side": side,
                                        "inner": inner,
                                        "outer_raw": outer_raw,
                                        "point1": point1,
                                        "point2": point2,
                                    }),
                                ),
                                Setting::Motors { levels } => ("motors", json!({"levels": levels})),
                                Setting::MotorChannel { channel, level } => {
                                    ("motors", json!({"channel": channel, "level": level}))
                                }
                                Setting::Remapping { source, target } => (
                                    "remapping",
                                    json!({"source": source, "target": target}),
                                ),
                                Setting::Lighting { zone, rgb } => {
                                    ("lighting", json!({"zone": zone, "rgb": rgb}))
                                }
                            };
                            let p = model::desired_setting(&staged, key, &change)?;
                            staged
                                .raw
                                .insert(key.into(), model::Record::from_payload(&p)?);
                            setting_targets.insert(key.into(), p);
                        }
                        for (key, target) in setting_targets {
                            edits.push(Edit {
                                expected: s.record(&key)?,
                                key,
                                target,
                            });
                        }
                        status(app, "正在检查冲突、备份并保存；请等待核对完成…");
                        let receipt = tx::execute(&mut device, &root, "save", edits).await?;
                        *state.0.undo.lock().unwrap() = Some(receipt.journal);
                        install(state, receipt.snapshot)
                    }
                    Request::Undo => {
                        let j = state
                            .0
                            .undo
                            .lock()
                            .unwrap()
                            .clone()
                            .ok_or("没有可撤销的保存")?;
                        if j.address != address {
                            return Err("可撤销操作属于另一只手柄，请重新连接原设备".into());
                        }
                        status(app, "正在撤销并回读核对…");
                        let receipt =
                            tx::execute(&mut device, &root, "undo", tx::undo_edits(&j)?).await?;
                        *state.0.undo.lock().unwrap() = None;
                        install(state, receipt.snapshot)
                    }
                    Request::Identify => {
                        let l = oplus_device::identify(
                            &mut device,
                            &root,
                            state.0.cancel.clone(),
                            |s| status(app, &s),
                        )
                        .await?;
                        let s = device.snapshot().await?;
                        save_labels(&s, &l)?;
                        install(state, s)
                    }
                    Request::RecoveryPreview { id } => {
                        let j = tx::pending(&root)
                            .into_iter()
                            .find(|j| j.id == id)
                            .ok_or("未找到可恢复日志")?;
                        let current = device.snapshot().await?;
                        let edits = tx::recovery_edits(&root, &j, &current)?;
                        Ok(json!({"recovery": j, "edits": edits, "current": current}))
                    }
                    Request::Recover { id } => {
                        let mut j = tx::pending(&root)
                            .into_iter()
                            .find(|j| j.id == id)
                            .ok_or("未找到可恢复日志")?;
                        let current = device.snapshot().await?;
                        let edits = tx::recovery_edits(&root, &j, &current)?;
                        let after = if edits.is_empty() {
                            current
                        } else {
                            tx::execute(&mut device, &root, "recovery", edits)
                                .await?
                                .snapshot
                        };
                        for e in &mut j.records {
                            if e.attempted {
                                e.state = "restored".into();
                            }
                        }
                        j.state = "rolled_back".into();
                        j.persist(&root)?;
                        install(state, after)
                    }
                    _ => Err("无效操作".into()),
                }
            }
            .await;
            device.close().await;
            result
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn browser_json_map_keys_deserialize_before_hardware() {
        for text in [
            r#"{"action":"save","changes":{"0":{"kind":"hold","keys":[1]}},"settings":[{"feature":"motor_channel","channel":0,"level":80}]}"#,
            r#"{"action":"save","changes":{},"settings":[{"feature":"stick_curve","side":0,"inner":6,"outer_raw":8,"point1":[85,85],"point2":[170,170],"invert_x":false,"invert_y":true,"swap":false},{"feature":"trigger_curve","side":1,"inner":4,"outer_raw":34,"point1":[35,35],"point2":[136,204]}]}"#,
            r#"{"action":"export","changes":{"7":{"kind":"macro","sequence":"A:100/60","loop_ms":0,"trigger":0}}}"#,
            r#"{"action":"labels","labels":{"0":"M1","1":"M2","6":"ML","7":"MR"}}"#,
            r#"{"action":"diagnostic"}"#,
        ] {
            assert!(serde_json::from_str::<Request>(text).is_ok());
        }
        for text in ["-1", "8", "00", "anything"] {
            assert!(parse_slot_index(text).is_err());
        }
    }
}
