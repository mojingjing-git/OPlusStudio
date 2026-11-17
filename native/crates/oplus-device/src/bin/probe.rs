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

async fn run() -> oplus_core::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let root = storage::data_dir();
    let _lease = Lease::acquire(&root)?;
    let cmd = args
        .get(1)
        .map(String::as_str)
        .ok_or("用法：probe scan | read ADDR OUT | diagnose ADDR OUT | roundtrip ADDR OUT | roundtrip06 ADDR BASELINE OUT")?;

    if cmd == "scan" {
        println!(
            "{}",
            serde_json::to_string_pretty(&oplus_device::scan().await?).unwrap()
        );
        return Ok(());
    }

    let address = args.get(2).ok_or("缺少蓝牙地址参数")?;
    let mut session = Session::connect(address).await?;
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
            other => return Err(format!("未知子命令：{other}")),
        }
        Ok(())
    }
    .await;
    session.close().await;
    result
}
