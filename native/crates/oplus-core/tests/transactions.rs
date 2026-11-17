use async_trait::async_trait;
use oplus_core::{Result, model::*, storage, transaction::*};
use std::collections::BTreeMap;
fn fixture() -> Snapshot {
    serde_json::from_str(include_str!("../../../fixtures/snapshot.json")).unwrap()
}
struct Mock {
    snapshot: Snapshot,
    writes: Vec<String>,
    fail_at: Option<usize>,
    corrupt_read: bool,
}
impl Mock {
    fn new() -> Self {
        Self {
            snapshot: fixture(),
            writes: vec![],
            fail_at: None,
            corrupt_read: false,
        }
    }
}
#[async_trait]
impl Device for Mock {
    async fn snapshot(&mut self) -> Result<Snapshot> {
        Ok(self.snapshot.clone())
    }
    async fn read(&mut self, key: &str) -> Result<Vec<u8>> {
        if self.corrupt_read {
            self.corrupt_read = false;
            return Ok(vec![0]);
        }
        self.snapshot.record(key)
    }
    async fn write(&mut self, key: &str, p: &[u8]) -> Result<()> {
        self.writes.push(key.into());
        self.snapshot
            .raw
            .insert(key.into(), Record::from_payload(p)?);
        if self.fail_at == Some(self.writes.len()) {
            return Err("fragment timeout after device changed".into());
        }
        Ok(())
    }
}
fn edits(s: &Snapshot) -> Vec<Edit> {
    (0..3)
        .map(|i| Edit {
            key: format!("macro_{i}"),
            expected: s.record(&format!("macro_{i}")).unwrap(),
            target: Change::Hold { keys: vec![1] }.encode(s).unwrap(),
        })
        .collect()
}
#[test]
fn python_macro_goldens_and_original_forms() {
    let s = fixture();
    let rows: serde_json::Value =
        serde_json::from_str(include_str!("../../../fixtures/macros.json")).unwrap();
    for row in rows.as_array().unwrap() {
        let c: Change = serde_json::from_value(row["change"].clone()).unwrap();
        assert_eq!(
            hex::encode(c.encode(&s).unwrap()),
            row["payload"].as_str().unwrap()
        );
    }
    for i in 0..6 {
        assert_eq!(
            form(&s, i).unwrap().encode(&s).unwrap(),
            s.record(&format!("macro_{i}")).unwrap()
        );
    }
}
#[test]
fn profile_compatibility_and_all_or_nothing() {
    let s = fixture();
    let p = profile(&s, &BTreeMap::new()).unwrap();
    let mut bom = vec![239, 187, 191];
    bom.extend(serde_json::to_vec(&p).unwrap());
    assert!(import_profile(&bom, &s).unwrap().is_empty());
    assert!(
        import_profile(&serde_json::to_vec(&s).unwrap(), &s)
            .unwrap()
            .is_empty()
    );
    let mut bad = p;
    bad["slots"][5]["slot"] = 0.into();
    assert!(import_profile(&serde_json::to_vec(&bad).unwrap(), &s).is_err());
}
#[test]
fn settings_preserve_unknown_bytes() {
    let s = fixture();
    let original = s.record("motors").unwrap();
    let p = desired_setting(&s, "motors", &serde_json::json!({"levels":[50,30,0,100]})).unwrap();
    assert_eq!(&p[5..], &original[5..]);
    assert_eq!(p[1], 128);
    let mut bad = p.clone();
    bad[5] ^= 1;
    assert!(boundary(&s, "motors", &original, &bad).is_err());
    let light = s.record("lighting").unwrap();
    let p = desired_setting(
        &s,
        "lighting",
        &serde_json::json!({"zone":1,"rgb":"#123456"}),
    )
    .unwrap();
    assert_eq!(&p[7..10], &[18, 52, 86]);
    for i in 0..25 {
        if !(7..10).contains(&i) {
            assert_eq!(p[i], light[i]);
        }
    }
    assert!(
        desired_setting(
            &s,
            "lighting",
            &serde_json::json!({"zone":2,"rgb":"#ffffff"})
        )
        .is_err()
    );
}
#[tokio::test]
async fn conflict_and_backup_failure_do_not_write() {
    let mut m = Mock::new();
    let dir = tempfile::tempdir().unwrap();
    let mut e = edits(&m.snapshot);
    e[2].expected[3] ^= 1;
    assert!(execute(&mut m, dir.path(), "save", e).await.is_err());
    assert!(m.writes.is_empty());
    let file = dir.path().join("not-directory");
    std::fs::write(&file, "x").unwrap();
    assert!(
        execute(&mut m, &file, "save", edits(&fixture()))
            .await
            .is_err()
    );
    assert!(m.writes.is_empty());
}
#[tokio::test]
async fn partial_write_restores_all_attempts_in_reverse() {
    for at in 1..=3 {
        let mut m = Mock::new();
        m.fail_at = Some(at);
        let dir = tempfile::tempdir().unwrap();
        assert!(
            execute(&mut m, dir.path(), "save", edits(&fixture()))
                .await
                .is_err()
        );
        for i in 0..6 {
            assert_eq!(
                m.snapshot.record(&format!("macro_{i}")).unwrap(),
                fixture().record(&format!("macro_{i}")).unwrap()
            );
        }
        assert_eq!(
            &m.writes[at..],
            (0..at)
                .rev()
                .map(|i| format!("macro_{i}"))
                .collect::<Vec<_>>()
        );
        assert!(pending(dir.path()).is_empty());
    }
}
#[tokio::test]
async fn readback_failure_restores_and_undo_is_transactional() {
    let mut m = Mock::new();
    m.corrupt_read = true;
    let dir = tempfile::tempdir().unwrap();
    assert!(
        execute(&mut m, dir.path(), "save", edits(&fixture()))
            .await
            .is_err()
    );
    let receipt = execute(&mut m, dir.path(), "save", edits(&fixture()))
        .await
        .unwrap();
    let before = m.snapshot.clone();
    m.fail_at = Some(m.writes.len() + 2);
    assert!(
        execute(
            &mut m,
            dir.path(),
            "undo",
            undo_edits(&receipt.journal).unwrap()
        )
        .await
        .is_err()
    );
    for i in 0..6 {
        assert_eq!(
            m.snapshot.record(&format!("macro_{i}")).unwrap(),
            before.record(&format!("macro_{i}")).unwrap()
        );
    }
}
#[tokio::test]
async fn crash_recovery_is_explicit_and_rejects_unknown() {
    let mut m = Mock::new();
    let dir = tempfile::tempdir().unwrap();
    let (mut j, _) = prepare(&mut m, dir.path(), "save", edits(&fixture()))
        .await
        .unwrap();
    j.records[0].attempted = true;
    j.records[0].state = "write_intent".into();
    j.persist(dir.path()).unwrap();
    m.write("macro_0", &j.records[0].target).await.unwrap();
    let calls = m.writes.len();
    let journals = pending(dir.path());
    assert_eq!(journals.len(), 1);
    assert_eq!(m.writes.len(), calls);
    let recovery = recovery_edits(dir.path(), &journals[0], &m.snapshot).unwrap();
    assert_eq!(recovery.len(), 1);
    m.snapshot.raw.insert(
        "macro_0".into(),
        Record::from_payload(&Change::Hold { keys: vec![2] }.encode(&fixture()).unwrap()).unwrap(),
    );
    assert!(recovery_edits(dir.path(), &j, &m.snapshot).is_err());
    assert!(!j.terminal());
    assert_eq!(j.records[0].state, "write_intent");
}
#[tokio::test]
async fn completed_commit_failure_rolls_back_even_verified() {
    let mut m = Mock::new();
    let dir = tempfile::tempdir().unwrap();
    let (mut j, _) = prepare(&mut m, dir.path(), "save", edits(&fixture()))
        .await
        .unwrap();
    apply(&mut m, dir.path(), &mut j).await.unwrap();
    assert!(j.records.iter().all(|e| e.attempted));
    assert!(rollback(&mut m, dir.path(), &mut j).await);
    assert_eq!(
        m.snapshot.record("macro_0").unwrap(),
        fixture().record("macro_0").unwrap()
    );
    storage::save(&dir.path().join("atomic.json"), &1).unwrap();
    storage::save(&dir.path().join("atomic.json"), &2).unwrap();
    assert_eq!(
        storage::read::<u8>(&dir.path().join("atomic.json"), 10).unwrap(),
        2
    );
}

