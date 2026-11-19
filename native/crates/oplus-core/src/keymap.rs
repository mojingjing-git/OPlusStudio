//! Pure, deterministic gamepad-to-keyboard/mouse mapping and macro state machine.
//! Contains zero OS / hardware I/O so all timing, chord matching, and ref-counting
//! invariants are 100% unit-testable.

use crate::{
    Result,
    model::{Change, Snapshot, SupportTier},
    storage,
};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub const SUBSET_DEBOUNCE_MS: u64 = 20;
pub const TAP_FLUSH_HOLD_MS: u64 = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum PadButton {
    A,
    B,
    X,
    Y,
    LB,
    RB,
    Back,
    Start,
    LS,
    RS,
    Up,
    Down,
    Left,
    Right,
    LT,
    RT,
    LXNeg,
    LXPos,
    LYNeg,
    LYPos,
    RXNeg,
    RXPos,
    RYNeg,
    RYPos,
}

impl PadButton {
    pub const ALL: [Self; 24] = [
        Self::A,
        Self::B,
        Self::X,
        Self::Y,
        Self::LB,
        Self::RB,
        Self::Back,
        Self::Start,
        Self::LS,
        Self::RS,
        Self::Up,
        Self::Down,
        Self::Left,
        Self::Right,
        Self::LT,
        Self::RT,
        Self::LXNeg,
        Self::LXPos,
        Self::LYNeg,
        Self::LYPos,
        Self::RXNeg,
        Self::RXPos,
        Self::RYNeg,
        Self::RYPos,
    ];

    pub fn from_legacy(name: &str) -> Option<Self> {
        match name.trim() {
            "A" => Some(Self::A),
            "B" => Some(Self::B),
            "X" => Some(Self::X),
            "Y" => Some(Self::Y),
            "LB" => Some(Self::LB),
            "RB" => Some(Self::RB),
            "Back" => Some(Self::Back),
            "Start" => Some(Self::Start),
            "LS" => Some(Self::LS),
            "RS" => Some(Self::RS),
            "Up" => Some(Self::Up),
            "Down" => Some(Self::Down),
            "Left" => Some(Self::Left),
            "Right" => Some(Self::Right),
            "LT" => Some(Self::LT),
            "RT" => Some(Self::RT),
            "LX-" | "LXNeg" => Some(Self::LXNeg),
            "LX+" | "LXPos" => Some(Self::LXPos),
            "LY-" | "LYNeg" => Some(Self::LYNeg),
            "LY+" | "LYPos" => Some(Self::LYPos),
            "RX-" | "RXNeg" => Some(Self::RXNeg),
            "RX+" | "RXPos" => Some(Self::RXPos),
            "RY-" | "RYNeg" => Some(Self::RYNeg),
            "RY+" | "RYPos" => Some(Self::RYPos),
            _ => None,
        }
    }

    pub fn to_onboard_key(self) -> Option<u8> {
        match self {
            Self::A => Some(1),
            Self::B => Some(2),
            Self::X => Some(3),
            Self::Y => Some(4),
            Self::LB => Some(5),
            Self::RB => Some(6),
            Self::LT => Some(7),
            Self::RT => Some(8),
            Self::LS => Some(11),
            Self::RS => Some(12),
            Self::Down => Some(13),
            Self::Up => Some(14),
            Self::Right => Some(15),
            Self::Left => Some(16),
            Self::Back => Some(93),
            Self::Start => Some(94),
            _ => None,
        }
    }

