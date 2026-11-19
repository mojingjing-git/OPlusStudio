use crate::{KeymapLease, read_pad_slot};
use oplus_core::{
    Result,
    keymap::{KeymapEngine, KeymapProfile, KeymapStore, OutputSink, OutputToken},
    storage,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

#[cfg(windows)]
use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunnerSnapshot {
    pub enabled: bool,
    pub paused_reason: Option<String>,
    pub state: String,
    pub active_slot: Option<u32>,
    pub active_rules: Vec<String>,
    pub armed: bool,
    pub panic_count: u64,
    pub last_panic: bool,
    pub blocked_count: u64,
    pub injection_warning: Option<String>,
    #[serde(default)]
    pub load_error: Option<String>,
}

impl Default for RunnerSnapshot {
    fn default() -> Self {
        Self {
            enabled: false,
            paused_reason: None,
            state: "stopped".into(),
            active_slot: None,
            active_rules: vec![],
            armed: false,
            panic_count: 0,
            last_panic: false,
            blocked_count: 0,
            injection_warning: None,
            load_error: None,
        }
    }
}

#[cfg(windows)]
fn mouse_event(flags: MOUSE_EVENT_FLAGS, mouse_data: u32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: mouse_data,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

#[cfg(windows)]
fn vk_and_extended(token: OutputToken) -> Option<(u16, bool)> {
    let pair = match token {
        OutputToken::A => (0x41, false),
        OutputToken::B => (0x42, false),
        OutputToken::C => (0x43, false),
        OutputToken::D => (0x44, false),
        OutputToken::E => (0x45, false),
        OutputToken::F => (0x46, false),
        OutputToken::G => (0x47, false),
        OutputToken::H => (0x48, false),
        OutputToken::I => (0x49, false),
        OutputToken::J => (0x4A, false),
        OutputToken::K => (0x4B, false),
        OutputToken::L => (0x4C, false),
        OutputToken::M => (0x4D, false),
        OutputToken::N => (0x4E, false),
        OutputToken::O => (0x4F, false),
        OutputToken::P => (0x50, false),
        OutputToken::Q => (0x51, false),
        OutputToken::R => (0x52, false),
        OutputToken::S => (0x53, false),
        OutputToken::T => (0x54, false),
        OutputToken::U => (0x55, false),
        OutputToken::V => (0x56, false),
        OutputToken::W => (0x57, false),
        OutputToken::X => (0x58, false),
        OutputToken::Y => (0x59, false),
        OutputToken::Z => (0x5A, false),

        OutputToken::Key0 => (0x30, false),
        OutputToken::Key1 => (0x31, false),
        OutputToken::Key2 => (0x32, false),
        OutputToken::Key3 => (0x33, false),
        OutputToken::Key4 => (0x34, false),
        OutputToken::Key5 => (0x35, false),
        OutputToken::Key6 => (0x36, false),
        OutputToken::Key7 => (0x37, false),
        OutputToken::Key8 => (0x38, false),
        OutputToken::Key9 => (0x39, false),

        // Function keys F1..F12 excluding F8 (0x77)!
        OutputToken::F1 => (0x70, false),
        OutputToken::F2 => (0x71, false),
        OutputToken::F3 => (0x72, false),
        OutputToken::F4 => (0x73, false),
        OutputToken::F5 => (0x74, false),
        OutputToken::F6 => (0x75, false),
        OutputToken::F7 => (0x76, false),
        OutputToken::F9 => (0x78, false),
        OutputToken::F10 => (0x79, false),
        OutputToken::F11 => (0x7A, false),
        OutputToken::F12 => (0x7B, false),

        // Modifiers
        OutputToken::LShift => (VK_LSHIFT, false),
        OutputToken::RShift => (VK_RSHIFT, false),
        OutputToken::LCtrl => (VK_LCONTROL, false),
        OutputToken::RCtrl => (VK_RCONTROL, true),
        OutputToken::LAlt => (VK_LMENU, false),
        OutputToken::RAlt => (VK_RMENU, true),
        OutputToken::LWin => (VK_LWIN, true),
        OutputToken::RWin => (VK_RWIN, true),

        // Editing & Navigation
        OutputToken::Space => (VK_SPACE, false),
        OutputToken::Enter => (VK_RETURN, false),
        OutputToken::Escape => (VK_ESCAPE, false),
        OutputToken::Tab => (VK_TAB, false),
        OutputToken::Backspace => (VK_BACK, false),
        OutputToken::CapsLock => (VK_CAPITAL, false),
        OutputToken::Insert => (VK_INSERT, true),
        OutputToken::Delete => (VK_DELETE, true),
        OutputToken::Home => (VK_HOME, true),
        OutputToken::End => (VK_END, true),
        OutputToken::PageUp => (VK_PRIOR, true),
        OutputToken::PageDown => (VK_NEXT, true),
        OutputToken::Up => (VK_UP, true),
        OutputToken::Down => (VK_DOWN, true),
        OutputToken::Left => (VK_LEFT, true),
        OutputToken::Right => (VK_RIGHT, true),

        // Symbols
        OutputToken::Grave => (VK_OEM_3, false),
        OutputToken::Minus => (VK_OEM_MINUS, false),
        OutputToken::Equals => (VK_OEM_PLUS, false),
        OutputToken::LeftBracket => (VK_OEM_4, false),
        OutputToken::RightBracket => (VK_OEM_6, false),
        OutputToken::Backslash => (VK_OEM_5, false),
        OutputToken::Semicolon => (VK_OEM_1, false),
        OutputToken::Apostrophe => (VK_OEM_7, false),
        OutputToken::Comma => (VK_OEM_COMMA, false),
        OutputToken::Period => (VK_OEM_PERIOD, false),
        OutputToken::Slash => (VK_OEM_2, false),

        // Numpad
        OutputToken::Num0 => (VK_NUMPAD0, false),
        OutputToken::Num1 => (VK_NUMPAD1, false),
        OutputToken::Num2 => (VK_NUMPAD2, false),
        OutputToken::Num3 => (VK_NUMPAD3, false),
        OutputToken::Num4 => (VK_NUMPAD4, false),
        OutputToken::Num5 => (VK_NUMPAD5, false),
        OutputToken::Num6 => (VK_NUMPAD6, false),
        OutputToken::Num7 => (VK_NUMPAD7, false),
        OutputToken::Num8 => (VK_NUMPAD8, false),
        OutputToken::Num9 => (VK_NUMPAD9, false),
        OutputToken::NumMultiply => (VK_MULTIPLY, false),
        OutputToken::NumAdd => (VK_ADD, false),
        OutputToken::NumSubtract => (VK_SUBTRACT, false),
        OutputToken::NumDecimal => (VK_DECIMAL, false),
        OutputToken::NumDivide => (VK_DIVIDE, true),
        OutputToken::NumEnter => (VK_RETURN, true),

        OutputToken::MouseLeft
        | OutputToken::MouseRight
        | OutputToken::MouseMiddle
        | OutputToken::MouseX1
        | OutputToken::MouseX2
        | OutputToken::WheelUp
        | OutputToken::WheelDown => return None,
    };
    Some(pair)
}

/// Pure, side-effect-free encoder translating an `OutputToken` and direction into a Win32 `INPUT`.
/// - `MouseX1` / `MouseX2` carry `mouseData = 1 / 2` on BOTH `down = true` and `down = false`.
/// - `WheelUp` / `WheelDown` emit `mouseData = 120 / (-120i32 as u32)` on `down = true`, and `None` on `down = false`.
/// - Never emits `VK_F8` (`0x77`).
#[cfg(windows)]
pub fn encode_win32_event(token: OutputToken, down: bool) -> Option<INPUT> {
    match token {
        OutputToken::MouseLeft => Some(mouse_event(
            if down {
                MOUSEEVENTF_LEFTDOWN
            } else {
                MOUSEEVENTF_LEFTUP
            },
            0,
        )),
        OutputToken::MouseRight => Some(mouse_event(
            if down {
                MOUSEEVENTF_RIGHTDOWN
            } else {
                MOUSEEVENTF_RIGHTUP
            },
            0,
        )),
        OutputToken::MouseMiddle => Some(mouse_event(
            if down {
                MOUSEEVENTF_MIDDLEDOWN
            } else {
                MOUSEEVENTF_MIDDLEUP
            },
            0,
        )),
        OutputToken::MouseX1 => Some(mouse_event(
            if down {
                MOUSEEVENTF_XDOWN
            } else {
                MOUSEEVENTF_XUP
            },
            1,
        )),
        OutputToken::MouseX2 => Some(mouse_event(
            if down {
                MOUSEEVENTF_XDOWN
            } else {
                MOUSEEVENTF_XUP
            },
            2,
        )),
        OutputToken::WheelUp => {
            if down {
                Some(mouse_event(MOUSEEVENTF_WHEEL, 120u32))
            } else {
                None
            }
        }
        OutputToken::WheelDown => {
            if down {
                Some(mouse_event(MOUSEEVENTF_WHEEL, (-120i32) as u32))
            } else {
                None
            }
        }
        other => {
            let (vk, extended) = vk_and_extended(other)?;
            if vk == VK_F8 {
                return None;
            }
            let scan = unsafe { MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC) } as u16;
            let mut flags: KEYBD_EVENT_FLAGS = if down { 0 } else { KEYEVENTF_KEYUP };
            if extended {
                flags |= KEYEVENTF_EXTENDEDKEY;
            }
            Some(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: vk,
                        wScan: scan,
                        dwFlags: flags,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            })
        }
    }
}

