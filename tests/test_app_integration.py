"""Own-app integration with hidden Tk and fake controller/output only."""
import copy
import json
from pathlib import Path
import tempfile
import tkinter as tk
import unittest
from unittest.mock import patch

from oplus import app, profiles, board
from oplus.__main__ import main
from oplus.windows_input import BUTTONS, State


class FakePad:
    def __init__(self):
        self.state = State(0, 1, 0, 0, 0, 0, 0, 0, 0)

    def read(self, _index):
        return self.state

    def vibrate(self, *_args):
        pass


class FakeOutput:
    def __init__(self):
        self.events = []

    def key(self, name, down):
        self.events.append((name, down))

    def move_mouse(self, *_args):
        raise AssertionError("Mouse output is not enabled in these tests")

    def panic_pressed(self):
        return False


def hidden_init(root, *args, **kwargs):
    ORIGINAL_TK_INIT(root, *args, **kwargs)
    root.withdraw()


ORIGINAL_TK_INIT = tk.Tk.__init__


class AppIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.pad, self.output = FakePad(), FakeOutput()
        for replacement in [
            patch.object(tk.Tk, "__init__", hidden_init),
            patch.object(app.Studio, "after", return_value="test-no-timers"),
            patch.object(app, "XInput", return_value=self.pad),
            patch.object(app, "WindowsOutput", return_value=self.output),
            patch.object(profiles, "profile_path", return_value=Path(self.temp.name)/"profile.json"),
            patch.object(app.messagebox, "showerror", side_effect=AssertionError("Unexpected error dialog")),
        ]:
            replacement.start()
            self.addCleanup(replacement.stop)
        self.window = app.Studio()
        self.addCleanup(self.window.close)

    def test_mapping_edit_and_macro_replacement_persist_with_output_disabled(self):
        self.window.add_key()
        saved = profiles.load(Path(self.temp.name)/"profile.json")
        self.assertEqual(saved["mappings"], {"A": "Space"})
        self.window.macro_trigger.set("A")
        self.window.add_macro()
        saved = profiles.load(Path(self.temp.name)/"profile.json")
        self.assertNotIn("A", saved["mappings"])
        self.assertEqual(saved["macros"]["A"][0]["key"], "Q")
        self.assertFalse(self.window.engine.enabled)
        self.assertEqual(self.output.events, [])

    def test_disconnect_disables_output_and_releases_mapped_key(self):
        self.window.add_key()
        self.window.toggle()
        self.window.poll()  # neutral frame arms the engine
        self.pad.state = State(0, 2, BUTTONS["A"], 0, 0, 0, 0, 0, 0)
        self.window.poll()
        self.assertEqual(self.output.events, [("Space", True)])
        self.pad.state = None
        self.window.poll()
        self.assertFalse(self.window.engine.enabled)
        self.assertEqual(self.output.events, [("Space", True), ("Space", False)])

    def test_main_tabs_have_scrollable_content_and_footer_has_priority(self):
        self.assertEqual(len(self.window.tab_canvases), 5)
        self.assertEqual(self.window.footer.pack_info()["side"], "bottom")
        self.window.update_idletasks()
        for canvas in self.window.tab_canvases:
            self.assertTrue(canvas.find_all())
        self.assertEqual(self.output.events, [])

    def test_board_snapshot_loads_controls_without_issuing_a_write(self):
        from test_board import fixture
        value = fixture()
        value["address"] = "AA:BB:CC:DD:EE:FF"
        value["errors"] = []
        value["decoded"]["motors"] = [191,191,76,76,32,191,2,0]
        value["decoded"]["all_keys"] = value["decoded"]["remap_keys"]
        value["decoded"]["macros"] = [
            {"slot": slot, "sequence": "RT:0/0", "loop_ms": 0, "trigger": 0}
            for slot in range(6)]
        value["decoded"]["lighting"] = [dict(r=255,g=0,b=0,data4=0,data5=0,light=32)]*4
        with patch.object(board, "apply_settings", side_effect=AssertionError("Unexpected hardware write")):
            self.window.board_panel.set_snapshot(value)
        self.assertEqual(round(self.window.board_panel.motor_values[0].get()), 75)
        self.assertTrue(self.window.board_panel._read_ok)
        self.assertEqual(self.output.events, [])

    def test_closing_during_board_write_waits_for_completion(self):
        self.window.busy = True
        self.window.background_critical = True
        self.window.close()
        self.assertTrue(self.window.pending_close)
        self.assertFalse(self.window.closed)
        self.assertTrue(self.window.winfo_exists())
        self.window.busy = False
        self.window.background_critical = False

    def test_onboard_write_blocks_reenabling_keyboard_output(self):
        self.window.add_key()
        self.window.busy = self.window.background_critical = True
        self.window.toggle()
        self.assertFalse(self.window.engine.enabled)
        self.window.busy = self.window.background_critical = False

    def test_blank_connection_field_recovers_saved_address_before_read(self):
        panel = self.window.board_panel
        panel._set_address_value("")
        with patch.object(board,"saved_address",return_value="AA:BB:CC:DD:EE:FF"), \
                patch.object(self.window,"background") as worker:
            panel.read()
        self.assertEqual(panel.address.get(),"AA:BB:CC:DD:EE:FF")
        worker.assert_called_once()


class CommandErrorTests(unittest.TestCase):
    def test_ble_error_is_saved_as_json_with_failure_status(self):
        async def failed_scan():
            raise RuntimeError("No usable adapter")
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)/"result.json"
            with patch("oplus.ble.scan", failed_scan), self.assertRaises(SystemExit) as result:
                main(["--scan-ble", "--out", str(output)])
            self.assertEqual(result.exception.code, 1)
            self.assertEqual(json.loads(output.read_text(encoding="utf-8"))["message"], "No usable adapter")


if __name__ == "__main__":
    unittest.main()
