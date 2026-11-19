use async_trait::async_trait;
use oplus_core::{
    Result,
    keymap::{
        KbStep, KbTriggerMode, KeymapAction, KeymapRule, MAX_KEYMAP_BYTES, OutputToken, PadButton,
        import_keymap_profile,
    },
    model::{Record, Snapshot, SupportTier, desired_setting},
    storage,
    transaction::{
        Device, Edit, MAX_BACKUP_BYTES, apply, execute, pending, prepare, recovery_edits,
        undo_edits, validate_journal,
    },
};
use oplus_device::MacroRunner;
use serde_json::json;
use std::path::PathBuf;

struct FakeDevice {
    snapshot: Snapshot,
    writes: usize,
    stall_after_write: bool,
}

#[async_trait]
impl Device for FakeDevice {
    async fn snapshot(&mut self) -> Result<Snapshot> {
        Ok(self.snapshot.clone())
    }
    async fn read(&mut self, key: &str) -> Result<Vec<u8>> {
        self.snapshot.record(key)
    }
    async fn write(&mut self, key: &str, payload: &[u8]) -> Result<()> {
        self.writes += 1;
        self.snapshot
            .raw
            .insert(key.into(), Record::from_payload(payload)?);
        if self.stall_after_write {
            std::future::pending::<()>().await;
        }
        Ok(())
    }
}

struct TestDir(PathBuf);
impl TestDir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("oplus-v071-test-{}", storage::id()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn legacy_out_of_editor_range_curve_saves_and_restores_via_undo_and_recovery() {
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/snapshot.json");
    let mut snapshot: Snapshot = storage::read(&fixture, 128 * 1024).unwrap();
    let mut legacy_sticks = snapshot.record("sticks").unwrap();
    legacy_sticks[1] = 92; // inner=92, outer_raw=8 -> sum == 100 (legacy value outside editor <100 rule)
    legacy_sticks[3] = 0; // P1.x == 0 (legacy edge knot)
    snapshot.raw.insert(
        "sticks".into(),
        Record::from_payload(&legacy_sticks).unwrap(),
    );
    assert_eq!(snapshot.support_tier(), SupportTier::Verified);

    let target = desired_setting(
        &snapshot,
        "sticks",
        &json!({
            "side": 0,
            "inner": 6,
            "outer_raw": 8,
            "point1": [85, 85],
            "point2": [170, 170],
            "invert_x": false,
            "invert_y": false,
            "swap": false,
        }),
    )
    .unwrap();

    // Edge knots P1.x=0, P2.x=255, or P1.x==P2.x are rejected for new user edits
    for bad_pts in [json!([[0, 170], [170, 220]]), json!([[85, 85], [255, 220]]), json!([[120, 80], [120, 190]])] {
        assert!(
            desired_setting(
                &snapshot,
                "sticks",
                &json!({
                    "side": 0,
                    "inner": 6,
                    "outer_raw": 8,
                    "point1": bad_pts[0],
                    "point2": bad_pts[1],
                    "invert_x": false,
                    "invert_y": false,
                    "swap": false,
                }),
            )
            .is_err()
        );
    }

    let mut device = FakeDevice {
        snapshot,
        writes: 0,
        stall_after_write: false,
    };
    let root = TestDir::new();

    // 1. Save overwrites legacy 92 with 6
    let receipt = execute(
        &mut device,
        &root.0,
        "save",
        vec![Edit {
            key: "sticks".into(),
            expected: legacy_sticks.clone(),
            target: target.clone(),
        }],
    )
    .await
    .unwrap();
    assert_eq!(device.writes, 1);
    assert_eq!(device.snapshot.record("sticks").unwrap(), target);

    // 2. Undo faithfully restores legacy 92 bytes!
    let undone = execute(
        &mut device,
        &root.0,
        "undo",
        undo_edits(&receipt.journal).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(device.writes, 2);
    assert_eq!(undone.snapshot.record("sticks").unwrap(), legacy_sticks);

    // 3. Simulate crash mid-save and verify pending() + recovery_edits + recovery restore legacy 92!
    let (mut crash_journal, _) = prepare(
        &mut device,
        &root.0,
        "save",
        vec![Edit {
            key: "sticks".into(),
            expected: legacy_sticks.clone(),
            target: target.clone(),
        }],
    )
    .await
    .unwrap();
    crash_journal.state = "writing".into();
    crash_journal.records[0].attempted = true;
    crash_journal.records[0].state = "write_intent".into();
    crash_journal.persist(&root.0).unwrap();
    device.write("sticks", &target).await.unwrap();

    let found = pending(&root.0);
    assert_eq!(found.len(), 1);
    let rec_edits = recovery_edits(&root.0, &found[0], &device.snapshot).unwrap();
    assert_eq!(rec_edits.len(), 1);
    let recovered = execute(&mut device, &root.0, "recovery", rec_edits)
        .await
        .unwrap();
    assert_eq!(recovered.snapshot.record("sticks").unwrap(), legacy_sticks);
}

#[test]
fn large_macro_store_reloads_intact_and_corrupt_file_is_preserved_not_overwritten() {
    let root = TestDir::new();
    let runner = MacroRunner::new(root.0.clone());
    let mut store = runner.store();
    for index in 0..40 {
        store.profiles[0].rules.push(KeymapRule {
            id: format!("rule-{index}"),
            name: format!("Macro {index}"),
            enabled: false,
            rear_slot: None,
            trigger: vec![PadButton::A],
            action: KeymapAction::Macro {
                steps: vec![
                    KbStep {
                        keys: vec![OutputToken::A],
                        hold_ms: 100,
                        gap_ms: 100,
                    };
                    64
                ],
                trigger_mode: KbTriggerMode::Once,
                loop_ms: 0,
            },
        });
    }
    runner.update_store(store).unwrap();
    assert_eq!(runner.store().profiles[0].rules.len(), 40);
    runner.shutdown();

    let file = storage::keymap_path(&root.0);
    let raw_bytes = std::fs::read(&file).unwrap();
    assert!(raw_bytes.len() > 256 * 1024);
    assert!(raw_bytes.len() <= MAX_KEYMAP_BYTES);

    // Reloading preserves all 40 rules cleanly and import_keymap_profile accepts the large store too!
    let reloaded = MacroRunner::new(root.0.clone());
    assert!(reloaded.snapshot().load_error.is_none());
    assert_eq!(reloaded.store().profiles[0].rules.len(), 40);
    assert_eq!(import_keymap_profile(&raw_bytes).unwrap().rules.len(), 40);
    reloaded.shutdown();

    // Corrupt existing file -> startup reports load_error, leaves file untouched, and backs it up before save
    let corrupt_dir = TestDir::new();
    let corrupt_path = storage::keymap_path(&corrupt_dir.0);
    let broken_payload = b"{ broken json from manual edit ";
    std::fs::write(&corrupt_path, broken_payload).unwrap();

    let broken_runner = MacroRunner::new(corrupt_dir.0.clone());
    assert!(broken_runner.snapshot().load_error.is_some());
    assert_eq!(std::fs::read(&corrupt_path).unwrap(), broken_payload);

    let clean_store = broken_runner.store();
    let (_, after_save_snap) = broken_runner.update_store(clean_store).unwrap();
    assert!(after_save_snap.load_error.is_none());
    let backups: Vec<_> = std::fs::read_dir(&corrupt_dir.0)
        .unwrap()
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("keymap-profiles.unloaded-")
        })
        .collect();
    assert_eq!(backups.len(), 1);
    assert_eq!(std::fs::read(backups[0].path()).unwrap(), broken_payload);
    broken_runner.shutdown();
}

