import copy
from pathlib import Path
import tempfile
import tkinter as tk
from tkinter import ttk
import unittest
from unittest.mock import patch

from oplus import board, rear
from oplus.rear_ui import RearEditor
from test_rear import fixture


class FakeStudio(tk.Tk):
    def __init__(self):
        super().__init__()
        self.withdraw()
        self.busy = False
        self.slot = tk.StringVar(value="0")
        self.job = None
        self.footer = ttk.Label(self)

    def stop(self, *_):
        pass

    def background(self, function, callback, status, **options):
        self.job = (function, callback, options)
        self.busy = True


class RearUITests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        context = patch.object(board, "data_dir", return_value=Path(self.temp.name))
        context.start()
        self.addCleanup(context.stop)
        self.root = FakeStudio()
        self.addCleanup(self.root.destroy)
        self.editor = RearEditor(self.root, self.root, on_refresh=lambda result:self.editor.set_snapshot(result))
        self.editor.set_snapshot(fixture())

    def test_new_controller_uses_model_labels_without_identification_job(self):
        snap = fixture()
        snap.update(address="NEW:CONTROLLER", capabilities={"hex":"03 03 0f 00 3f 01 0b 00 c0 00"})
        self.editor.set_snapshot(snap)
        self.assertEqual(self.editor.labels, dict(enumerate(rear.PHYSICAL_NAMES)))
        self.assertIn("型号预设", self.editor.label_source.get())
        self.assertIn("M1", self.editor.tree.item("0", "values")[0])
        self.assertIn("重新校正", self.editor.identify_button.cget("text"))
        self.assertIsNone(self.root.job)
        self.assertEqual(self.editor.pending, {})

    def test_multiple_drafts_and_unstaged_edits_survive_selection_changes(self):
        self.editor.hold_vars[1].set(False)
        self.editor.hold_vars[5].set(True)
        self.assertTrue(self.editor.stage())
        self.editor.tree.selection_set("1")
        self.editor._selection_changed()
        self.editor.hold_vars[2].set(False)
        self.editor.hold_vars[6].set(True)
        self.editor.tree.selection_set("0")
        self.editor._selection_changed()
        self.editor.tree.selection_set("1")
        self.editor._selection_changed()
        self.assertTrue(self.editor.hold_vars[6].get())
        self.assertTrue(self.editor.stage())
        self.assertEqual(set(self.editor.pending), {0,1})
        self.assertIsNone(self.root.job)

    def test_apply_passes_freshness_expectations_and_marks_worker_critical(self):
        self.editor.hold_vars[5].set(True)
        self.editor.stage()
        original = rear.payload_hex(self.editor.snapshot, 0)
        seen = {}
        async def fake_apply(address, changes, *, expected):
            seen.update(address=address, changes=changes, expected=expected)
            return self.editor.snapshot
        with patch.object(rear, "apply_changes", fake_apply):
            self.editor.apply()
            self.assertTrue(self.root.job[2]["critical"])
            self.root.job[0]()
        self.assertEqual(seen["expected"], {0:original})
        self.assertEqual(seen["changes"][0]["kind"], "hold")

    def test_failed_write_stays_disabled_until_snapshot_is_reread(self):
        self.editor._failed("模拟通信错误")
        self.editor.set_enabled(True)
        self.assertFalse(self.editor.enabled)
        self.editor.set_snapshot(fixture())
        self.assertTrue(self.editor.enabled)

    def test_successful_save_refreshes_editor_and_keeps_exact_undo(self):
        original = rear.payload_hex(self.editor.snapshot,0)
        self.editor.hold_vars[5].set(True)
        self.editor.stage()
        self.editor.apply()
        payload = rear.encode_change(self.editor.snapshot,self.editor.pending[0])
        result = copy.deepcopy(self.editor.snapshot)
        result["raw"]["macro_0"] = {"declared":payload[0],"hex":payload[1:].hex()}
        result["undo_changes"] = {0:{"kind":"record","payload":original}}
        result["undo_expected"] = {0:payload.hex(" ")}
        self.root.busy = False
        self.root.job[1](result)
        self.assertFalse(self.editor.pending)
        self.assertTrue(self.editor.hold_vars[5].get())
        self.assertEqual(self.editor.undo_changes[0]["payload"],original)
        self.editor.undo()
        self.assertTrue(self.root.job[2]["critical"])

    def test_import_only_stages_and_export_uses_current_hardware_records(self):
        path = Path(self.temp.name)/"config.json"
        changed = copy.deepcopy(self.editor.snapshot)
        changed["raw"]["macro_0"] = changed["raw"]["macro_1"]
        rear.save_profile(path, changed)
        with patch("oplus.rear_ui.filedialog.askopenfilename", return_value=str(path)):
            self.editor.import_profile()
        self.assertEqual(set(self.editor.pending), {0})
        self.assertIsNone(self.root.job)
        with patch("oplus.rear_ui.filedialog.asksaveasfilename", return_value=str(path)):
            self.editor.export_profile()
        self.assertEqual(rear.load_profile(path, self.editor.snapshot), {})

    def test_refresh_preserves_drafts_and_conflict_expectations(self):
        self.editor.hold_vars[5].set(True)
        self.editor.stage()
        expected = dict(self.editor.expected)
        fresh = fixture()
        fresh["raw"]["macro_0"] = fresh["raw"]["macro_2"]
        self.editor.set_snapshot(fresh)
        self.assertEqual(self.editor.expected, expected)
        self.assertEqual(set(self.editor.pending), {0})
        self.assertIn("已改变", self.editor.status.get())


if __name__ == "__main__":
    unittest.main()