#[derive(Default)]
struct Win32Sink {
    pressed: BTreeSet<OutputToken>,
    blocked_in_tick: u64,
}

impl Win32Sink {
    fn release_all(&mut self) {
        if self.pressed.is_empty() {
            return;
        }
        let mut tokens: Vec<OutputToken> = self.pressed.iter().copied().collect();
        self.pressed.clear();
        // Release non-modifiers first, modifiers last
        tokens.sort_by_key(|t| t.is_modifier());
        #[cfg(windows)]
        for tok in tokens {
            if let Some(ev) = encode_win32_event(tok, false) {
                unsafe {
                    let _ = SendInput(1, &ev, std::mem::size_of::<INPUT>() as i32);
                }
            }
        }
    }
}

impl OutputSink for Win32Sink {
    fn send_key(&mut self, token: OutputToken, down: bool) -> bool {
        #[cfg(windows)]
        {
            let Some(ev) = encode_win32_event(token, down) else {
                return true;
            };
            let sent = unsafe { SendInput(1, &ev, std::mem::size_of::<INPUT>() as i32) };
            if sent == 0 {
                if !down {
                    self.pressed.remove(&token);
                }
                self.blocked_in_tick += 1;
                return false;
            }
            if down && !token.is_wheel() {
                self.pressed.insert(token);
            } else if !down {
                self.pressed.remove(&token);
            }
            true
        }
        #[cfg(not(windows))]
        {
            let _ = (token, down);
            false
        }
    }
}

