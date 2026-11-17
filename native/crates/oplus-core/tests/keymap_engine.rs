use oplus_core::keymap::*;

#[derive(Default)]
struct MockSink {
    events: Vec<(OutputToken, bool)>,
}

impl OutputSink for MockSink {
    fn send_key(&mut self, token: OutputToken, down: bool) -> bool {
        self.events.push((token, down));
        true
    }
}

fn pad(buttons: &[PadButton]) -> PadState {
    let mut s = PadState::default();
    for b in buttons {
        match b {
            PadButton::A => s.buttons |= 0x1000,
            PadButton::B => s.buttons |= 0x2000,
            PadButton::X => s.buttons |= 0x4000,
            PadButton::Y => s.buttons |= 0x8000,
            PadButton::LB => s.buttons |= 0x0100,
            PadButton::RB => s.buttons |= 0x0200,
            PadButton::Back => s.buttons |= 0x0020,
            PadButton::Start => s.buttons |= 0x0010,
            PadButton::LS => s.buttons |= 0x0040,
            PadButton::RS => s.buttons |= 0x0080,
            PadButton::Up => s.buttons |= 0x0001,
            PadButton::Down => s.buttons |= 0x0002,
            PadButton::Left => s.buttons |= 0x0004,
            PadButton::Right => s.buttons |= 0x0008,
            PadButton::LT => s.left_trigger = 200,
            PadButton::RT => s.right_trigger = 200,
            PadButton::LXNeg => s.lx = -25000,
            PadButton::LXPos => s.lx = 25000,
            PadButton::LYNeg => s.ly = -25000,
            PadButton::LYPos => s.ly = 25000,
            PadButton::RXNeg => s.rx = -25000,
            PadButton::RXPos => s.rx = 25000,
            PadButton::RYNeg => s.ry = -25000,
            PadButton::RYPos => s.ry = 25000,
        }
    }
    s
}

#[test]
fn shared_modifier_reference_counting_and_release_order() {
    let mut profile = KeymapProfile {
        id: "p1".into(),
        name: "修饰键测试".into(),
        rules: vec![
            KeymapRule {
                id: "r1".into(),
                name: "复制".into(),
                enabled: true,
                rear_slot: None,
                trigger: vec![PadButton::LB],
                action: KeymapAction::Hold {
                    keys: vec![OutputToken::LCtrl, OutputToken::LShift, OutputToken::C],
                },
            },
            KeymapRule {
                id: "r2".into(),
                name: "粘贴".into(),
                enabled: true,
                rear_slot: None,
                trigger: vec![PadButton::RB],
                action: KeymapAction::Hold {
                    keys: vec![OutputToken::LCtrl, OutputToken::V],
                },
            },
        ],
    };
    profile.validate().unwrap();

    let mut sink = MockSink::default();
    let mut engine = KeymapEngine::new();
    engine.configure(&profile, 64, 16000, &mut sink);

    // Neutral frame arms the engine
    engine.tick(0, Some(PadState::default()), &mut sink);
    assert!(engine.is_armed());

    // Press LB -> LCtrl Down, LShift Down, C Down
    engine.tick(2, Some(pad(&[PadButton::LB])), &mut sink);
    assert_eq!(
        sink.events,
        vec![
            (OutputToken::LCtrl, true),
            (OutputToken::LShift, true),
            (OutputToken::C, true),
        ]
    );
    sink.events.clear();

    // Press RB while holding LB -> LCtrl already held, only V Down!
    engine.tick(10, Some(pad(&[PadButton::LB, PadButton::RB])), &mut sink);
    assert_eq!(sink.events, vec![(OutputToken::V, true)]);
    sink.events.clear();

    // Release LB while still holding RB -> C Up first (non-modifier), then LShift Up (modifier); LCtrl stays Down!
    engine.tick(20, Some(pad(&[PadButton::RB])), &mut sink);
    assert_eq!(
        sink.events,
        vec![(OutputToken::C, false), (OutputToken::LShift, false)]
    );
    assert_eq!(engine.held_tokens(), vec![OutputToken::V, OutputToken::LCtrl]);
    sink.events.clear();

    // Release RB -> V Up first (non-modifier), then LCtrl Up last!
    engine.tick(30, Some(PadState::default()), &mut sink);
    assert_eq!(
        sink.events,
        vec![(OutputToken::V, false), (OutputToken::LCtrl, false)]
    );
    assert!(engine.held_tokens().is_empty());
}

