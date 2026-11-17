use crate::Session;
use oplus_core::{
    Result,
    keymap::PadState,
    model::{Change, LABELS, SLOT_ORDER, SupportTier},
    transaction::{self as tx, Device},
};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

/// 8 pure digital XInput button markers `(onboard_key_code, xinput_wbuttons_mask)`
/// avoiding analog triggers `7=LT` and `8=RT` so 7–8 slot pads identify cleanly.
pub const IDENTIFY_MARKERS: [(u8, u16); 8] = [
    (1, 0x1000),  // A
    (2, 0x2000),  // B
    (3, 0x4000),  // X
    (4, 0x8000),  // Y
    (5, 0x0100),  // LB
    (6, 0x0200),  // RB
    (11, 0x0040), // L3 (LS)
    (12, 0x0080), // R3 (RS)
];

#[derive(Debug, Clone, serde::Serialize)]
pub struct Input {
    pub slot: u32,
    pub buttons: u16,
    pub left_trigger: u8,
    pub right_trigger: u8,
    pub lx: i16,
    pub ly: i16,
    pub rx: i16,
    pub ry: i16,
}

#[cfg(windows)]
pub fn inputs() -> Vec<Input> {
    use windows_sys::Win32::UI::Input::XboxController::*;
    let mut out = vec![];
    for slot in 0..4 {
        let mut state: XINPUT_STATE = unsafe { std::mem::zeroed() };
        if unsafe { XInputGetState(slot, &mut state) } == 0 {
            let g = state.Gamepad;
            out.push(Input {
                slot,
                buttons: g.wButtons,
                left_trigger: g.bLeftTrigger,
                right_trigger: g.bRightTrigger,
                lx: g.sThumbLX,
                ly: g.sThumbLY,
                rx: g.sThumbRX,
                ry: g.sThumbRY,
            });
        }
    }
    out
}

#[cfg(not(windows))]
pub fn inputs() -> Vec<Input> {
    vec![]
}

#[cfg(windows)]
pub fn read_pad_slot(preferred: Option<u8>) -> Option<(u32, PadState)> {
    use windows_sys::Win32::UI::Input::XboxController::*;
    let slots: &[u32] = match preferred {
        Some(0) => &[0],
        Some(1) => &[1],
        Some(2) => &[2],
        Some(3) => &[3],
        _ => &[0, 1, 2, 3],
    };
    for &slot in slots {
        let mut state: XINPUT_STATE = unsafe { std::mem::zeroed() };
        if unsafe { XInputGetState(slot, &mut state) } == 0 {
            let g = state.Gamepad;
            return Some((
                slot,
                PadState {
                    buttons: g.wButtons,
                    left_trigger: g.bLeftTrigger,
                    right_trigger: g.bRightTrigger,
                    lx: g.sThumbLX,
                    ly: g.sThumbLY,
                    rx: g.sThumbRX,
                    ry: g.sThumbRY,
                },
            ));
        }
    }
    None
}

#[cfg(not(windows))]
pub fn read_pad_slot(_preferred: Option<u8>) -> Option<(u32, PadState)> {
    None
}

pub async fn identify(
    session: &mut Session,
    root: &Path,
    cancel: Arc<AtomicBool>,
    status: impl Fn(String) + Send,
) -> Result<BTreeMap<u8, String>> {
    let pads = inputs();
    if pads.len() != 1 {
        return Err("识别时请只连接一只 XInput 手柄；也可以直接使用型号默认预设".into());
    }
    let input_slot = pads[0].slot;
    let before = session.snapshot().await?;
    if before.support_tier() == SupportTier::ReadOnly {
        return Err("当前设备处于只读模式，不支持写入识别标记".into());
    }
    let active_slots = before.active_slots();
    if active_slots.is_empty() || active_slots.len() > 8 {
        return Err("当前手柄没有可识别的实体背键槽位".into());
    }
    if before.raw.contains_key("remapping")
        && before.record("remapping")?.iter().skip(1).any(|v| *v != 0)
    {
        return Err("标准按键存在自定义映射，请先还原或使用型号默认预设".into());
    }

    let prompt_names: Vec<&str> =
        if before.identity.vid == "1005" && active_slots.as_slice() == [0, 1, 2, 3, 4, 5] {
            LABELS.to_vec()
        } else {
            active_slots
                .iter()
                .map(|&s| SLOT_ORDER[s as usize])
                .collect()
        };

    let mut edits = Vec::with_capacity(active_slots.len());
    let mut slot_markers: Vec<(u8, u16)> = Vec::with_capacity(active_slots.len());
    for (idx, &slot) in active_slots.iter().enumerate() {
        let (key_code, xinput_mask) = IDENTIFY_MARKERS[idx];
        slot_markers.push((slot, xinput_mask));
        edits.push(tx::Edit {
            key: format!("macro_{slot}"),
            expected: before.record(&format!("macro_{slot}"))?,
            target: Change::Hold {
                keys: vec![key_code],
            }
            .encode_for_slot(&before, slot)?,
        });
    }

    let total = active_slots.len();
    let (mut journal, _) = tx::prepare(session, root, "identification", edits).await?;
    let result = async {
        status("正在设置临时标记，请松开所有按键".into());
        tx::apply(session, root, &mut journal).await?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
        let mut labels = BTreeMap::new();
        let mut neutral = false;
        let mut held: Option<(u8, tokio::time::Instant)> = None;
        status(format!("请按实体 {} 一次并松开", prompt_names[0]));
        while tokio::time::Instant::now() < deadline
            && labels.len() < total
            && !cancel.load(Ordering::Relaxed)
        {
            let pads = inputs();
            if pads.len() != 1 || pads[0].slot != input_slot {
                return Err("手柄连接发生变化，正在恢复".into());
            }
            let pad = &pads[0];
            if pad.buttons == 0 && pad.left_trigger < 30 && pad.right_trigger < 30 {
                if let Some((slot, start)) = held.take() {
                    if start.elapsed() >= Duration::from_millis(40) && !labels.contains_key(&slot) {
                        labels.insert(slot, prompt_names[labels.len()].to_string());
                        if labels.len() < total {
                            status(format!(
                                "已识别 {}/{}，请按实体 {} 一次并松开",
                                labels.len(),
                                total,
                                prompt_names[labels.len()]
                            ));
                        }
                    }
                }
                neutral = true;
            } else if neutral && held.is_none() && pad.left_trigger < 30 && pad.right_trigger < 30 {
                if let Some(&(slot, _)) = slot_markers.iter().find(|(_, m)| *m == pad.buttons) {
                    held = Some((slot, tokio::time::Instant::now()));
                }
                neutral = false;
            } else if !slot_markers.iter().any(|(_, m)| *m == pad.buttons) {
                held = None;
                neutral = false;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        if labels.len() != total {
            return Err("识别已取消或超时".into());
        }
        Ok(labels)
    }
    .await;
    status("正在恢复原始背键配置，请等待完成".into());
    if !tx::rollback(session, root, &mut journal).await {
        return Err("部分配置未确认恢复，请查看恢复中心".into());
    }
    result
}
