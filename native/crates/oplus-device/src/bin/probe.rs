use oplus_core::{
    keymap::bridge_preset,
    model::{Change, Snapshot, SupportTier, desired_setting, diagnostic_bundle},
    storage,
    transaction::{self, Device, Edit},
};
use oplus_device::{Lease, Session};
use serde_json::json;
use std::path::Path;

#[tokio::main]
async fn main() {
    if let Err(e) = run().await {
        eprintln!("{e}");
        std::process::exit(1);
    }
}

fn verify_against_baseline(label: &str, snap: &Snapshot, baseline: &Snapshot) -> oplus_core::Result<()> {
    if snap.address != baseline.address {
        return Err(format!(
            "{label}: address mismatch ({} vs {})",
            snap.address, baseline.address
        ));
    }
    if snap.identity != baseline.identity {
        return Err(format!(
            "{label}: identity mismatch ({:?} vs {:?})",
            snap.identity, baseline.identity
        ));
    }
    if snap.capabilities.payload()? != baseline.capabilities.payload()? {
        return Err(format!("{label}: capabilities payload mismatch"));
    }
    for (key, base_rec) in &baseline.raw {
        let got = snap
            .raw
            .get(key)
            .ok_or_else(|| format!("{label}: missing raw record {key}"))?
            .payload()?;
        let exp = base_rec.payload()?;
        if got != exp {
            return Err(format!(
                "{label}: record {key} byte mismatch (got {}, expected {})",
                hex::encode(&got),
                hex::encode(&exp)
            ));
        }
    }
    Ok(())
}

fn mask_mac(addr: &str) -> String {
    let parts: Vec<&str> = addr.split(':').collect();
    if parts.len() == 6 {
        format!(
            "{}:{}:{}:XX:XX:XX",
            parts[0].to_uppercase(),
            parts[1].to_uppercase(),
            parts[2].to_uppercase()
        )
    } else {
        "98:B6:ED:XX:XX:XX".into()
    }
}

fn sanitize_snapshot(mut s: Snapshot) -> Snapshot {
    s.address = mask_mac(&s.address);
    if let Some(obj) = s.decoded.as_object_mut() {
        if obj.contains_key("device_name") {
            obj.insert("device_name".into(), json!("致动O+_XXXXXX"));
        }
    }
    s.extra.remove("trace");
    s
}

fn sanitize_journal(mut j: transaction::Journal) -> transaction::Journal {
    j.address = mask_mac(&j.address);
    j
}