impl Drop for Win32Sink {
    fn drop(&mut self) {
        self.release_all();
    }
}

#[cfg(windows)]
struct HighResTimer {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl HighResTimer {
    fn new_2ms() -> Self {
        use windows_sys::Win32::System::Threading::{
            CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, CreateWaitableTimerExW, SetWaitableTimer,
            TIMER_ALL_ACCESS,
        };
        let handle = unsafe {
            CreateWaitableTimerExW(
                std::ptr::null(),
                std::ptr::null(),
                CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,
                TIMER_ALL_ACCESS,
            )
        };
        if !handle.is_null() {
            let due_100ns: i64 = -20_000; // relative 2.0 ms
            let ok = unsafe {
                SetWaitableTimer(
                    handle,
                    &due_100ns,
                    2,
                    None,
                    std::ptr::null(),
                    0,
                )
            };
            if ok == 0 {
                unsafe {
                    windows_sys::Win32::Foundation::CloseHandle(handle);
                }
                return Self {
                    handle: std::ptr::null_mut(),
                };
            }
        }
        Self { handle }
    }

    fn wait_tick(&self) {
        if !self.handle.is_null() {
            unsafe {
                let _ =
                    windows_sys::Win32::System::Threading::WaitForSingleObject(self.handle, 5);
            }
        } else {
            thread::sleep(Duration::from_millis(2));
        }
    }
}

#[cfg(windows)]
impl Drop for HighResTimer {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe {
                let _ = windows_sys::Win32::Foundation::CloseHandle(self.handle);
            }
        }
    }
}