#[tokio::test]
async fn compatible_firmware_142_writes_and_recovers_crash_journals() {
    let mut m = Mock::new();
    m.snapshot.identity.version_display = "1.42".into();
    assert_eq!(m.snapshot.support_tier(), SupportTier::Compatible);
    assert_eq!(m.snapshot.preset().len(), 6);

    let dir = tempfile::tempdir().unwrap();
    let e = vec![Edit {
        key: "macro_0".into(),
        expected: m.snapshot.record("macro_0").unwrap(),
        target: Change::Hold {
            keys: vec![93, 11, 12],
        }
        .encode_for_slot(&m.snapshot, 0)
        .unwrap(),
    }];
    let (mut j, _) = prepare(&mut m, dir.path(), "save", e).await.unwrap();
    j.records[0].attempted = true;
    j.records[0].state = "write_intent".into();
    j.persist(dir.path()).unwrap();
    m.write("macro_0", &j.records[0].target).await.unwrap();

    let found = pending(dir.path());
    assert_eq!(found.len(), 1);
    let rec_edits = recovery_edits(dir.path(), &found[0], &m.snapshot).unwrap();
    assert_eq!(rec_edits.len(), 1);
    let receipt = execute(&mut m, dir.path(), "recovery", rec_edits)
        .await
        .unwrap();
    assert_eq!(
        receipt.snapshot.record("macro_0").unwrap(),
        fixture().record("macro_0").unwrap()
    );
}