#[test]
fn m1_chord_claims_buttons_so_pressing_up_never_misfires_m2() {
    let (m1_trig, _) = bridge_preset(0).unwrap(); // Back + LS + RS
    let (m2_trig, _) = bridge_preset(1).unwrap(); // Back + LS + Up
    let mut profile = KeymapProfile {
        id: "bridge".into(),
        name: "背键防串扰".into(),
        rules: vec![
            KeymapRule {
                id: "m1".into(),
                name: "M1".into(),
                enabled: true,
                rear_slot: Some(0),
                trigger: m1_trig.clone(),
                action: KeymapAction::Hold {
                    keys: vec![OutputToken::Key1],
                },
            },
            KeymapRule {
                id: "m2".into(),
                name: "M2".into(),
                enabled: true,
                rear_slot: Some(1),
                trigger: m2_trig.clone(),
                action: KeymapAction::Hold {
                    keys: vec![OutputToken::Key2],
                },
            },
            KeymapRule {
                id: "front_a".into(),
                name: "A跳".into(),
                enabled: true,
                rear_slot: None,
                trigger: vec![PadButton::A],
                action: KeymapAction::Hold {
                    keys: vec![OutputToken::Space],
                },
            },
        ],
    };
    profile.validate().unwrap();

    let mut sink = MockSink::default();
    let mut engine = KeymapEngine::new();
    engine.configure(&profile, 64, 16000, &mut sink);
    engine.tick(0, Some(PadState::default()), &mut sink);

    // Hold M1 (Back + LS + RS): 0ms zero-latency activation!
    engine.tick(2, Some(pad(&m1_trig)), &mut sink);
    assert_eq!(sink.events, vec![(OutputToken::Key1, true)]);
    sink.events.clear();

    // While holding M1, user presses D-Pad Up -> frame has {Back, LS, RS, Up}!
    // Even though {Back, LS, Up} (M2) is a subset of pressed buttons, Back & LS are claimed by M1,
    // so M2 MUST NOT misfire!
    engine.tick(
        10,
        Some(pad(&[
            PadButton::Back,
            PadButton::LS,
            PadButton::RS,
            PadButton::Up,
        ])),
        &mut sink,
    );
    assert!(sink.events.is_empty());

    // Meanwhile an unrelated button A CAN still fire independently!
    engine.tick(
        14,
        Some(pad(&[
            PadButton::Back,
            PadButton::LS,
            PadButton::RS,
            PadButton::Up,
            PadButton::A,
        ])),
        &mut sink,
    );
    assert_eq!(sink.events, vec![(OutputToken::Space, true)]);
    sink.events.clear();

    // Now user releases RS slightly before Back+LS while Up is still held ({Back, LS, Up}):
    // Because Back and LS were latched by M1's release transition, M2 STILL does not misfire!
    engine.tick(
        20,
        Some(pad(&[PadButton::Back, PadButton::LS, PadButton::Up])),
        &mut sink,
    );
    assert_eq!(
        sink.events,
        vec![(OutputToken::Key1, false), (OutputToken::Space, false)]
    );
    sink.events.clear();

    // Once all latched buttons are released, M2 works cleanly when pressed fresh
    engine.tick(30, Some(PadState::default()), &mut sink);
    engine.tick(32, Some(pad(&m2_trig)), &mut sink);
    assert_eq!(sink.events, vec![(OutputToken::Key2, true)]);
}