#[cfg(windows)]
fn is_f8_pressed() -> bool {
    // Strictly inspect high bit 0x8000 (currently down), NEVER low bit 0x0001!
    (unsafe { GetAsyncKeyState(VK_F8 as i32) } as u16 & 0x8000) != 0
}

#[cfg(not(windows))]
fn is_f8_pressed() -> bool {
    false
}

struct Control {
    desired_enabled: bool,
    ble_busy_count: usize,
    recording_paused: bool,
    shutdown: bool,
    worker_parked: bool,
    preserve_unloaded_file: bool,
    config_generation: u64,
    store: KeymapStore,
    lease: Option<KeymapLease>,
    snapshot: RunnerSnapshot,
}

impl Control {
    fn compute_paused_reason(&self) -> Option<String> {
        if self.ble_busy_count > 0 {
            Some("ble".into())
        } else if self.recording_paused {
            Some("recording".into())
        } else {
            None
        }
    }

    fn refresh_idle_snapshot(&mut self) {
        self.snapshot.enabled = self.desired_enabled;
        self.snapshot.paused_reason = self.compute_paused_reason();
        if !self.desired_enabled {
            self.snapshot.state = "stopped".into();
            self.snapshot.active_rules.clear();
            self.snapshot.armed = false;
        } else if self.ble_busy_count > 0 {
            self.snapshot.state = "paused_ble".into();
            self.snapshot.active_rules.clear();
            self.snapshot.armed = false;
        } else if self.recording_paused {
            self.snapshot.state = "paused_recording".into();
            self.snapshot.active_rules.clear();
            self.snapshot.armed = false;
        }
    }
}

struct Shared {
    root: PathBuf,
    ctrl: Mutex<Control>,
    wake_cv: Condvar,
    parked_cv: Condvar,
    worker: Mutex<Option<JoinHandle<()>>>,
}

#[derive(Clone)]
pub struct MacroRunner {
    shared: Arc<Shared>,
}

/// RAII guard that pauses `MacroRunner` and releases all injected keys before BLE I/O,
/// automatically resuming on drop (even on early `?` return or task cancellation).
pub struct BlePauseGuard {
    runner: MacroRunner,
}

impl Drop for BlePauseGuard {
    fn drop(&mut self) {
        let mut ctrl = self.runner.shared.ctrl.lock().unwrap();
        ctrl.ble_busy_count = ctrl.ble_busy_count.saturating_sub(1);
        ctrl.refresh_idle_snapshot();
        self.runner.shared.wake_cv.notify_all();
    }
}