#[tokio::test]
async fn non_16_key_remapping_zero_readback_normalizes_dynamically() {
    struct ZeroRemapMock {
        snapshot: Snapshot,
    }
    #[async_trait]
    impl Device for ZeroRemapMock {
        async fn snapshot(&mut self) -> Result<Snapshot> {
            Ok(self.snapshot.clone())
        }
        async fn read(&mut self, key: &str) -> Result<Vec<u8>> {
            let p = self.snapshot.record(key)?;
            // Simulate hardware returning compact [0] when all remaps are cleared
            if key == "remapping" && p.iter().skip(1).all(|&b| b == 0) {
                return Ok(vec![0]);
            }
            Ok(p)
        }
        async fn write(&mut self, key: &str, p: &[u8]) -> Result<()> {
            self.snapshot
                .raw
                .insert(key.into(), Record::from_payload(p)?);
            Ok(())
        }
    }

    let mut s = fixture();
    s.identity.version_display = "1.50".into();
    // 10-key remap table instead of 16
    s.decoded["remap_keys"] = serde_json::json!([1, 2, 3, 4, 5, 6, 11, 12, 13, 14]);
    s.raw
        .insert("remapping".into(), Record::new(&[0u8; 10]));
    assert_eq!(s.support_tier(), SupportTier::Compatible);

    let target =
        desired_setting(&s, "remapping", &serde_json::json!({"source": 1, "target": 2})).unwrap();
    assert_eq!(target.len(), 11);
    let expected = s.record("remapping").unwrap();

    let mut dev = ZeroRemapMock { snapshot: s };
    let dir = tempfile::tempdir().unwrap();
    let saved = execute(
        &mut dev,
        dir.path(),
        "save",
        vec![Edit {
            key: "remapping".into(),
            expected,
            target,
        }],
    )
    .await
    .unwrap();

    // Undo writes all zeros [10, 0..0] and device reads back [0], which normalize_against must accept!
    let undone = execute(
        &mut dev,
        dir.path(),
        "undo",
        undo_edits(&saved.journal).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(undone.journal.state, "completed");
}

#[test]
fn four_slot_eight_slot_dynamic_limits_and_select_list() {
    // 4-slot pad with D8.bit1 (macro limits) and D6.bit1 (remap select list)
    let mut s4 = fixture();
    s4.identity.pid = "2002".into();
    // capabilities: macros=0x0F (4 slots), changekey=0x03 (D6.bit1=1), engine=0x02 (D8.bit1=1)
    s4.capabilities = Record::new(&[3, 3, 15, 0, 0x0f, 0x03, 11, 0x02, 192, 0]);
    s4.raw.remove("macro_4");
    s4.raw.remove("macro_5");
    s4.decoded["macro_limits"] = serde_json::json!([47, 8, 42, 42, 0, 0, 0, 0]);
    s4.decoded["remap_targets"] = serde_json::json!([1, 2, 93, 94]);
    assert_eq!(s4.support_tier(), SupportTier::Compatible);
    assert_eq!(s4.active_slots(), vec![0, 1, 2, 3]);
    assert_eq!(s4.slot_step_limit(0), 47);
    assert_eq!(s4.slot_step_limit(1), 8);

    // 45 steps (23 groups of hold/gap -> 45 steps) succeeds on slot 0 (limit 47) and fails on slot 1 (limit 8)
    let long_seq = (0..22)
        .map(|_| "A:10/10")
        .chain(std::iter::once("B:10/0"))
        .collect::<Vec<_>>()
        .join(", ");
    let long_macro = Change::Macro {
        sequence: long_seq,
        loop_ms: 0,
        trigger: 0,
    };
    assert!(long_macro.encode_for_slot(&s4, 0).is_ok());
    assert!(long_macro.encode_for_slot(&s4, 1).is_err());

    // Remap target restricted by kind 7 remap_targets
    assert!(
        desired_setting(&s4, "remapping", &serde_json::json!({"source": 1, "target": 2})).is_ok()
    );
    assert!(
        desired_setting(&s4, "remapping", &serde_json::json!({"source": 1, "target": 5})).is_err()
    );

    // 8-slot pad (0xFF)
    let mut s8 = fixture();
    s8.identity.pid = "2008".into();
    s8.capabilities = Record::new(&[3, 3, 15, 0, 0xff, 1, 11, 0, 192, 0]);
    let sample = s8.raw["macro_0"].clone();
    s8.raw.insert("macro_6".into(), sample.clone());
    s8.raw.insert("macro_7".into(), sample);
    assert_eq!(s8.support_tier(), SupportTier::Compatible);
    assert_eq!(s8.active_slots(), vec![0, 1, 2, 3, 4, 5, 6, 7]);
    assert_eq!(s8.preset().get(&6).map(String::as_str), Some("ML"));
    assert_eq!(s8.preset().get(&7).map(String::as_str), Some("MR"));
}

#[test]
fn cross_firmware_reordered_macro_keys_hold_import_and_zero_changekey() {
    // Source pad has reversed digital macro keys + extended unknown key 200
    let mut src = fixture();
    src.identity.version_display = "1.20".into();
    src.decoded["macro_keys"] =
        serde_json::json!([1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 15, 16, 93, 94, 200, 18]);
    let src_layout = Layout::new(&src.keys("macro_keys").unwrap()).unwrap();
    // Verify extended key roundtrip KEY_200
    let ext_mask = src_layout.mask(&["KEY_200", "A"]).unwrap();
    assert_eq!(src_layout.names(ext_mask), vec!["A", "KEY_200"]);

    // Slot 0 in src is Hold(Back + LS + RS = [93, 11, 12], duration_ms == 0!)
    for slot in 0..6 {
        let p = Change::Hold { keys: vec![1] }.encode(&src).unwrap();
        src.raw
            .insert(format!("macro_{slot}"), Record::from_payload(&p).unwrap());
    }
    let bridge_src = Change::Hold {
        keys: vec![93, 11, 12],
    }
    .encode_for_slot(&src, 0)
    .unwrap();
    src.raw
        .insert("macro_0".into(), Record::from_payload(&bridge_src).unwrap());
    let seq_src = Change::Macro {
        sequence: "A+LS_UP:50/25, B:30/0".into(),
        loop_ms: 100,
        trigger: 1,
    }
    .encode_for_slot(&src, 1)
    .unwrap();
    src.raw
        .insert("macro_1".into(), Record::from_payload(&seq_src).unwrap());

    let exported = serde_json::to_vec(&profile(&src, &BTreeMap::new()).unwrap()).unwrap();

    // Target pad is standard O+ 1.37 WITHOUT changekey (`caps.changekey = 0` and no `remap_keys`)
    let mut dst = fixture();
    dst.identity.version_display = "1.45".into();
    dst.capabilities = Record::new(&[3, 3, 15, 0, 63, 0, 11, 0, 192, 0]);
    dst.decoded.as_object_mut().unwrap().remove("remap_keys");
    dst.raw.remove("remap_keys");
    dst.raw.remove("remapping");
    assert_eq!(dst.support_tier(), SupportTier::Compatible);

    // Direct Hold encoding works even when caps.changekey == 0!
    let expected_bridge_dst = Change::Hold {
        keys: vec![93, 11, 12],
    }
    .encode_for_slot(&dst, 0)
    .unwrap();

    let imported = import_profile(&exported, &dst).unwrap();
    let slot0_imported = imported.get(&0).unwrap().encode_for_slot(&dst, 0).unwrap();
    assert_eq!(slot0_imported, expected_bridge_dst);
    // Verify slot 0 was preserved as Hold (duration_ms == 0)
    let parsed0 = Program::parse(&slot0_imported, &dst.layout().unwrap()).unwrap();
    assert_eq!(parsed0.steps.len(), 1);
    assert_eq!(parsed0.steps[0].duration_ms, 0);

    // Verify slot 1 sequence + analog stick + loop_ms + trigger translated accurately
    let expected_seq_dst = Change::Macro {
        sequence: "A+LS_UP:50/25, B:30/0".into(),
        loop_ms: 100,
        trigger: 1,
    }
    .encode_for_slot(&dst, 1)
    .unwrap();
    let slot1_imported = imported.get(&1).unwrap().encode_for_slot(&dst, 1).unwrap();
    assert_eq!(slot1_imported, expected_seq_dst);
}

#[test]
fn motor_rounding_invariance_and_select_start_remap_guard() {
    let mut s = fixture();
    s.identity.version_display = "1.40".into();
    // Only channels 0 and 1 enabled (motors = 0x03); raw channel bytes have non-exact % values (0x20 = 32)
    s.capabilities = Record::new(&[3, 3, 0x03, 0, 63, 1, 11, 0, 192, 0]);
    s.raw.insert(
        "motors".into(),
        Record::new(&[0x20, 0x20, 0x20, 0x20, 0xaa, 0xbb, 0xcc, 0xdd]),
    );
    let orig = s.record("motors").unwrap();

    // Updating only channel 0 leaves channel 1 (0x20) and disabled channels 2,3 (0x20) + tail 100% untouched!
    let updated_ch0 =
        desired_setting(&s, "motors", &serde_json::json!({"channel": 0, "level": 50})).unwrap();
    assert_eq!(updated_ch0[1], 128);
    assert_eq!(&updated_ch0[2..], &orig[2..]);

    // Array update ignores disabled channels 2 and 3 instead of rounding/modifying them!
    let updated_arr = desired_setting(
        &s,
        "motors",
        &serde_json::json!({"levels": [100, 100, 99, 99]}),
    )
    .unwrap();
    assert_eq!(updated_arr[3], 0x20);
    assert_eq!(updated_arr[4], 0x20);
    assert_eq!(&updated_arr[5..], &orig[5..]);

    // SELECT(93) and START(94) forbidden as new non-zero remap source, allowed to reset to default
    assert!(
        desired_setting(&s, "remapping", &serde_json::json!({"source": 93, "target": 1})).is_err()
    );
    assert!(
        desired_setting(&s, "remapping", &serde_json::json!({"source": 94, "target": 2})).is_err()
    );
    assert!(
        desired_setting(
            &s,
            "remapping",
            &serde_json::json!({"source": 93, "target": 93})
        )
        .is_ok()
    );
    // Allowed as target for another button!
    assert!(
        desired_setting(&s, "remapping", &serde_json::json!({"source": 11, "target": 93})).is_ok()
    );
}

#[tokio::test]
async fn readonly_degradation_blocks_writes_and_exports_diagnostics() {
    let mut m = Mock::new();
    // Mode 7 on generation 2 => effective_generation == 1 => ReadOnly
    m.snapshot.identity.mode = 7;
    assert_eq!(m.snapshot.support_tier(), SupportTier::ReadOnly);

    let bundle = diagnostic_bundle(&m.snapshot);
    assert_eq!(bundle["support_tier"], "read_only");
    assert_eq!(bundle["effective_generation"], 1);

    let dir = tempfile::tempdir().unwrap();
    let e = vec![Edit {
        key: "motors".into(),
        expected: m.snapshot.record("motors").unwrap(),
        target: m.snapshot.record("motors").unwrap(),
    }];
    assert!(prepare(&mut m, dir.path(), "save", e).await.is_err());
    assert!(m.writes.is_empty());
}