#[test]
fn subset_debounce_20ms_chord_upgrade_and_fast_tap_flush() {
    let (m1_trig, _) = bridge_preset(0).unwrap(); // Back + LS + RS
    let mut profile = KeymapProfile {
        id: "sub".into(),
        name: "子集防抖与快点补发".into(),
        rules: vec![
            KeymapRule {
                id: "m1".into(),
                name: "M1".into(),
                enabled: true,
                rear_slot: Some(0),
                trigger: m1_trig.clone(),
                action: KeymapAction::Hold {
                    keys: vec![OutputToken::F1],
                },
            },
            KeymapRule {
                id: "back_map".into(),
                name: "地图".into(),
                enabled: true,
                rear_slot: None,
                trigger: vec![PadButton::Back],
                action: KeymapAction::Hold {
                    keys: vec![OutputToken::Tab],
                },
            },
        ],
    };
    profile.validate().unwrap();

    let mut sink = MockSink::default();
    let mut engine = KeymapEngine::new();
    engine.configure(&profile, 64, 16000, &mut sink);
    engine.tick(0, Some(PadState::default()), &mut sink);

    // Case 1: Fast tap (<20ms) on Back: pressed at 10ms, released at 20ms (10ms duration < 20ms)
    engine.tick(10, Some(pad(&[PadButton::Back])), &mut sink);
    assert!(sink.events.is_empty()); // waiting for 20ms prefix window

    // Released at 20ms (elapsed 10ms < 20ms) -> immediately flushes Tab Down on release!
    engine.tick(20, Some(PadState::default()), &mut sink);
    assert_eq!(sink.events, vec![(OutputToken::Tab, true)]);
    sink.events.clear();

    // After TAP_FLUSH_HOLD_MS (16ms -> t = 36ms), Tab Up is emitted cleanly
    engine.tick(36, Some(PadState::default()), &mut sink);
    assert_eq!(sink.events, vec![(OutputToken::Tab, false)]);
    sink.events.clear();

    // Case 2: Chord upgrade within 20ms: Back arrives at 50ms, LS+RS arrive at 58ms
    engine.tick(50, Some(pad(&[PadButton::Back])), &mut sink);
    assert!(sink.events.is_empty());
    engine.tick(58, Some(pad(&m1_trig)), &mut sink);
    assert_eq!(sink.events, vec![(OutputToken::F1, true)]);
    sink.events.clear();

    // Staggered release of M1 (RS lifts at 80ms, Back lifts at 90ms) never misfires Tab!
    engine.tick(
        80,
        Some(pad(&[PadButton::Back, PadButton::LS])),
        &mut sink,
    );
    assert_eq!(sink.events, vec![(OutputToken::F1, false)]);
    sink.events.clear();
    engine.tick(90, Some(PadState::default()), &mut sink);
    assert!(sink.events.is_empty());

    // Case 3: Sustained hold of Back >= 20ms activates Tab Hold
    engine.tick(100, Some(pad(&[PadButton::Back])), &mut sink);
    assert!(sink.events.is_empty());
    engine.tick(120, Some(pad(&[PadButton::Back])), &mut sink);
    assert_eq!(sink.events, vec![(OutputToken::Tab, true)]);
    sink.events.clear();
    engine.tick(150, Some(PadState::default()), &mut sink);
    assert_eq!(sink.events, vec![(OutputToken::Tab, false)]);
}