impl MacroRunner {
    pub fn new(root: PathBuf) -> Self {
        let path = storage::keymap_path(&root);
        let mut preserve_unloaded_file = false;
        let mut load_error = None;
        let store = if path.exists() {
            match storage::read::<KeymapStore>(&path, oplus_core::keymap::MAX_KEYMAP_BYTES)
                .and_then(|mut s| s.validate().map(|_| s))
            {
                Ok(s) => s,
                Err(e) => {
                    preserve_unloaded_file = true;
                    load_error = Some(format!(
                        "加载本地键盘宏方案失败（原文件已完整保留，未覆盖）：{e}"
                    ));
                    let mut fallback = KeymapStore::default_store();
                    let _ = fallback.validate();
                    fallback
                }
            }
        } else {
            let mut fallback = KeymapStore::default_store();
            let _ = fallback.validate();
            fallback
        };
        let initial_snapshot = RunnerSnapshot {
            load_error,
            ..RunnerSnapshot::default()
        };

        let shared = Arc::new(Shared {
            root,
            ctrl: Mutex::new(Control {
                desired_enabled: false,
                ble_busy_count: 0,
                recording_paused: false,
                shutdown: false,
                worker_parked: true,
                preserve_unloaded_file,
                config_generation: 1,
                store,
                lease: None,
                snapshot: initial_snapshot,
            }),
            wake_cv: Condvar::new(),
            parked_cv: Condvar::new(),
            worker: Mutex::new(None),
        });

        let thread_shared = shared.clone();
        let handle = thread::Builder::new()
            .name("oplus-macro-runner".into())
            .spawn(move || worker_loop(thread_shared))
            .expect("failed to spawn macro runner thread");
        *shared.worker.lock().unwrap() = Some(handle);

        Self { shared }
    }

    pub fn root(&self) -> &Path {
        &self.shared.root
    }

    pub fn store(&self) -> KeymapStore {
        self.shared.ctrl.lock().unwrap().store.clone()
    }

    pub fn snapshot(&self) -> RunnerSnapshot {
        self.shared.ctrl.lock().unwrap().snapshot.clone()
    }

    pub fn set_enabled(&self, enabled: bool) -> Result<RunnerSnapshot> {
        let mut ctrl = self.shared.ctrl.lock().unwrap();
        if ctrl.shutdown {
            return Err("应用正在退出".into());
        }
        if enabled {
            if ctrl.lease.is_none() {
                ctrl.lease = Some(KeymapLease::acquire(&self.shared.root)?);
            }
            ctrl.desired_enabled = true;
            ctrl.snapshot.last_panic = false;
            ctrl.snapshot.injection_warning = None;
            ctrl.config_generation += 1;
        } else {
            ctrl.desired_enabled = false;
            ctrl.lease = None;
        }
        ctrl.refresh_idle_snapshot();
        let snap = ctrl.snapshot.clone();
        self.shared.wake_cv.notify_all();
        Ok(snap)
    }

    pub fn dismiss_warning(&self) -> RunnerSnapshot {
        let mut ctrl = self.shared.ctrl.lock().unwrap();
        ctrl.snapshot.injection_warning = None;
        ctrl.snapshot.load_error = None;
        ctrl.snapshot.last_panic = false;
        ctrl.snapshot.clone()
    }

    pub fn set_recording_pause(&self, recording: bool) -> RunnerSnapshot {
        let mut ctrl = self.shared.ctrl.lock().unwrap();
        ctrl.recording_paused = recording;
        ctrl.refresh_idle_snapshot();
        let snap = ctrl.snapshot.clone();
        self.shared.wake_cv.notify_all();
        snap
    }

    pub fn pause_for_ble(&self) -> BlePauseGuard {
        {
            let mut ctrl = self.shared.ctrl.lock().unwrap();
            ctrl.ble_busy_count += 1;
            ctrl.refresh_idle_snapshot();
            self.shared.wake_cv.notify_all();
            let deadline = Instant::now() + Duration::from_millis(200);
            while !ctrl.worker_parked && !ctrl.shutdown {
                let now = Instant::now();
                if now >= deadline {
                    break;
                }
                let (next_ctrl, _) = self
                    .shared
                    .parked_cv
                    .wait_timeout(ctrl, deadline - now)
                    .unwrap();
                ctrl = next_ctrl;
            }
        }
        BlePauseGuard {
            runner: self.clone(),
        }
    }