    pub fn from_onboard_key(code: u8) -> Option<Self> {
        match code {
            1 => Some(Self::A),
            2 => Some(Self::B),
            3 => Some(Self::X),
            4 => Some(Self::Y),
            5 => Some(Self::LB),
            6 => Some(Self::RB),
            7 => Some(Self::LT),
            8 => Some(Self::RT),
            11 => Some(Self::LS),
            12 => Some(Self::RS),
            13 => Some(Self::Down),
            14 => Some(Self::Up),
            15 => Some(Self::Right),
            16 => Some(Self::Left),
            93 => Some(Self::Back),
            94 => Some(Self::Start),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PadState {
    pub buttons: u16,
    pub left_trigger: u8,
    pub right_trigger: u8,
    pub lx: i16,
    pub ly: i16,
    pub rx: i16,
    pub ry: i16,
}

impl PadState {
    pub fn active_buttons(&self, trigger_threshold: u8, stick_deadzone: i16) -> BTreeSet<PadButton> {
        let mut set = BTreeSet::new();
        let digital = [
            (0x1000, PadButton::A),
            (0x2000, PadButton::B),
            (0x4000, PadButton::X),
            (0x8000, PadButton::Y),
            (0x0100, PadButton::LB),
            (0x0200, PadButton::RB),
            (0x0020, PadButton::Back),
            (0x0010, PadButton::Start),
            (0x0040, PadButton::LS),
            (0x0080, PadButton::RS),
            (0x0001, PadButton::Up),
            (0x0002, PadButton::Down),
            (0x0004, PadButton::Left),
            (0x0008, PadButton::Right),
        ];
        for (mask, btn) in digital {
            if (self.buttons & mask) != 0 {
                set.insert(btn);
            }
        }
        if self.left_trigger > trigger_threshold {
            set.insert(PadButton::LT);
        }
        if self.right_trigger > trigger_threshold {
            set.insert(PadButton::RT);
        }
        let dz = (stick_deadzone as i32).clamp(1000, 32000);
        if (self.lx as i32) < -dz {
            set.insert(PadButton::LXNeg);
        }
        if (self.lx as i32) > dz {
            set.insert(PadButton::LXPos);
        }
        if (self.ly as i32) < -dz {
            set.insert(PadButton::LYNeg);
        }
        if (self.ly as i32) > dz {
            set.insert(PadButton::LYPos);
        }
        if (self.rx as i32) < -dz {
            set.insert(PadButton::RXNeg);
        }
        if (self.rx as i32) > dz {
            set.insert(PadButton::RXPos);
        }
        if (self.ry as i32) < -dz {
            set.insert(PadButton::RYNeg);
        }
        if (self.ry as i32) > dz {
            set.insert(PadButton::RYPos);
        }
        set
    }
}

/// Output keyboard and mouse tokens.
/// NOTE: `F8` is deliberately absent at compile time and rejected during parsing,
/// preserving `F8` exclusively for the global emergency stop hotkey.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum OutputToken {
    // Letters
    A,
    B,
    C,
    D,
    E,
    F,
    G,
    H,
    I,
    J,
    K,
    L,
    M,
    N,
    O,
    P,
    Q,
    R,
    S,
    T,
    U,
    V,
    W,
    X,
    Y,
    Z,
    // Top-row digits
    Key0,
    Key1,
    Key2,
    Key3,
    Key4,
    Key5,
    Key6,
    Key7,
    Key8,
    Key9,
    // Function keys (F8 excluded!)
    F1,
    F2,
    F3,
    F4,
    F5,
    F6,
    F7,
    F9,
    F10,
    F11,
    F12,
    // Modifiers
    LShift,
    RShift,
    LCtrl,
    RCtrl,
    LAlt,
    RAlt,
    LWin,
    RWin,
    // Editing & Navigation
    Space,
    Enter,
    Escape,
    Tab,
    Backspace,
    CapsLock,
    Insert,
    Delete,
    Home,
    End,
    PageUp,
    PageDown,
    Up,
    Down,
    Left,
    Right,
    // Symbols
    Grave,
    Minus,
    Equals,
    LeftBracket,
    RightBracket,
    Backslash,
    Semicolon,
    Apostrophe,
    Comma,
    Period,
    Slash,
    // Numpad
    Num0,
    Num1,
    Num2,
    Num3,
    Num4,
    Num5,
    Num6,
    Num7,
    Num8,
    Num9,
    NumMultiply,
    NumAdd,
    NumSubtract,
    NumDecimal,
    NumDivide,
    NumEnter,
    // Mouse
    MouseLeft,
    MouseRight,
    MouseMiddle,
    MouseX1,
    MouseX2,
    WheelUp,
    WheelDown,
}

impl OutputToken {
    pub const ALL: [Self; 105] = [
        Self::A,
        Self::B,
        Self::C,
        Self::D,
        Self::E,
        Self::F,
        Self::G,
        Self::H,
        Self::I,
        Self::J,
        Self::K,
        Self::L,
        Self::M,
        Self::N,
        Self::O,
        Self::P,
        Self::Q,
        Self::R,
        Self::S,
        Self::T,
        Self::U,
        Self::V,
        Self::W,
        Self::X,
        Self::Y,
        Self::Z,
        Self::Key0,
        Self::Key1,
        Self::Key2,
        Self::Key3,
        Self::Key4,
        Self::Key5,
        Self::Key6,
        Self::Key7,
        Self::Key8,
        Self::Key9,
        Self::F1,
        Self::F2,
        Self::F3,
        Self::F4,
        Self::F5,
        Self::F6,
        Self::F7,
        Self::F9,
        Self::F10,
        Self::F11,
        Self::F12,
        Self::LShift,
        Self::RShift,
        Self::LCtrl,
        Self::RCtrl,
        Self::LAlt,
        Self::RAlt,
        Self::LWin,
        Self::RWin,
        Self::Space,
        Self::Enter,
        Self::Escape,
        Self::Tab,
        Self::Backspace,
        Self::CapsLock,
        Self::Insert,
        Self::Delete,
        Self::Home,
        Self::End,
        Self::PageUp,
        Self::PageDown,
        Self::Up,
        Self::Down,
        Self::Left,
        Self::Right,
        Self::Grave,
        Self::Minus,
        Self::Equals,
        Self::LeftBracket,
        Self::RightBracket,
        Self::Backslash,
        Self::Semicolon,
        Self::Apostrophe,
        Self::Comma,
        Self::Period,
        Self::Slash,
        Self::Num0,
        Self::Num1,
        Self::Num2,
        Self::Num3,
        Self::Num4,
        Self::Num5,
        Self::Num6,
        Self::Num7,
        Self::Num8,
        Self::Num9,
        Self::NumMultiply,
        Self::NumAdd,
        Self::NumSubtract,
        Self::NumDecimal,
        Self::NumDivide,
        Self::NumEnter,
        Self::MouseLeft,
        Self::MouseRight,
        Self::MouseMiddle,
        Self::MouseX1,
        Self::MouseX2,
        Self::WheelUp,
        Self::WheelDown,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::A => "A",
            Self::B => "B",
            Self::C => "C",
            Self::D => "D",
            Self::E => "E",
            Self::F => "F",
            Self::G => "G",
            Self::H => "H",
            Self::I => "I",
            Self::J => "J",
            Self::K => "K",
            Self::L => "L",
            Self::M => "M",
            Self::N => "N",
            Self::O => "O",
            Self::P => "P",
            Self::Q => "Q",
            Self::R => "R",
            Self::S => "S",
            Self::T => "T",
            Self::U => "U",
            Self::V => "V",
            Self::W => "W",
            Self::X => "X",
            Self::Y => "Y",
            Self::Z => "Z",
            Self::Key0 => "Key0",
            Self::Key1 => "Key1",
            Self::Key2 => "Key2",
            Self::Key3 => "Key3",
            Self::Key4 => "Key4",
            Self::Key5 => "Key5",
            Self::Key6 => "Key6",
            Self::Key7 => "Key7",
            Self::Key8 => "Key8",
            Self::Key9 => "Key9",
            Self::F1 => "F1",
            Self::F2 => "F2",
            Self::F3 => "F3",
            Self::F4 => "F4",
            Self::F5 => "F5",
            Self::F6 => "F6",
            Self::F7 => "F7",
            Self::F9 => "F9",
            Self::F10 => "F10",
            Self::F11 => "F11",
            Self::F12 => "F12",
            Self::LShift => "LShift",
            Self::RShift => "RShift",
            Self::LCtrl => "LCtrl",
            Self::RCtrl => "RCtrl",
            Self::LAlt => "LAlt",
            Self::RAlt => "RAlt",
            Self::LWin => "LWin",
            Self::RWin => "RWin",
            Self::Space => "Space",
            Self::Enter => "Enter",
            Self::Escape => "Escape",
            Self::Tab => "Tab",
            Self::Backspace => "Backspace",
            Self::CapsLock => "CapsLock",
            Self::Insert => "Insert",
            Self::Delete => "Delete",
            Self::Home => "Home",
            Self::End => "End",
            Self::PageUp => "PageUp",
            Self::PageDown => "PageDown",
            Self::Up => "Up",
            Self::Down => "Down",
            Self::Left => "Left",
            Self::Right => "Right",
            Self::Grave => "Grave",
            Self::Minus => "Minus",
            Self::Equals => "Equals",
            Self::LeftBracket => "LeftBracket",
            Self::RightBracket => "RightBracket",
            Self::Backslash => "Backslash",
            Self::Semicolon => "Semicolon",
            Self::Apostrophe => "Apostrophe",
            Self::Comma => "Comma",
            Self::Period => "Period",
            Self::Slash => "Slash",
            Self::Num0 => "Num0",
            Self::Num1 => "Num1",
            Self::Num2 => "Num2",
            Self::Num3 => "Num3",
            Self::Num4 => "Num4",
            Self::Num5 => "Num5",
            Self::Num6 => "Num6",
            Self::Num7 => "Num7",
            Self::Num8 => "Num8",
            Self::Num9 => "Num9",
            Self::NumMultiply => "NumMultiply",
            Self::NumAdd => "NumAdd",
            Self::NumSubtract => "NumSubtract",
            Self::NumDecimal => "NumDecimal",
            Self::NumDivide => "NumDivide",
            Self::NumEnter => "NumEnter",
            Self::MouseLeft => "MouseLeft",
            Self::MouseRight => "MouseRight",
            Self::MouseMiddle => "MouseMiddle",
            Self::MouseX1 => "MouseX1",
            Self::MouseX2 => "MouseX2",
            Self::WheelUp => "WheelUp",
            Self::WheelDown => "WheelDown",
        }
    }

    pub fn parse_str(raw: &str) -> Result<Self> {
        let s = raw.trim();
        if s.eq_ignore_ascii_case("F8") {
            return Err("F8 为全局紧急停止保留键，禁止作为映射输出".into());
        }
        for tok in Self::ALL {
            if tok.as_str().eq_ignore_ascii_case(s) {
                return Ok(tok);
            }
        }
        // Legacy 0.4.0 aliases
        match s.to_ascii_lowercase().as_str() {
            "0" => Ok(Self::Key0),
            "1" => Ok(Self::Key1),
            "2" => Ok(Self::Key2),
            "3" => Ok(Self::Key3),
            "4" => Ok(Self::Key4),
            "5" => Ok(Self::Key5),
            "6" => Ok(Self::Key6),
            "7" => Ok(Self::Key7),
            "8" => Ok(Self::Key8),
            "9" => Ok(Self::Key9),
            "shift" => Ok(Self::LShift),
            "ctrl" | "control" => Ok(Self::LCtrl),
            "alt" => Ok(Self::LAlt),
            "win" | "meta" | "super" => Ok(Self::LWin),
            _ => Err(format!("不支持的输出键鼠按键：{s}")),
        }
    }

    pub fn is_modifier(self) -> bool {
        matches!(
            self,
            Self::LShift
                | Self::RShift
                | Self::LCtrl
                | Self::RCtrl
                | Self::LAlt
                | Self::RAlt
                | Self::LWin
                | Self::RWin
        )
    }

    pub fn is_wheel(self) -> bool {
        matches!(self, Self::WheelUp | Self::WheelDown)
    }
}

impl Serialize for OutputToken {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for OutputToken {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        Self::parse_str(&s).map_err(serde::de::Error::custom)
    }
}

/// Default 8-slot onboard rear-button chord presets (`Back + LS/RS + ...`).
pub fn bridge_preset(slot: u8) -> Option<(Vec<PadButton>, Vec<u8>)> {
    match slot {
        0 => Some((
            vec![PadButton::Back, PadButton::LS, PadButton::RS],
            vec![93, 11, 12],
        )),
        1 => Some((
            vec![PadButton::Back, PadButton::LS, PadButton::Up],
            vec![93, 11, 14],
        )),
        2 => Some((
            vec![PadButton::Back, PadButton::LS, PadButton::Down],
            vec![93, 11, 13],
        )),
        3 => Some((
            vec![PadButton::Back, PadButton::LS, PadButton::Left],
            vec![93, 11, 16],
        )),
        4 => Some((
            vec![PadButton::Back, PadButton::LS, PadButton::Right],
            vec![93, 11, 15],
        )),
        5 => Some((
            vec![PadButton::Back, PadButton::RS, PadButton::Up],
            vec![93, 12, 14],
        )),
        6 => Some((
            vec![PadButton::Back, PadButton::RS, PadButton::Down],
            vec![93, 12, 13],
        )),
        7 => Some((
            vec![PadButton::Back, PadButton::RS, PadButton::Left],
            vec![93, 12, 16],
        )),
        _ => None,
    }
}

pub fn bridge_hold_change(slot: u8, trigger: &[PadButton], snapshot: &Snapshot) -> Result<Change> {
    if snapshot.support_tier() == SupportTier::ReadOnly {
        return Err("当前手柄为只读模式，无法写入背键暗号".into());
    }
    if !snapshot.active_slots().contains(&slot) {
        return Err("当前手柄不存在该背键槽位".into());
    }
    if trigger.is_empty() || trigger.len() > 4 {
        return Err("背键暗号需包含 1–4 个板载数字按键".into());
    }
    let mut keys = Vec::with_capacity(trigger.len());
    for &b in trigger {
        let code = b
            .to_onboard_key()
            .ok_or("触发组合包含模拟摇杆阈值，无法编码为板载数字按键按住映射")?;
        if !keys.contains(&code) {
            keys.push(code);
        }
    }
    let change = Change::Hold { keys };
    change.encode_for_slot(snapshot, slot)?;
    Ok(change)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BridgeSyncState {
    Unsupported,
    SyncedOnboard,
    SyncedInDraft,
    NeedsSync,
}

pub fn check_bridge_sync(
    slot: u8,
    trigger: &[PadButton],
    snapshot: &Snapshot,
    staged_change: Option<&Change>,
) -> BridgeSyncState {
    let Ok(expected_change) = bridge_hold_change(slot, trigger, snapshot) else {
        return BridgeSyncState::Unsupported;
    };
    let Ok(expected_bytes) = expected_change.encode_for_slot(snapshot, slot) else {
        return BridgeSyncState::Unsupported;
    };
    if let Some(draft) = staged_change {
        if draft.encode_for_slot(snapshot, slot).ok().as_deref() == Some(expected_bytes.as_slice())
        {
            return BridgeSyncState::SyncedInDraft;
        }
        return BridgeSyncState::NeedsSync;
    }
    if snapshot.record(&format!("macro_{slot}")).ok().as_deref() == Some(expected_bytes.as_slice())
    {
        BridgeSyncState::SyncedOnboard
    } else {
        BridgeSyncState::NeedsSync
    }
}

pub fn is_bridge_synced(
    slot: u8,
    trigger: &[PadButton],
    snapshot: &Snapshot,
    staged_change: Option<&Change>,
) -> bool {
    matches!(
        check_bridge_sync(slot, trigger, snapshot, staged_change),
        BridgeSyncState::SyncedOnboard | BridgeSyncState::SyncedInDraft
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KbTriggerMode {
    Once,
    HoldLoop,
    ToggleLoop,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KbStep {
    pub keys: Vec<OutputToken>,
    pub hold_ms: u32,
    #[serde(default)]
    pub gap_ms: u32,
}

impl KbStep {
    pub fn validate(&mut self) -> Result<()> {
        if self.keys.len() > 6 {
            return Err("单步最多同时包含 6 个键鼠按键".into());
        }
        let mut dedup = Vec::with_capacity(self.keys.len());
        for &k in &self.keys {
            if dedup.contains(&k) {
                return Err("单步中包含重复的输出按键".into());
            }
            dedup.push(k);
        }
        if dedup.contains(&OutputToken::WheelUp) && dedup.contains(&OutputToken::WheelDown) {
            return Err("同一宏步骤不能同时向上和向下滚动滚轮".into());
        }
        self.keys = dedup;
        if self.hold_ms > 30_000 || self.gap_ms > 30_000 {
            return Err("按住时间与间隔时间不能超过 30000 ms".into());
        }
        if self.keys.is_empty() {
            // Pure wait step
            if self.hold_ms == 0 && self.gap_ms == 0 {
                return Err("纯等待步骤的时间不能为 0 ms".into());
            }
        } else if self.keys.iter().all(|k| k.is_wheel()) {
            // Pure wheel step: hold_ms == 0 allowed (pulse semantics)
        } else {
            // Normal key/mouse button or mixed wheel + key step: MUST hold >= 1 ms
            if self.hold_ms == 0 {
                return Err("包含键盘或鼠标按键的步骤，按住时间必须为 1–30000 ms".into());
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum KeymapAction {
    Hold {
        keys: Vec<OutputToken>,
    },
    Macro {
        steps: Vec<KbStep>,
        trigger_mode: KbTriggerMode,
        #[serde(default)]
        loop_ms: u32,
    },
}

impl KeymapAction {
    pub fn validate(&mut self) -> Result<()> {
        match self {
            Self::Hold { keys } => {
                if keys.is_empty() || keys.len() > 6 {
                    return Err("按住映射需包含 1–6 个键鼠按键".into());
                }
                let mut dedup = Vec::with_capacity(keys.len());
                for &k in keys.iter() {
                    if dedup.contains(&k) {
                        return Err("按住映射包含重复按键".into());
                    }
                    dedup.push(k);
                }
                if dedup.contains(&OutputToken::WheelUp) && dedup.contains(&OutputToken::WheelDown)
                {
                    return Err("不能同时映射滚轮上滚与下滚".into());
                }
                *keys = dedup;
            }
            Self::Macro {
                steps,
                trigger_mode,
                loop_ms,
            } => {
                if steps.is_empty() || steps.len() > 64 {
                    return Err("键盘顺序宏需包含 1–64 个步骤".into());
                }
                if *loop_ms > 30_000 {
                    return Err("循环间隔不能超过 30000 ms".into());
                }
                let mut total_cycle_ms: u64 = *loop_ms as u64;
                for step in steps.iter_mut() {
                    step.validate()?;
                    total_cycle_ms += step.hold_ms as u64 + step.gap_ms as u64;
                }
                if matches!(trigger_mode, KbTriggerMode::HoldLoop | KbTriggerMode::ToggleLoop)
                    && total_cycle_ms == 0
                {
                    return Err("循环宏单轮总耗时不能为 0 ms（请设置间隔时间）".into());
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeymapRule {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    #[serde(default)]
    pub rear_slot: Option<u8>,
    pub trigger: Vec<PadButton>,
    pub action: KeymapAction,
}

impl KeymapRule {
    pub fn validate(&mut self) -> Result<()> {
        self.id = self.id.trim().to_string();
        if self.id.is_empty() || self.id.len() > 80 {
            self.id = format!("rule-{}", storage::id());
        }
        self.name = self.name.trim().to_string();
        if self.name.is_empty() || self.name.chars().count() > 60 {
            return Err("规则名称应为 1–60 个字符".into());
        }
        if let Some(slot) = self.rear_slot {
            if slot >= 8 {
                return Err("关联背键槽位编号无效".into());
            }
        }
        let mut norm: Vec<PadButton> = self.trigger.clone();
        norm.sort();
        norm.dedup();
        if norm.is_empty() || norm.len() > 4 {
            return Err("触发源需选择 1–4 个手柄输入".into());
        }
        let opposites = [
            (PadButton::Up, PadButton::Down),
            (PadButton::Left, PadButton::Right),
            (PadButton::LXNeg, PadButton::LXPos),
            (PadButton::LYNeg, PadButton::LYPos),
            (PadButton::RXNeg, PadButton::RXPos),
            (PadButton::RYNeg, PadButton::RYPos),
        ];
        for (a, b) in opposites {
            if norm.contains(&a) && norm.contains(&b) {
                return Err("触发组合不能同时包含相反方向输入".into());
            }
        }
        self.trigger = norm;
        self.action.validate()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeymapProfile {
    pub id: String,
    pub name: String,
    pub rules: Vec<KeymapRule>,
}

impl KeymapProfile {
    pub fn validate(&mut self) -> Result<()> {
        self.id = self.id.trim().to_string();
        if self.id.is_empty() || self.id.len() > 80 {
            self.id = format!("profile-{}", storage::id());
        }
        self.name = self.name.trim().to_string();
        if self.name.is_empty() || self.name.chars().count() > 60 {
            return Err("方案名称应为 1–60 个字符".into());
        }
        if self.rules.len() > 64 {
            return Err("单个方案最多包含 64 条规则".into());
        }
        let mut rule_ids = BTreeSet::new();
        let mut active_triggers = BTreeSet::new();
        for rule in &mut self.rules {
            rule.validate()?;
            if !rule_ids.insert(rule.id.clone()) {
                rule.id = format!("rule-{}", storage::id());
                rule_ids.insert(rule.id.clone());
            }
            if rule.enabled && !active_triggers.insert(rule.trigger.clone()) {
                return Err(format!(
                    "方案“{}”中存在多条启用规则使用完全相同的触发组合（{}）",
                    self.name, rule.name
                ));
            }
        }
        Ok(())
    }
}

fn default_trigger_threshold() -> u8 {
    64
}
fn default_stick_deadzone() -> i16 {
    16000
}

/// Persistent desktop keymap configuration store.
/// Note: `enabled` is intentionally NOT persisted on disk so startup always begins disabled.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeymapStore {
    pub schema: u8,
    pub active_profile_id: String,
    #[serde(default)]
    pub controller_slot: Option<u8>,
    #[serde(default = "default_trigger_threshold")]
    pub trigger_threshold: u8,
    #[serde(default = "default_stick_deadzone")]
    pub stick_deadzone: i16,
    pub profiles: Vec<KeymapProfile>,
}

impl KeymapStore {
    pub fn default_store() -> Self {
        Self {
            schema: 1,
            active_profile_id: "default".into(),
            controller_slot: None,
            trigger_threshold: default_trigger_threshold(),
            stick_deadzone: default_stick_deadzone(),
            profiles: vec![KeymapProfile {
                id: "default".into(),
                name: "默认方案".into(),
                rules: vec![],
            }],
        }
    }

    pub fn active_profile(&self) -> Option<&KeymapProfile> {
        self.profiles
            .iter()
            .find(|p| p.id == self.active_profile_id)
            .or_else(|| self.profiles.first())
    }

    pub fn validate(&mut self) -> Result<()> {
        if self.schema != 1 {
            return Err("不支持的键盘宏存储版本".into());
        }
        if let Some(slot) = self.controller_slot {
            if slot >= 4 {
                return Err("XInput 手柄槽位应为 0–3".into());
            }
        }
        if !(10..=240).contains(&self.trigger_threshold) {
            return Err("扳机触发阈值范围应为 10–240".into());
        }
        if !(4000..=30000).contains(&self.stick_deadzone) {
            return Err("摇杆方向触发阈值范围应为 4000–30000".into());
        }
        if self.profiles.is_empty() || self.profiles.len() > 32 {
            return Err("方案数量应为 1–32 个".into());
        }
        let mut ids = BTreeSet::new();
        for p in &mut self.profiles {
            p.validate()?;
            if !ids.insert(p.id.clone()) {
                return Err("存在重复的方案 ID".into());
            }
        }
        if !self.profiles.iter().any(|p| p.id == self.active_profile_id) {
            self.active_profile_id = self.profiles[0].id.clone();
        }
        Ok(())
    }
}

pub const MAX_KEYMAP_BYTES: usize = 8 * 1024 * 1024;

pub fn export_keymap_profile(profile: &KeymapProfile) -> Result<Value> {
    let mut clean = profile.clone();
    clean.validate()?;
    Ok(json!({
        "format": "oplus-keymap-v1",
        "app_version": env!("CARGO_PKG_VERSION"),
        "profile": clean,
    }))
}

/// Imports either a 0.6.0+ `oplus-keymap-v1` / `KeymapProfile` / `KeymapStore` JSON,
/// OR migrates a legacy 0.4.0 `profile.json` (`version: 1, mappings, macros`).
pub fn import_keymap_profile(data: &[u8]) -> Result<KeymapProfile> {
    if data.len() > MAX_KEYMAP_BYTES {
        return Err("键盘宏配置文件超过 8 MiB".into());
    }
    let text = std::str::from_utf8(data)
        .map_err(|_| "配置文件必须为 UTF-8 编码")?
        .trim_start_matches('\u{feff}');
    let v: Value = serde_json::from_str(text).map_err(|e| format!("JSON 解析失败：{e}"))?;

    // 1. Wrapped oplus-keymap-v1
    if v.get("format").and_then(Value::as_str) == Some("oplus-keymap-v1") {
        let mut profile: KeymapProfile = serde_json::from_value(v["profile"].clone())
            .map_err(|e| format!("方案格式无效：{e}"))?;
        profile.id = format!("profile-{}", storage::id());
        profile.validate()?;
        return Ok(profile);
    }

    // 2. Legacy 0.4.0 profile.json (`version == 1` with `mappings` and `macros`)
    if v.get("version").and_then(Value::as_u64) == Some(1)
        && v.get("mappings").is_some()
        && v.get("macros").is_some()
    {
        return import_legacy_04_profile(&v);
    }

    // 3. Full KeymapStore
    if v.get("schema").and_then(Value::as_u64) == Some(1) && v.get("profiles").is_some() {
        let mut store: KeymapStore =
            serde_json::from_value(v).map_err(|e| format!("方案库格式无效：{e}"))?;
        store.validate()?;
        let mut profile = store
            .active_profile()
            .cloned()
            .ok_or("方案库中没有可用方案")?;
        profile.id = format!("profile-{}", storage::id());
        profile.validate()?;
        return Ok(profile);
    }

    // 4. Bare KeymapProfile
    let mut profile: KeymapProfile =
        serde_json::from_value(v).map_err(|e| format!("不支持的键盘宏配置格式：{e}"))?;
    profile.id = format!("profile-{}", storage::id());
    profile.validate()?;
    Ok(profile)
}

fn import_legacy_04_profile(v: &Value) -> Result<KeymapProfile> {
    let name = v
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.chars().count() <= 60)
        .unwrap_or("导入的 0.4.0 方案")
        .to_string();
    let mappings = v["mappings"]
        .as_object()
        .ok_or("0.4.0 配置缺少 mappings 对象")?;
    let macros = v["macros"]
        .as_object()
        .ok_or("0.4.0 配置缺少 macros 对象")?;

    for k in mappings.keys() {
        if macros.contains_key(k) {
            return Err(format!("0.4.0 配置中按键 {k} 同时分配了单键映射与宏"));
        }
    }

    let mut rules = vec![];
    for (btn_str, key_val) in mappings {
        let btn = PadButton::from_legacy(btn_str)
            .ok_or_else(|| format!("0.4.0 配置包含未知手柄输入：{btn_str}"))?;
        let key_str = key_val.as_str().ok_or("0.4.0 映射目标类型无效")?;
        let tok = OutputToken::parse_str(key_str)?;
        rules.push(KeymapRule {
            id: format!("rule-{}", storage::id()),
            name: format!("{btn_str} → {}", tok.as_str()),
            enabled: true,
            rear_slot: None,
            trigger: vec![btn],
            action: KeymapAction::Hold { keys: vec![tok] },
        });
    }

    for (btn_str, steps_val) in macros {
        let btn = PadButton::from_legacy(btn_str)
            .ok_or_else(|| format!("0.4.0 配置包含未知宏触发键：{btn_str}"))?;
        let arr = steps_val
            .as_array()
            .filter(|a| !a.is_empty() && a.len() <= 64)
            .ok_or("0.4.0 宏步骤数量需为 1–64 步")?;
        let mut steps = Vec::with_capacity(arr.len());
        for s in arr {
            let key_str = s
                .get("key")
                .and_then(Value::as_str)
                .ok_or("0.4.0 宏步骤缺少按键")?;
            let tok = OutputToken::parse_str(key_str)?;
            let hold_ms = s
                .get("hold_ms")
                .and_then(Value::as_u64)
                .filter(|&n| (10..=10_000).contains(&n))
                .ok_or("0.4.0 宏按住时间无效")? as u32;
            let gap_ms = s
                .get("after_ms")
                .and_then(Value::as_u64)
                .filter(|&n| n <= 10_000)
                .ok_or("0.4.0 宏间隔时间无效")? as u32;
            steps.push(KbStep {
                keys: vec![tok],
                hold_ms,
                gap_ms,
            });
        }
        rules.push(KeymapRule {
            id: format!("rule-{}", storage::id()),
            name: format!("{btn_str} 顺序宏"),
            enabled: true,
            rear_slot: None,
            trigger: vec![btn],
            action: KeymapAction::Macro {
                steps,
                trigger_mode: KbTriggerMode::Once,
                loop_ms: 0,
            },
        });
    }

    let mut profile = KeymapProfile {
        id: format!("profile-{}", storage::id()),
        name,
        rules,
    };
    profile.validate()?;
    Ok(profile)
}

/// Abstract output target so unit tests never touch OS `SendInput`.
pub trait OutputSink {
    fn send_key(&mut self, token: OutputToken, down: bool) -> bool;
}

/// Semantic per-owner reference counter.
/// - Only emits `Down` when global holder count transitions `0 -> 1`.
/// - Only emits `Up` when global holder count transitions `1 -> 0`.
/// - Wheel tokens emit a single `Down` pulse and are never tracked as held.
/// - Releasing multiple tokens always releases non-modifiers first (in reverse press order)
///   and modifiers (`Shift/Ctrl/Alt/Win`) last!
#[derive(Debug, Default)]
pub struct RefTracker {
    seq_counter: u64,
    holders: BTreeMap<OutputToken, (BTreeSet<u64>, u64)>,
}

impl RefTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_empty(&self) -> bool {
        self.holders.is_empty()
    }

    pub fn held_tokens(&self) -> Vec<OutputToken> {
        self.holders.keys().copied().collect()
    }

    pub fn acquire(&mut self, owner_id: u64, token: OutputToken, sink: &mut dyn OutputSink) {
        if token.is_wheel() {
            sink.send_key(token, true);
            return;
        }
        let is_new = !self.holders.contains_key(&token);
        if is_new {
            self.seq_counter += 1;
            let mut set = BTreeSet::new();
            set.insert(owner_id);
            self.holders.insert(token, (set, self.seq_counter));
            sink.send_key(token, true);
        } else if let Some((set, _)) = self.holders.get_mut(&token) {
            set.insert(owner_id);
        }
    }

    pub fn set_owner_keys(
        &mut self,
        owner_id: u64,
        desired: &[OutputToken],
        sink: &mut dyn OutputSink,
    ) {
        let mut to_release: Vec<(OutputToken, u64)> = vec![];
        self.holders.retain(|&tok, (set, seq)| {
            if set.contains(&owner_id) && !desired.contains(&tok) {
                set.remove(&owner_id);
                if set.is_empty() {
                    to_release.push((tok, *seq));
                    return false;
                }
            }
            true
        });
        Self::emit_ordered_releases(to_release, sink);

        for &tok in desired {
            if tok.is_wheel() {
                sink.send_key(tok, true);
            } else {
                let already_owned = self
                    .holders
                    .get(&tok)
                    .is_some_and(|(set, _)| set.contains(&owner_id));
                if !already_owned {
                    self.acquire(owner_id, tok, sink);
                }
            }
        }
    }

    pub fn release_owner(&mut self, owner_id: u64, sink: &mut dyn OutputSink) {
        let mut to_release: Vec<(OutputToken, u64)> = vec![];
        self.holders.retain(|&tok, (set, seq)| {
            if set.remove(&owner_id) && set.is_empty() {
                to_release.push((tok, *seq));
                return false;
            }
            true
        });
        Self::emit_ordered_releases(to_release, sink);
    }

    pub fn release_all(&mut self, sink: &mut dyn OutputSink) {
        let all: Vec<(OutputToken, u64)> = self
            .holders
            .iter()
            .map(|(&tok, &(_, seq))| (tok, seq))
            .collect();
        self.holders.clear();
        Self::emit_ordered_releases(all, sink);
    }

    fn emit_ordered_releases(mut items: Vec<(OutputToken, u64)>, sink: &mut dyn OutputSink) {
        if items.is_empty() {
            return;
        }
        // Release non-modifiers first (reverse acquisition order), then modifiers last (reverse acquisition order).
        items.sort_by(|(ta, sa), (tb, sb)| {
            ta.is_modifier()
                .cmp(&tb.is_modifier())
                .then_with(|| sb.cmp(sa))
        });
        for (tok, _) in items {
            sink.send_key(tok, false);
        }
    }
}

#[derive(Debug, Clone)]
struct CompiledRule {
    name: String,
    trigger: BTreeSet<PadButton>,
    action: KeymapAction,
}

#[derive(Debug, Clone)]
struct PendingSubset {
    started_at_ms: u64,
    saw_superset_extra: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MacroPhase {
    Holding { until_ms: u64 },
    Gap { until_ms: u64 },
    LoopWait { until_ms: u64 },
}

#[derive(Debug, Clone)]
struct RunningMacro {
    step_idx: usize,
    phase: MacroPhase,
    force_single_pass: bool,
}

pub struct KeymapEngine {
    rules: Vec<CompiledRule>,
    /// Rule indices sorted by descending `trigger.len()`.
    order: Vec<usize>,
    trigger_threshold: u8,
    stick_deadzone: i16,
    armed: bool,
    held_rules: BTreeSet<usize>,
    release_latched: BTreeSet<PadButton>,
    pending_subsets: BTreeMap<usize, PendingSubset>,
    tap_flushes: BTreeMap<usize, u64>,
    running_macros: BTreeMap<usize, RunningMacro>,
    ref_tracker: RefTracker,
}

impl Default for KeymapEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl KeymapEngine {
    pub fn new() -> Self {
        Self {
            rules: vec![],
            order: vec![],
            trigger_threshold: default_trigger_threshold(),
            stick_deadzone: default_stick_deadzone(),
            armed: false,
            held_rules: BTreeSet::new(),
            release_latched: BTreeSet::new(),
            pending_subsets: BTreeMap::new(),
            tap_flushes: BTreeMap::new(),
            running_macros: BTreeMap::new(),
            ref_tracker: RefTracker::new(),
        }
    }

    pub fn configure(
        &mut self,
        profile: &KeymapProfile,
        trigger_threshold: u8,
        stick_deadzone: i16,
        sink: &mut dyn OutputSink,
    ) {
        self.reset_and_release(sink);
        self.trigger_threshold = trigger_threshold;
        self.stick_deadzone = stick_deadzone;
        self.rules = profile
            .rules
            .iter()
            .filter(|r| r.enabled)
            .map(|r| CompiledRule {
                name: r.name.clone(),
                trigger: r.trigger.iter().copied().collect(),
                action: r.action.clone(),
            })
            .collect();
        self.order = (0..self.rules.len()).collect();
        self.order
            .sort_by(|&a, &b| self.rules[b].trigger.len().cmp(&self.rules[a].trigger.len()).then(a.cmp(&b)));
    }

    pub fn is_armed(&self) -> bool {
        self.armed
    }

    pub fn active_rule_names(&self) -> Vec<String> {
        let mut active_indices = BTreeSet::new();
        for &idx in &self.held_rules {
            if matches!(self.rules[idx].action, KeymapAction::Hold { .. }) {
                active_indices.insert(idx);
            }
        }
        for &idx in self.tap_flushes.keys() {
            active_indices.insert(idx);
        }
        for &idx in self.running_macros.keys() {
            active_indices.insert(idx);
        }
        active_indices
            .into_iter()
            .filter_map(|i| self.rules.get(i).map(|r| r.name.clone()))
            .collect()
    }

    pub fn held_tokens(&self) -> Vec<OutputToken> {
        self.ref_tracker.held_tokens()
    }

    pub fn reset_and_release(&mut self, sink: &mut dyn OutputSink) {
        self.held_rules.clear();
        self.release_latched.clear();
        self.pending_subsets.clear();
        self.tap_flushes.clear();
        self.running_macros.clear();
        self.armed = false;
        self.ref_tracker.release_all(sink);
    }

    pub fn emergency_stop(&mut self, sink: &mut dyn OutputSink) {
        self.reset_and_release(sink);
    }

    pub fn on_disconnect(&mut self, sink: &mut dyn OutputSink) {
        self.reset_and_release(sink);
    }

    #[inline]
    fn hold_owner_id(rule_idx: usize) -> u64 {
        1 + (rule_idx as u64) * 3
    }
    #[inline]
    fn tap_owner_id(rule_idx: usize) -> u64 {
        2 + (rule_idx as u64) * 3
    }
    #[inline]
    fn macro_owner_id(rule_idx: usize) -> u64 {
        3 + (rule_idx as u64) * 3
    }

    fn viable_superset_extra_buttons(
        &self,
        rule_idx: usize,
        claimed: &BTreeSet<PadButton>,
        latched: &BTreeSet<PadButton>,
    ) -> BTreeSet<PadButton> {
        let sub = &self.rules[rule_idx].trigger;
        let mut extra = BTreeSet::new();
        for (other_idx, other) in self.rules.iter().enumerate() {
            if other_idx == rule_idx || other.trigger.len() <= sub.len() {
                continue;
            }
            if sub.is_subset(&other.trigger)
                && other.trigger.is_disjoint(claimed)
                && other.trigger.is_disjoint(latched)
            {
                for &b in other.trigger.difference(sub) {
                    extra.insert(b);
                }
            }
        }
        extra
    }

    pub fn tick(&mut self, now_ms: u64, pad: Option<PadState>, sink: &mut dyn OutputSink) {
        let Some(state) = pad else {
            if self.armed || !self.ref_tracker.is_empty() {
                self.on_disconnect(sink);
            }
            return;
        };

        let pressed = state.active_buttons(self.trigger_threshold, self.stick_deadzone);

        if !self.armed {
            if pressed.is_empty() {
                self.armed = true;
            } else {
                return;
            }
        }

        // 1. Complete expired fast-tap Hold pulses
        let expired_taps: Vec<usize> = self
            .tap_flushes
            .iter()
            .filter_map(|(&idx, &until)| (now_ms >= until).then_some(idx))
            .collect();
        for idx in expired_taps {
            self.tap_flushes.remove(&idx);
            self.ref_tracker.release_owner(Self::tap_owner_id(idx), sink);
        }

        // 2. Check already-held rules: sustain & exclusively claim their buttons, or deactivate & latch
        let prev_held: Vec<usize> = self.held_rules.iter().copied().collect();
        for idx in prev_held {
            if !self.rules[idx].trigger.is_subset(&pressed) {
                self.held_rules.remove(&idx);
                self.deactivate_rule(idx, sink);
                if self.rules[idx].trigger.len() > 1 {
                    for &b in &self.rules[idx].trigger {
                        if pressed.contains(&b) {
                            self.release_latched.insert(b);
                        }
                    }
                }
            }
        }
        self.release_latched.retain(|b| pressed.contains(b));

        let mut claimed = BTreeSet::new();
        for &idx in &self.held_rules {
            claimed.extend(self.rules[idx].trigger.iter().copied());
        }

        let mut available: BTreeSet<PadButton> = pressed
            .iter()
            .copied()
            .filter(|b| !claimed.contains(b) && !self.release_latched.contains(b))
            .collect();

        // 3. Evaluate immediate (no viable proper superset) rules in descending chord-length order
        let order = self.order.clone();
        for &idx in &order {
            if self.held_rules.contains(&idx) || self.pending_subsets.contains_key(&idx) {
                continue;
            }
            if !self.rules[idx].trigger.is_subset(&available) {
                continue;
            }
            let sup_extra =
                self.viable_superset_extra_buttons(idx, &claimed, &self.release_latched);
            if sup_extra.is_empty() {
                // Zero-latency activation!
                let trig = self.rules[idx].trigger.clone();
                self.held_rules.insert(idx);
                claimed.extend(trig.iter().copied());
                available.retain(|b| !trig.contains(b));
                // Cancel any pending lower-order subset rule whose buttons were just claimed
                self.pending_subsets
                    .retain(|&p_idx, _| self.rules[p_idx].trigger.is_disjoint(&trig));
                self.activate_rule(idx, now_ms, sink);
            }
        }

        // 4. Process existing pending subset rules (either promote at >=20ms or flush fast-tap on <20ms release)
        let pending_indices: Vec<usize> = self.pending_subsets.keys().copied().collect();
        for idx in pending_indices {
            let Some(mut entry) = self.pending_subsets.remove(&idx) else {
                continue;
            };
            let sup_extra =
                self.viable_superset_extra_buttons(idx, &claimed, &self.release_latched);
            if available.iter().any(|b| sup_extra.contains(b)) {
                entry.saw_superset_extra = true;
            }
            if self.rules[idx].trigger.is_subset(&available) {
                if sup_extra.is_empty()
                    || now_ms.saturating_sub(entry.started_at_ms) >= SUBSET_DEBOUNCE_MS
                {
                    let trig = self.rules[idx].trigger.clone();
                    self.held_rules.insert(idx);
                    claimed.extend(trig.iter().copied());
                    available.retain(|b| !trig.contains(b));
                    self.pending_subsets
                        .retain(|&p_idx, _| self.rules[p_idx].trigger.is_disjoint(&trig));
                    self.activate_rule(idx, now_ms, sink);
                } else {
                    self.pending_subsets.insert(idx, entry);
                }
            } else {
                // Released before 20ms without upgrading to any superset chord!
                if !entry.saw_superset_extra {
                    self.flush_fast_tap(idx, now_ms, sink);
                }
                if self.rules[idx].trigger.len() > 1 {
                    for &b in &self.rules[idx].trigger {
                        if pressed.contains(&b) {
                            self.release_latched.insert(b);
                            available.remove(&b);
                        }
                    }
                }
            }
        }

        // 5. Enqueue newly pressed subset rules into the 20ms prefix debounce window
        for &idx in &order {
            if self.held_rules.contains(&idx) || self.pending_subsets.contains_key(&idx) {
                continue;
            }
            if !self.rules[idx].trigger.is_subset(&available) {
                continue;
            }
            let sup_extra =
                self.viable_superset_extra_buttons(idx, &claimed, &self.release_latched);
            if sup_extra.is_empty() {
                let trig = self.rules[idx].trigger.clone();
                self.held_rules.insert(idx);
                claimed.extend(trig.iter().copied());
                available.retain(|b| !trig.contains(b));
                self.activate_rule(idx, now_ms, sink);
            } else {
                let saw_extra = available.iter().any(|b| sup_extra.contains(b));
                self.pending_subsets.insert(
                    idx,
                    PendingSubset {
                        started_at_ms: now_ms,
                        saw_superset_extra: saw_extra,
                    },
                );
            }
        }

        // 6. Advance running sequential macros
        self.advance_macros(now_ms, sink);
    }

    fn activate_rule(&mut self, idx: usize, now_ms: u64, sink: &mut dyn OutputSink) {
        let action = self.rules[idx].action.clone();
        match action {
            KeymapAction::Hold { keys } => {
                // Cancel any lingering fast-tap pulse on the same rule
                if self.tap_flushes.remove(&idx).is_some() {
                    self.ref_tracker.release_owner(Self::tap_owner_id(idx), sink);
                }
                self.ref_tracker
                    .set_owner_keys(Self::hold_owner_id(idx), &keys, sink);
            }
            KeymapAction::Macro { trigger_mode, .. } => match trigger_mode {
                KbTriggerMode::Once | KbTriggerMode::HoldLoop => {
                    self.start_macro(idx, now_ms, false, sink);
                }
                KbTriggerMode::ToggleLoop => {
                    if self.running_macros.remove(&idx).is_some() {
                        self.ref_tracker
                            .release_owner(Self::macro_owner_id(idx), sink);
                    } else {
                        self.start_macro(idx, now_ms, false, sink);
                    }
                }
            },
        }
    }

    fn deactivate_rule(&mut self, idx: usize, sink: &mut dyn OutputSink) {
        match &self.rules[idx].action {
            KeymapAction::Hold { .. } => {
                self.ref_tracker
                    .release_owner(Self::hold_owner_id(idx), sink);
            }
            KeymapAction::Macro { trigger_mode, .. } => {
                if *trigger_mode == KbTriggerMode::HoldLoop
                    && self.running_macros.remove(&idx).is_some()
                {
                    self.ref_tracker
                        .release_owner(Self::macro_owner_id(idx), sink);
                }
            }
        }
    }

    fn flush_fast_tap(&mut self, idx: usize, now_ms: u64, sink: &mut dyn OutputSink) {
        let action = self.rules[idx].action.clone();
        match action {
            KeymapAction::Hold { keys } => {
                let has_non_wheel = keys.iter().any(|k| !k.is_wheel());
                self.ref_tracker
                    .set_owner_keys(Self::tap_owner_id(idx), &keys, sink);
                if has_non_wheel {
                    self.tap_flushes.insert(idx, now_ms + TAP_FLUSH_HOLD_MS);
                }
            }
            KeymapAction::Macro { trigger_mode, .. } => match trigger_mode {
                KbTriggerMode::Once => self.start_macro(idx, now_ms, false, sink),
                KbTriggerMode::HoldLoop => self.start_macro(idx, now_ms, true, sink),
                KbTriggerMode::ToggleLoop => {
                    if self.running_macros.remove(&idx).is_some() {
                        self.ref_tracker
                            .release_owner(Self::macro_owner_id(idx), sink);
                    } else {
                        self.start_macro(idx, now_ms, false, sink);
                    }
                }
            },
        }
    }

    fn start_macro(
        &mut self,
        idx: usize,
        now_ms: u64,
        force_single_pass: bool,
        sink: &mut dyn OutputSink,
    ) {
        self.ref_tracker
            .release_owner(Self::macro_owner_id(idx), sink);
        if let Some(phase) = self.enter_macro_step(idx, 0, now_ms, sink) {
            self.running_macros.insert(
                idx,
                RunningMacro {
                    step_idx: 0,
                    phase,
                    force_single_pass,
                },
            );
        }
    }

    fn enter_macro_step(
        &mut self,
        idx: usize,
        step_idx: usize,
        start_ms: u64,
        sink: &mut dyn OutputSink,
    ) -> Option<MacroPhase> {
        let KeymapAction::Macro { steps, .. } = &self.rules[idx].action else {
            return None;
        };
        let step = steps.get(step_idx)?.clone();
        let owner = Self::macro_owner_id(idx);
        if step.keys.is_empty() {
            self.ref_tracker.release_owner(owner, sink);
            let wait = step.hold_ms as u64 + step.gap_ms as u64;
            Some(MacroPhase::Gap {
                until_ms: start_ms + wait,
            })
        } else if step.keys.iter().all(|k| k.is_wheel()) {
            self.ref_tracker.release_owner(owner, sink);
            for &w in &step.keys {
                sink.send_key(w, true);
            }
            let wait = step.hold_ms as u64 + step.gap_ms as u64;
            Some(MacroPhase::Gap {
                until_ms: start_ms + wait,
            })
        } else {
            self.ref_tracker.set_owner_keys(owner, &step.keys, sink);
            Some(MacroPhase::Holding {
                until_ms: start_ms + step.hold_ms as u64,
            })
        }
    }

    fn advance_macros(&mut self, now_ms: u64, sink: &mut dyn OutputSink) {
        let active_indices: Vec<usize> = self.running_macros.keys().copied().collect();
        for idx in active_indices {
            let KeymapAction::Macro {
                steps,
                trigger_mode,
                loop_ms,
            } = self.rules[idx].action.clone()
            else {
                continue;
            };
            let Some(mut mac) = self.running_macros.remove(&idx) else {
                continue;
            };
            let owner = Self::macro_owner_id(idx);
            let mut loop_wrapped = false;
            let mut keep_running = true;

            loop {
                match mac.phase {
                    MacroPhase::Holding { until_ms } => {
                        if now_ms < until_ms {
                            break;
                        }
                        self.ref_tracker.release_owner(owner, sink);
                        let gap = steps[mac.step_idx].gap_ms as u64;
                        if gap > 0 {
                            mac.phase = MacroPhase::Gap {
                                until_ms: until_ms + gap,
                            };
                            continue;
                        }
                        if !self.advance_to_next_step(
                            idx,
                            &steps,
                            trigger_mode,
                            loop_ms,
                            until_ms,
                            now_ms,
                            &mut mac,
                            &mut loop_wrapped,
                            sink,
                        ) {
                            keep_running = false;
                            break;
                        }
                    }
                    MacroPhase::Gap { until_ms } => {
                        if now_ms < until_ms {
                            break;
                        }
                        if !self.advance_to_next_step(
                            idx,
                            &steps,
                            trigger_mode,
                            loop_ms,
                            until_ms,
                            now_ms,
                            &mut mac,
                            &mut loop_wrapped,
                            sink,
                        ) {
                            keep_running = false;
                            break;
                        }
                    }
                    MacroPhase::LoopWait { until_ms } => {
                        if now_ms < until_ms || loop_wrapped {
                            break;
                        }
                        loop_wrapped = true;
                        mac.step_idx = 0;
                        let step_base = until_ms.max(now_ms);
                        if let Some(p) = self.enter_macro_step(idx, 0, step_base, sink) {
                            mac.phase = p;
                        } else {
                            keep_running = false;
                            break;
                        }
                    }
                }
            }

            if keep_running {
                self.running_macros.insert(idx, mac);
            } else {
                self.ref_tracker.release_owner(owner, sink);
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn advance_to_next_step(
        &mut self,
        idx: usize,
        steps: &[KbStep],
        trigger_mode: KbTriggerMode,
        loop_ms: u32,
        phase_end_ms: u64,
        now_ms: u64,
        mac: &mut RunningMacro,
        loop_wrapped: &mut bool,
        sink: &mut dyn OutputSink,
    ) -> bool {
        if mac.step_idx + 1 < steps.len() {
            mac.step_idx += 1;
            let base = phase_end_ms.max(now_ms);
            if let Some(p) = self.enter_macro_step(idx, mac.step_idx, base, sink) {
                mac.phase = p;
                return true;
            }
            return false;
        }
        // Reached end of steps
        if mac.force_single_pass || trigger_mode == KbTriggerMode::Once {
            return false;
        }
        if loop_ms > 0 {
            mac.phase = MacroPhase::LoopWait {
                until_ms: phase_end_ms + loop_ms as u64,
            };
            return true;
        }
        if *loop_wrapped {
            // Prevent multiple zero-gap cycles within a single tick
            mac.phase = MacroPhase::LoopWait {
                until_ms: now_ms + 1,
            };
            return true;
        }
        *loop_wrapped = true;
        mac.step_idx = 0;
        let base = phase_end_ms.max(now_ms);
        if let Some(p) = self.enter_macro_step(idx, 0, base, sink) {
            mac.phase = p;
            true
        } else {
            false
        }
    }
}