#[tokio::test]
async fn large_diagnostic_trace_is_stripped_from_backup_and_pending_finds_incomplete_write() {
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/snapshot.json");
    let mut snapshot: Snapshot = storage::read(&fixture, 128 * 1024).unwrap();
    let expected = snapshot.record("sticks").unwrap();
    let target = desired_setting(
        &snapshot,
        "sticks",
        &json!({
            "side": 0,
            "inner": 8,
            "outer_raw": 8,
            "point1": [85, 85],
            "point2": [170, 170],
            "invert_x": false,
            "invert_y": false,
            "swap": false,
        }),
    )
    .unwrap();
    let trace = vec![
        json!({
            "direction": "rx",
            "opcode": 0x19,
            "serial": 0,
            "payload": "00".repeat(16),
            "wire": "00".repeat(20),
        });
        800
    ];
    snapshot.extra.insert("trace".into(), json!(trace));
    assert_eq!(snapshot.support_tier(), SupportTier::Verified);

    let mut device = FakeDevice {
        snapshot,
        writes: 0,
        stall_after_write: true,
    };
    let root = TestDir::new();
    let (mut journal, snap_returned) = prepare(
        &mut device,
        &root.0,
        "save",
        vec![Edit {
            key: "sticks".into(),
            expected: expected.clone(),
            target,
        }],
    )
    .await
    .unwrap();
    // Diagnostic trace remains available on returned snapshot while disk backup is compact
    assert!(snap_returned.extra.contains_key("trace"));
    let length = std::fs::metadata(root.0.join(&journal.backup)).unwrap().len();
    assert!((length as usize) <= MAX_BACKUP_BYTES);

    let applied = tokio::time::timeout(
        std::time::Duration::from_millis(50),
        apply(&mut device, &root.0, &mut journal),
    )
    .await;
    assert!(applied.is_err());
    assert_eq!(device.writes, 1);
    assert_eq!(journal.state, "writing");

    assert!(validate_journal(&root.0, &journal).is_ok());
    let pending_list = pending(&root.0);
    assert_eq!(pending_list.len(), 1);
    assert_eq!(pending_list[0].id, journal.id);

    device.stall_after_write = false;
    let edits = recovery_edits(&root.0, &pending_list[0], &device.snapshot).unwrap();
    let recovered = execute(&mut device, &root.0, "recovery", edits).await.unwrap();
    assert_eq!(recovered.snapshot.record("sticks").unwrap(), expected);
}