    pub fn update_store(&self, mut store: KeymapStore) -> Result<(KeymapStore, RunnerSnapshot)> {
        store.validate()?;
        let path = storage::keymap_path(&self.shared.root);
        let bytes = serde_json::to_vec_pretty(&store).map_err(|e| e.to_string())?;
        if bytes.len() > oplus_core::keymap::MAX_KEYMAP_BYTES {
            return Err("键盘宏方案库体积超过 8 MiB 上限，请精简规则或步骤".into());
        }
        let mut ctrl = self.shared.ctrl.lock().unwrap();
        if ctrl.preserve_unloaded_file && path.exists() {
            let backup = self
                .shared
                .root
                .join(format!("keymap-profiles.unloaded-{}.json", storage::id()));
            std::fs::copy(&path, &backup).map_err(|e| {
                format!("无法备份未成功加载的旧键盘宏文件，已拒绝覆盖：{e}")
            })?;
        }
        storage::atomic(&path, &bytes)?;
        ctrl.preserve_unloaded_file = false;
        ctrl.snapshot.load_error = None;
        ctrl.store = store.clone();
        ctrl.config_generation += 1;
        let snap = ctrl.snapshot.clone();
        self.shared.wake_cv.notify_all();
        Ok((store, snap))
    }

    /// Lock-free shutdown: signals worker thread and joins it so all pressed keys
    /// are guaranteed released via `Win32Sink` before the window closes.
    pub fn shutdown(&self) {
        {
            let mut ctrl = self.shared.ctrl.lock().unwrap();
            ctrl.shutdown = true;
            ctrl.desired_enabled = false;
            ctrl.lease = None;
            ctrl.refresh_idle_snapshot();
            self.shared.wake_cv.notify_all();
        }
        if let Some(handle) = self.shared.worker.lock().unwrap().take() {
            let _ = handle.join();
        }
    }
}

impl Drop for MacroRunner {
    fn drop(&mut self) {
        if Arc::strong_count(&self.shared) == 1 {
            self.shutdown();
        }
    }
}