#[test]
fn macro_once_holdloop_toggleloop_and_wheel_pulse_semantics() {
    let mut profile = KeymapProfile {
        id: "macros".into(),
        name: "宏模式测试".into(),
        rules: vec![
            KeymapRule {
                id: "once".into(),
                name: "单次连招".into(),
                enabled: true,
                rear_slot: None,
                trigger: vec![PadButton::A],
                action: KeymapAction::Macro {
                    steps: vec![
                        KbStep {
                            keys: vec![OutputToken::Q],
                            hold_ms: 20,
                            gap_ms: 10,
                        },
                        KbStep {
                            keys: vec![OutputToken::WheelUp],
                            hold_ms: 0,
                            gap_ms: 10,
                        },
                        KbStep {
                            keys: vec![OutputToken::E],
                            hold_ms: 20,
                            gap_ms: 0,
                        },
                    ],
                    trigger_mode: KbTriggerMode::Once,
                    loop_ms: 0,
                },
            },
            KeymapRule {
                id: "hold_loop".into(),
                name: "按住连发".into(),
                enabled: true,
                rear_slot: None,
                trigger: vec![PadButton::B],
                action: KeymapAction::Macro {
                    steps: vec![KbStep {
                        keys: vec![OutputToken::MouseLeft],
                        hold_ms: 10,
                        gap_ms: 10,
                    }],
                    trigger_mode: KbTriggerMode::HoldLoop,
                    loop_ms: 0,
                },
            },
            KeymapRule {
                id: "toggle_loop".into(),
                name: "切换循环".into(),
                enabled: true,
                rear_slot: None,
                trigger: vec![PadButton::Y],
                action: KeymapAction::Macro {
                    steps: vec![KbStep {
                        keys: vec![OutputToken::R],
                        hold_ms: 15,
                        gap_ms: 15,
                    }],
                    trigger_mode: KbTriggerMode::ToggleLoop,
                    loop_ms: 10,
                },
            },
        ],
    };
    profile.validate().unwrap();

    let mut sink = MockSink::default();
    let mut engine = KeymapEngine::new();
    engine.configure(&profile, 64, 16000, &mut sink);
    engine.tick(0, Some(PadState::default()), &mut sink);

    // 1. Once macro continues even after A is released!
    engine.tick(2, Some(pad(&[PadButton::A])), &mut sink);
    engine.tick(6, Some(PadState::default()), &mut sink); // A released early
    for t in (8..=80).step_by(2) {
        engine.tick(t, Some(PadState::default()), &mut sink);
    }
    assert_eq!(
        sink.events,
        vec![
            (OutputToken::Q, true),
            (OutputToken::Q, false),
            // WheelUp is pulse-only: Down(true) once, NEVER Up(false)!
            (OutputToken::WheelUp, true),
            (OutputToken::E, true),
            (OutputToken::E, false),
        ]
    );
    sink.events.clear();

    // 2. HoldLoop repeats while B held, and immediately releases MouseLeft when B is released mid-hold!
    engine.tick(100, Some(pad(&[PadButton::B])), &mut sink); // MouseLeft Down (100..110)
    engine.tick(110, Some(pad(&[PadButton::B])), &mut sink); // MouseLeft Up, gap (110..120)
    engine.tick(120, Some(pad(&[PadButton::B])), &mut sink); // Cycle 2: MouseLeft Down (120..130)
    engine.tick(124, Some(PadState::default()), &mut sink); // Released mid-hold at 124ms!
    assert_eq!(
        sink.events,
        vec![
            (OutputToken::MouseLeft, true),
            (OutputToken::MouseLeft, false),
            (OutputToken::MouseLeft, true),
            (OutputToken::MouseLeft, false),
        ]
    );
    assert!(engine.held_tokens().is_empty());
    sink.events.clear();

    // 3. ToggleLoop starts on 1st press, continues after release, stops & releases on 2nd press!
    engine.tick(200, Some(pad(&[PadButton::Y])), &mut sink); // R Down (200..215)
    engine.tick(204, Some(PadState::default()), &mut sink); // Y released, macro keeps running
    engine.tick(216, Some(PadState::default()), &mut sink); // R Up, gap 15ms -> 230, loop_ms 10 -> 240
    engine.tick(232, Some(PadState::default()), &mut sink); // enter LoopWait
    engine.tick(242, Some(PadState::default()), &mut sink); // Cycle 2 starts: R Down!
    assert_eq!(
        sink.events,
        vec![
            (OutputToken::R, true),
            (OutputToken::R, false),
            (OutputToken::R, true),
        ]
    );
    sink.events.clear();
    // Second press of Y stops ToggleLoop immediately and releases R!
    engine.tick(246, Some(pad(&[PadButton::Y])), &mut sink);
    assert_eq!(sink.events, vec![(OutputToken::R, false)]);
    assert!(engine.active_rule_names().is_empty());
}