async fn run() -> oplus_core::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let root = storage::data_dir();
    let _lease = Lease::acquire(&root)?;
    let cmd = args
        .get(1)
        .map(String::as_str)
        .ok_or("用法：probe scan | read ADDR OUT | diagnose ADDR OUT | roundtrip ADDR OUT | roundtrip06 ADDR BASELINE OUT | roundtrip07 ADDR_OR_SCAN BASELINE OUT")?;

    if cmd == "scan" {
        println!(
            "{}",
            serde_json::to_string_pretty(&oplus_device::scan().await?).unwrap()
        );
        return Ok(());
    }

    let raw_addr = args.get(2).ok_or("缺少蓝牙地址参数（或使用 scan 自动定位）")?;
    let address = if raw_addr.eq_ignore_ascii_case("scan") {
        let candidates = oplus_device::scan().await?;
        candidates
            .into_iter()
            .find(|c| c.confirmed_service || c.likely)
            .map(|c| c.address)
            .ok_or("扫描未发现致动 / KeyLinker 手柄，请确认手柄已开机且已退出手机 App")?
    } else {
        raw_addr.clone()
    };
    let mut session = Session::connect(&address).await?;
    let result = async {
        match cmd {
            "read" => {
                let output = args.get(3).ok_or("缺少输出文件路径")?;
                let snap = session.snapshot().await?;
                storage::save(Path::new(output), &snap)?;
            }
            "diagnose" => {
                let output = args.get(3).ok_or("缺少输出文件路径")?;
                let snap = session.snapshot().await?;
                let bundle = diagnostic_bundle(&snap);
                storage::save(Path::new(output), &bundle)?;
                println!(
                    "diagnose ok: tier={:?}, device_name={}",
                    snap.support_tier(),
                    bundle["device_name"]
                );
            }
            "roundtrip" => {
                let output = args.get(3).ok_or("缺少输出文件路径")?;
                let before = session.snapshot().await?;
                let mut receipts = vec![];
                let mut targets = vec![(
                    "macro_0".to_string(),
                    Change::Hold { keys: vec![1] }.encode_for_slot(&before, 0)?,
                )];
                targets.push((
                    "macro_1".into(),
                    Change::Macro {
                        sequence: "A:50/50, B:50/0".into(),
                        loop_ms: 0,
                        trigger: 0,
                    }
                    .encode_for_slot(&before, 1)?,
                ));
                let mut m = before.record("motors")?;
                m[1] = m[1].saturating_sub(1);
                targets.push(("motors".into(), m));
                targets.push((
                    "remapping".into(),
                    desired_setting(
                        &before,
                        "remapping",
                        &json!({"source": 12, "target": 11}),
                    )?,
                ));
                let mut l = before.record("lighting")?;
                l[1] ^= 1;
                targets.push(("lighting".into(), l));
                for (key, target) in targets {
                    let expected = before.record(&key)?;
                    let r = transaction::execute(
                        &mut session,
                        &root,
                        "validation",
                        vec![Edit {
                            key: key.clone(),
                            expected,
                            target,
                        }],
                    )
                    .await?;
                    let undo = transaction::execute(
                        &mut session,
                        &root,
                        "undo",
                        transaction::undo_edits(&r.journal)?,
                    )
                    .await?;
                    receipts.push(json!({"key": key, "save": r.journal, "undo": undo.journal}));
                }
                let after = session.snapshot().await?;
                for (key, r) in &before.raw {
                    if key == "remapping" {
                        continue;
                    }
                    if after.record(key)? != r.payload()? {
                        return Err(format!("最终 {key} 未恢复"));
                    }
                }
                storage::save(
                    Path::new(output),
                    &json!({"before": before, "after": after, "transactions": receipts, "restored": true}),
                )?;
            }
            "roundtrip06" => {
                let baseline_path = args.get(3).ok_or("缺少预检基线文件路径")?;
                let output = args.get(4).ok_or("缺少输出文件路径")?;
                let baseline: Snapshot = storage::read(Path::new(baseline_path), 512 * 1024)?;

                let before = session.snapshot().await?;
                if before.support_tier() != SupportTier::Verified {
                    return Err(format!(
                        "预期实机识别为 Verified，实际为 {:?}",
                        before.support_tier()
                    ));
                }
                verify_against_baseline("before", &before, &baseline)?;

                // Write default M1 bridge chord: Back + LS + RS ([93, 11, 12])
                let (_, bridge_keys) = bridge_preset(0).unwrap();
                let target = Change::Hold { keys: bridge_keys }.encode_for_slot(&before, 0)?;
                let expected = before.record("macro_0")?;
                let save_receipt = transaction::execute(
                    &mut session,
                    &root,
                    "validation",
                    vec![Edit {
                        key: "macro_0".into(),
                        expected,
                        target: target.clone(),
                    }],
                )
                .await?;
                if save_receipt.snapshot.record("macro_0")? != target {
                    return Err("写入 M1 暗号后快照不匹配".into());
                }

                // Undo via transactional rollback-undo
                let undo_receipt = transaction::execute(
                    &mut session,
                    &root,
                    "undo",
                    transaction::undo_edits(&save_receipt.journal)?,
                )
                .await?;

                // Independent full snapshot read & 100% byte-for-byte comparison against baseline
                let after = session.snapshot().await?;
                verify_against_baseline("after", &after, &baseline)?;

                let report = json!({
                    "app_version": "0.6.0",
                    "support_tier": after.support_tier(),
                    "device_name": after.decoded.get("device_name"),
                    "baseline_records_verified": baseline.raw.len(),
                    "byte_identical_to_preflight_baseline": true,
                    "m1_bridge_target_hex": oplus_core::model::hex_spaced(&target),
                    "save_journal": save_receipt.journal,
                    "undo_journal": undo_receipt.journal,
                    "before": before,
                    "after": after,
                });
                storage::save(Path::new(output), &report)?;
                println!(
                    "roundtrip06 ok: {} baseline records verified 100% byte-identical!",
                    baseline.raw.len()
                );
            }
            "roundtrip07" => {
                let baseline_path = args.get(3).ok_or("缺少预检基线文件路径")?;
                let output = args.get(4).ok_or("缺少输出文件路径")?;
                let baseline: Snapshot = storage::read(Path::new(baseline_path), 512 * 1024)?;

                let before = session.snapshot().await?;
                if before.support_tier() != SupportTier::Verified {
                    return Err(format!(
                        "预期实机识别为 Verified，实际为 {:?}",
                        before.support_tier()
                    ));
                }
                verify_against_baseline("before", &before, &baseline)?;

                // 1. Live Hardware Roundtrip 1: WRITE_STICK (0x31) — Left stick inner_deadzone 6 -> 8 -> undo -> 6
                let sticks_orig = before.record("sticks")?;
                if sticks_orig.len() != 15 || sticks_orig[1] != 6 {
                    return Err(format!(
                        "预期基线左摇杆 inner_deadzone 为 6，实际记录为 {}",
                        oplus_core::model::hex_spaced(&sticks_orig)
                    ));
                }
                let sticks_target = desired_setting(
                    &before,
                    "sticks",
                    &json!({
                        "side": 0,
                        "inner": 8,
                        "outer_raw": sticks_orig[2],
                        "point1": [sticks_orig[3], sticks_orig[4]],
                        "point2": [sticks_orig[5], sticks_orig[6]],
                        "invert_x": (sticks_orig[7] & 0x01) != 0,
                        "invert_y": (sticks_orig[7] & 0x02) != 0,
                        "swap": (sticks_orig[7] & 0x04) != 0,
                    }),
                )?;
                if sticks_target[1] != 8 || sticks_target[2..] != sticks_orig[2..] {
                    return Err("左摇杆目标负载构造异常".into());
                }
                let sticks_save = transaction::execute(
                    &mut session,
                    &root,
                    "validation",
                    vec![Edit {
                        key: "sticks".into(),
                        expected: sticks_orig.clone(),
                        target: sticks_target.clone(),
                    }],
                )
                .await?;
                if sticks_save.snapshot.record("sticks")? != sticks_target {
                    return Err("写入左摇杆死区 8 后快照核对不一致".into());
                }
                let sticks_undo = transaction::execute(
                    &mut session,
                    &root,
                    "undo",
                    transaction::undo_edits(&sticks_save.journal)?,
                )
                .await?;
                if sticks_undo.snapshot.record("sticks")? != sticks_orig {
                    return Err("撤销左摇杆死区恢复 6 后快照核对不一致".into());
                }

                // 2. Live Hardware Roundtrip 2: WRITE_TRIGGER (0x32) — Left trigger inner_deadzone 4 -> 6 -> undo -> 4
                let triggers_orig = sticks_undo.snapshot.record("triggers")?;
                if triggers_orig.len() != 15 || triggers_orig[1] != 4 {
                    return Err(format!(
                        "预期基线左扳机 inner_deadzone 为 4，实际记录为 {}",
                        oplus_core::model::hex_spaced(&triggers_orig)
                    ));
                }
                let triggers_target = desired_setting(
                    &sticks_undo.snapshot,
                    "triggers",
                    &json!({
                        "side": 0,
                        "inner": 6,
                        "outer_raw": triggers_orig[2],
                        "point1": [triggers_orig[3], triggers_orig[4]],
                        "point2": [triggers_orig[5], triggers_orig[6]],
                    }),
                )?;
                if triggers_target[1] != 6 || triggers_target[2..] != triggers_orig[2..] {
                    return Err("左扳机目标负载构造异常".into());
                }
                let triggers_save = transaction::execute(
                    &mut session,
                    &root,
                    "validation",
                    vec![Edit {
                        key: "triggers".into(),
                        expected: triggers_orig.clone(),
                        target: triggers_target.clone(),
                    }],
                )
                .await?;
                if triggers_save.snapshot.record("triggers")? != triggers_target {
                    return Err("写入左扳机死区 6 后快照核对不一致".into());
                }
                let triggers_undo = transaction::execute(
                    &mut session,
                    &root,
                    "undo",
                    transaction::undo_edits(&triggers_save.journal)?,
                )
                .await?;
                if triggers_undo.snapshot.record("triggers")? != triggers_orig {
                    return Err("撤销左扳机死区恢复 4 后快照核对不一致".into());
                }

                // 3. Final independent full-table snapshot read & 100% byte-for-byte assertion against baseline
                let after = session.snapshot().await?;
                verify_against_baseline("after", &after, &baseline)?;

                let sanitized_before = sanitize_snapshot(before);
                let sanitized_after = sanitize_snapshot(after);

                let report = json!({
                    "app_version": env!("CARGO_PKG_VERSION"),
                    "address": sanitized_after.address,
                    "device_name": "致动O+_XXXXXX",
                    "support_tier": sanitized_after.support_tier(),
                    "baseline_records_verified": baseline.raw.len(),
                    "diffs": 0,
                    "byte_identical_to_preflight_baseline": true,
                    "sticks_0x31_roundtrip": {
                        "opcode": "0x31 (WRITE_STICK)",
                        "before_payload_hex": oplus_core::model::hex_spaced(&sticks_orig),
                        "target_payload_hex": oplus_core::model::hex_spaced(&sticks_target),
                        "restored_payload_hex": oplus_core::model::hex_spaced(&sticks_undo.snapshot.record("sticks")?),
                        "save_journal": sanitize_journal(sticks_save.journal),
                        "undo_journal": sanitize_journal(sticks_undo.journal),
                    },
                    "triggers_0x32_roundtrip": {
                        "opcode": "0x32 (WRITE_TRIGGER)",
                        "before_payload_hex": oplus_core::model::hex_spaced(&triggers_orig),
                        "target_payload_hex": oplus_core::model::hex_spaced(&triggers_target),
                        "restored_payload_hex": oplus_core::model::hex_spaced(&triggers_undo.snapshot.record("triggers")?),
                        "save_journal": sanitize_journal(triggers_save.journal),
                        "undo_journal": sanitize_journal(triggers_undo.journal),
                    },
                    "before": sanitized_before,
                    "after": sanitized_after,
                });
                storage::save(Path::new(output), &report)?;
                println!(
                    "roundtrip07 ok: sticks(0x31) 6->8->6 & triggers(0x32) 4->6->4 verified; {} baseline records 100% byte-identical (Diffs = 0)!",
                    baseline.raw.len()
                );
            }
            other => return Err(format!("未知子命令：{other}")),
        }
        Ok(())
    }
    .await;
    session.close().await;
    result
}
