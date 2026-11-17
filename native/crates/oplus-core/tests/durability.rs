use async_trait::async_trait;
use oplus_core::{
    Result,
    model::{Change, Record, Snapshot},
    storage,
    transaction::*,
};
use std::path::PathBuf;
fn fixture() -> Snapshot {
    serde_json::from_str(include_str!("../../../fixtures/snapshot.json")).unwrap()
}
struct DiskFault {
    snapshot: Snapshot,
    root: PathBuf,
    writes: usize,
    fail_journal: bool,
    fail_refresh: bool,
    snapshots: usize,
}
#[async_trait]
impl Device for DiskFault {
    async fn snapshot(&mut self) -> Result<Snapshot> {
        self.snapshots += 1;
        if self.fail_refresh && self.snapshots > 1 {
            return Err("refresh unavailable".into());
        }
        Ok(self.snapshot.clone())
    }
    async fn read(&mut self, key: &str) -> Result<Vec<u8>> {
        self.snapshot.record(key)
    }
    async fn write(&mut self, key: &str, p: &[u8]) -> Result<()> {
        self.writes += 1;
        self.snapshot
            .raw
            .insert(key.into(), Record::from_payload(p)?);
        if self.fail_journal && self.writes == 2 {
            for e in std::fs::read_dir(self.root.join("journals"))
                .unwrap()
                .flatten()
            {
                let mut perms = std::fs::metadata(e.path()).unwrap().permissions();
                perms.set_readonly(true);
                std::fs::set_permissions(e.path(), perms).unwrap();
            }
        }
        Ok(())
    }
}
fn edits() -> Vec<Edit> {
    let s = fixture();
    (0..3)
        .map(|i| Edit {
            key: format!("macro_{i}"),
            expected: s.record(&format!("macro_{i}")).unwrap(),
            target: Change::Hold { keys: vec![1] }.encode(&s).unwrap(),
        })
        .collect()
}
#[cfg(windows)]
#[tokio::test]
async fn journal_disk_failure_restores_earlier_verified_and_current_attempt() {
    let dir = tempfile::tempdir().unwrap();
    let mut m = DiskFault {
        snapshot: fixture(),
        root: dir.path().into(),
        writes: 0,
        fail_journal: true,
        fail_refresh: false,
        snapshots: 0,
    };
    let result = execute(&mut m, dir.path(), "save", edits()).await;
    assert!(result.is_err());
    assert_eq!(m.writes, 4);
    for i in 0..6 {
        assert_eq!(
            m.snapshot.record(&format!("macro_{i}")).unwrap(),
            fixture().record(&format!("macro_{i}")).unwrap()
        );
    }
    let j = pending(dir.path());
    assert_eq!(j.len(), 1);
    assert!(j[0].records[0].attempted && j[0].records[1].attempted);
    for e in std::fs::read_dir(dir.path().join("journals"))
        .unwrap()
        .flatten()
    {
        let mut p = std::fs::metadata(e.path()).unwrap().permissions();
        p.set_readonly(false);
        std::fs::set_permissions(e.path(), p).unwrap();
    }
}
#[tokio::test]
async fn committed_save_keeps_undo_when_extra_refresh_fails() {
    let dir = tempfile::tempdir().unwrap();
    let mut m = DiskFault {
        snapshot: fixture(),
        root: dir.path().into(),
        writes: 0,
        fail_journal: false,
        fail_refresh: true,
        snapshots: 0,
    };
    let r = execute(&mut m, dir.path(), "save", edits()).await.unwrap();
    assert_eq!(r.journal.state, "completed");
    assert_eq!(undo_edits(&r.journal).unwrap().len(), 3);
    assert!(!r.snapshot.errors.is_empty());
}
#[tokio::test]
async fn crash_at_each_durable_state_has_no_implicit_device_io() {
    for phase in [
        "prepared",
        "write_intent",
        "verified",
        "restore_intent",
        "sampling",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let mut m = DiskFault {
            snapshot: fixture(),
            root: dir.path().into(),
            writes: 0,
            fail_journal: false,
            fail_refresh: false,
            snapshots: 0,
        };
        let (mut j, _) = prepare(&mut m, dir.path(), "save", edits()).await.unwrap();
        if phase != "prepared" {
            j.records[0].attempted = true;
            j.records[0].state = phase.into();
            j.state = phase.into();
        }
        j.persist(dir.path()).unwrap();
        let restored = pending(dir.path());
        assert_eq!(restored.len(), 1);
        assert_eq!(m.writes, 0);
        let mut bad = j.clone();
        bad.backup = "../unsafe.json".into();
        assert!(validate_journal(dir.path(), &bad).is_err());
        let path = dir.path().join(&j.backup);
        let mut bytes = std::fs::read(&path).unwrap();
        bytes.push(b' ');
        storage::atomic(&path, &bytes).unwrap();
        assert!(validate_journal(dir.path(), &j).is_err());
    }
}