fn worker_loop(shared: Arc<Shared>) {
    // Thread-local engine & Win32Sink: NEVER placed inside a shared Mutex!
    let mut engine = KeymapEngine::new();
    let mut sink = Win32Sink::default();
    let start = Instant::now();
    let mut local_gen: u64 = 0;
    let mut controller_slot: Option<u8> = None;

    #[cfg(windows)]
    let timer = HighResTimer::new_2ms();

    loop {
        let mut need_config: Option<(KeymapProfile, Option<u8>, u8, i16, u64)> = None;
        let mut should_park = false;
        {
            let mut ctrl = shared.ctrl.lock().unwrap();
            if ctrl.shutdown {
                break;
            }
            if !ctrl.desired_enabled || ctrl.ble_busy_count > 0 || ctrl.recording_paused {
                should_park = true;
            } else {
                ctrl.worker_parked = false;
                if ctrl.config_generation != local_gen {
                    let profile = ctrl
                        .store
                        .active_profile()
                        .cloned()
                        .unwrap_or_else(|| KeymapProfile {
                            id: "empty".into(),
                            name: "空方案".into(),
                            rules: vec![],
                        });
                    need_config = Some((
                        profile,
                        ctrl.store.controller_slot,
                        ctrl.store.trigger_threshold,
                        ctrl.store.stick_deadzone,
                        ctrl.config_generation,
                    ));
                }
            }
        }

        // Release keys OUTSIDE the lock before parking on Condvar
        if should_park {
            engine.reset_and_release(&mut sink);
            sink.release_all();
            local_gen = 0; // force clean re-configure & neutral-frame arming on resume!

            let mut ctrl = shared.ctrl.lock().unwrap();
            if ctrl.shutdown {
                break;
            }
            if !ctrl.desired_enabled || ctrl.ble_busy_count > 0 || ctrl.recording_paused {
                ctrl.worker_parked = true;
                ctrl.refresh_idle_snapshot();
                shared.parked_cv.notify_all();
                drop(shared.wake_cv.wait(ctrl).unwrap());
            }
            continue;
        }

        if let Some((profile, slot_pref, trig_thresh, deadzone, cfg_gen)) = need_config {
            engine.configure(&profile, trig_thresh, deadzone, &mut sink);
            controller_slot = slot_pref;
            local_gen = cfg_gen;
        }

        // === All Win32 / XInput / SendInput calls happen strictly OUTSIDE any Mutex! ===
        if is_f8_pressed() {
            engine.emergency_stop(&mut sink);
            sink.release_all();
            local_gen = 0;
            let mut ctrl = shared.ctrl.lock().unwrap();
            ctrl.desired_enabled = false;
            ctrl.lease = None;
            ctrl.worker_parked = true;
            ctrl.snapshot.enabled = false;
            ctrl.snapshot.last_panic = true;
            ctrl.snapshot.panic_count += 1;
            ctrl.snapshot.state = "stopped".into();
            ctrl.snapshot.active_rules.clear();
            ctrl.snapshot.armed = false;
            shared.parked_cv.notify_all();
            continue;
        }

        sink.blocked_in_tick = 0;
        let pad_reading = read_pad_slot(controller_slot);
        let active_slot = pad_reading.map(|(s, _)| s);
        let pad_state = pad_reading.map(|(_, st)| st);
        let now_ms = start.elapsed().as_millis() as u64;

        engine.tick(now_ms, pad_state, &mut sink);

        let armed = engine.is_armed();
        let active_rules = engine.active_rule_names();
        let blocked = sink.blocked_in_tick;

        // Publish snapshot briefly under lock
        {
            let mut ctrl = shared.ctrl.lock().unwrap();
            if ctrl.desired_enabled && ctrl.ble_busy_count == 0 && !ctrl.recording_paused {
                ctrl.snapshot.enabled = true;
                ctrl.snapshot.paused_reason = None;
                ctrl.snapshot.active_slot = active_slot;
                ctrl.snapshot.armed = armed;
                ctrl.snapshot.active_rules = active_rules.clone();
                ctrl.snapshot.state = if active_slot.is_none() {
                    "no_controller".into()
                } else if !armed {
                    "wait_neutral".into()
                } else if !active_rules.is_empty() {
                    "active".into()
                } else {
                    "listening".into()
                };
                if blocked > 0 {
                    ctrl.snapshot.blocked_count += blocked;
                    ctrl.snapshot.injection_warning = Some(
                        "目标窗口拒绝模拟输入（可能因管理员权限隔离 UIPI 或反作弊保护），已自动放弃注入。"
                            .into(),
                    );
                }
            }
        }

        #[cfg(windows)]
        timer.wait_tick();
        #[cfg(not(windows))]
        thread::sleep(Duration::from_millis(2));
    }

    // Guaranteed cleanup on worker exit (plus Win32Sink::Drop as backstop)
    engine.reset_and_release(&mut sink);
    sink.release_all();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn win32_input_abi_and_encoding_invariants() {
        // 64-bit Windows ABI requirement: sizeof(INPUT) MUST equal 40 bytes!
        assert_eq!(std::mem::size_of::<INPUT>(), 40);

        // MouseX1 / MouseX2 MUST carry mouseData = 1 / 2 on BOTH press and release!
        for (tok, expected_data) in [(OutputToken::MouseX1, 1u32), (OutputToken::MouseX2, 2u32)] {
            let down = encode_win32_event(tok, true).unwrap();
            let up = encode_win32_event(tok, false).unwrap();
            unsafe {
                assert_eq!(down.r#type, INPUT_MOUSE);
                assert_eq!(down.Anonymous.mi.dwFlags, MOUSEEVENTF_XDOWN);
                assert_eq!(down.Anonymous.mi.mouseData, expected_data);
                assert_eq!(up.r#type, INPUT_MOUSE);
                assert_eq!(up.Anonymous.mi.dwFlags, MOUSEEVENTF_XUP);
                assert_eq!(up.Anonymous.mi.mouseData, expected_data);
            }
        }

        // WheelUp / WheelDown emit +/-120 on down=true and None on down=false!
        let wu_down = encode_win32_event(OutputToken::WheelUp, true).unwrap();
        assert!(encode_win32_event(OutputToken::WheelUp, false).is_none());
        let wd_down = encode_win32_event(OutputToken::WheelDown, true).unwrap();
        assert!(encode_win32_event(OutputToken::WheelDown, false).is_none());
        unsafe {
            assert_eq!(wu_down.Anonymous.mi.dwFlags, MOUSEEVENTF_WHEEL);
            assert_eq!(wu_down.Anonymous.mi.mouseData, 120u32);
            assert_eq!(wd_down.Anonymous.mi.dwFlags, MOUSEEVENTF_WHEEL);
            assert_eq!(wd_down.Anonymous.mi.mouseData, (-120i32) as u32);
        }

        // Exhaustive check across all 105 OutputTokens: never emits VK_F8 (0x77)!
        let extended_expected = [
            OutputToken::RCtrl,
            OutputToken::RAlt,
            OutputToken::LWin,
            OutputToken::RWin,
            OutputToken::Insert,
            OutputToken::Delete,
            OutputToken::Home,
            OutputToken::End,
            OutputToken::PageUp,
            OutputToken::PageDown,
            OutputToken::Up,
            OutputToken::Down,
            OutputToken::Left,
            OutputToken::Right,
            OutputToken::NumDivide,
            OutputToken::NumEnter,
        ];
        for tok in OutputToken::ALL {
            if tok.is_wheel() {
                assert!(encode_win32_event(tok, true).is_some());
                assert!(encode_win32_event(tok, false).is_none());
                continue;
            }
            let down = encode_win32_event(tok, true).unwrap();
            let up = encode_win32_event(tok, false).unwrap();
            if down.r#type == INPUT_KEYBOARD {
                unsafe {
                    assert_ne!(down.Anonymous.ki.wVk, VK_F8);
                    assert_ne!(up.Anonymous.ki.wVk, VK_F8);
                    assert_eq!(up.Anonymous.ki.dwFlags & KEYEVENTF_KEYUP, KEYEVENTF_KEYUP);
                    if extended_expected.contains(&tok) {
                        assert_ne!(
                            down.Anonymous.ki.dwFlags & KEYEVENTF_EXTENDEDKEY,
                            0,
                            "expected extended flag for {tok:?}"
                        );
                        assert_ne!(
                            up.Anonymous.ki.dwFlags & KEYEVENTF_EXTENDEDKEY,
                            0,
                            "expected extended flag on release for {tok:?}"
                        );
                    }
                    if matches!(tok, OutputToken::A | OutputToken::Z | OutputToken::Space) {
                        assert_ne!(down.Anonymous.ki.wScan, 0);
                    }
                }
            }
        }
    }

    #[test]
    fn keymap_lease_prevents_dual_instance_and_ble_pause_guard_restores() {
        let dir = std::env::temp_dir().join(format!("oplus-dev-test-{}", storage::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let l1 = KeymapLease::acquire(&dir).unwrap();
        assert!(KeymapLease::acquire(&dir).is_err());
        drop(l1);
        let l2 = KeymapLease::acquire(&dir).unwrap();
        drop(l2);

        // Runner starts disabled (0% CPU, zero OS input calls) and BlePauseGuard restores cleanly on drop
        let runner = MacroRunner::new(dir.clone());
        assert!(!runner.snapshot().enabled);
        assert_eq!(runner.snapshot().state, "stopped");
        {
            let _guard = runner.pause_for_ble();
            assert_eq!(runner.snapshot().paused_reason.as_deref(), Some("ble"));
        }
        assert!(runner.snapshot().paused_reason.is_none());
        runner.shutdown();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