#[test]
fn neutral_frame_arming_f8_emergency_stop_and_disconnect_release() {
    let mut profile = KeymapProfile {
        id: "arm".into(),
        name: "安全解锁".into(),
        rules: vec![KeymapRule {
            id: "r1".into(),
            name: "开火".into(),
            enabled: true,
            rear_slot: None,
            trigger: vec![PadButton::RT],
            action: KeymapAction::Hold {
                keys: vec![OutputToken::MouseLeft],
            },
        }],
    };
    profile.validate().unwrap();

    let mut sink = MockSink::default();
    let mut engine = KeymapEngine::new();
    engine.configure(&profile, 64, 16000, &mut sink);

    // Holding RT before neutral frame MUST NOT fire!
    engine.tick(0, Some(pad(&[PadButton::RT])), &mut sink);
    engine.tick(10, Some(pad(&[PadButton::RT])), &mut sink);
    assert!(!engine.is_armed());
    assert!(sink.events.is_empty());

    // Neutral frame unlocks
    engine.tick(20, Some(PadState::default()), &mut sink);
    assert!(engine.is_armed());

    // Now RT fires
    engine.tick(24, Some(pad(&[PadButton::RT])), &mut sink);
    assert_eq!(sink.events, vec![(OutputToken::MouseLeft, true)]);
    sink.events.clear();

    // Disconnect releases all held keys and disarms
    engine.tick(30, None, &mut sink);
    assert_eq!(sink.events, vec![(OutputToken::MouseLeft, false)]);
    assert!(!engine.is_armed());
    sink.events.clear();

    // Reconnect while holding RT still waits for neutral frame, then F8 emergency_stop releases all
    engine.tick(40, Some(pad(&[PadButton::RT])), &mut sink);
    assert!(sink.events.is_empty());
    engine.tick(50, Some(PadState::default()), &mut sink);
    engine.tick(52, Some(pad(&[PadButton::RT])), &mut sink);
    assert_eq!(sink.events, vec![(OutputToken::MouseLeft, true)]);
    sink.events.clear();

    engine.emergency_stop(&mut sink);
    assert_eq!(sink.events, vec![(OutputToken::MouseLeft, false)]);
    assert!(!engine.is_armed());
}

#[test]
fn legacy_040_profile_import_and_validation_boundaries() {
    let legacy_json = r#"{
        "version": 1,
        "name": "老版本猎人配置",
        "mappings": {
            "A": "Space",
            "LX-": "0",
            "RB": "Shift"
        },
        "macros": {
            "X": [
                {"key": "Q", "hold_ms": 80, "after_ms": 40},
                {"key": "Ctrl", "hold_ms": 50, "after_ms": 0}
            ]
        },
        "mouse_enabled": false,
        "mouse_speed": 12,
        "mouse_deadzone": 8000
    }"#
    .as_bytes();
    let imported = import_keymap_profile(legacy_json).unwrap();
    assert_eq!(imported.name, "老版本猎人配置");
    assert_eq!(imported.rules.len(), 4);

    // Reject F8 in legacy and new JSON
    let bad_f8 = br#"{"version":1,"name":"bad","mappings":{"A":"F8"},"macros":{}}"#;
    assert!(import_keymap_profile(bad_f8).is_err());
    assert!(OutputToken::parse_str("F8").is_err());
    assert!(OutputToken::parse_str("f8").is_err());

    // Mixed wheel + normal key with hold_ms == 0 MUST be rejected (B6)
    let mut bad_mixed = KbStep {
        keys: vec![OutputToken::LCtrl, OutputToken::WheelUp],
        hold_ms: 0,
        gap_ms: 10,
    };
    assert!(bad_mixed.validate().is_err());

    // Pure wheel with hold_ms == 0 is valid; pure wait with gap_ms > 0 is valid
    let mut ok_wheel = KbStep {
        keys: vec![OutputToken::WheelDown],
        hold_ms: 0,
        gap_ms: 20,
    };
    assert!(ok_wheel.validate().is_ok());
    let mut ok_wait = KbStep {
        keys: vec![],
        hold_ms: 50,
        gap_ms: 0,
    };
    assert!(ok_wait.validate().is_ok());

    // KeymapStore never stores enabled: true on disk
    let store = KeymapStore::default_store();
    let serialized = serde_json::to_value(&store).unwrap();
    assert!(serialized.get("enabled").is_none());
}
