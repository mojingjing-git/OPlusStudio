import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from oplus import board, rear
from test_board import fixture as board_fixture


def fixture():
    value = board_fixture()
    value.update(address="AA:BB:CC:DD:EE:FF", errors=[])
    value["decoded"]["remapping"] = {}
    for slot in range(6):
        payload = rear.encode_change(value, {"kind": "hold", "keys": [slot+1]})
        value["raw"][f"macro_{slot}"] = {"declared": payload[0], "hex": payload[1:].hex()}
    return value


class FakeSession:
    def __init__(self, *, fail_slot=None, bad_read=None, fail_restore=None):
        self.value = fixture()
        self.initial = copy.deepcopy(self.value)
        self.calls = []
        self.fail_slot, self.bad_read, self.fail_restore = fail_slot, bad_read, fail_restore

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        self.calls.append("disconnect")

    async def snapshot(self):
        self.calls.append("snapshot")
        return copy.deepcopy(self.value)

    async def write_record(self, feature, payload, slot):
        self.calls.append(("write", slot))
        if self.fail_restore == slot and payload.hex(" ") == rear.payload_hex(self.initial, slot):
            raise RuntimeError("restore failed")
        self.value["raw"][f"macro_{slot}"] = {"declared": payload[0], "hex": payload[1:].hex()}
        if self.fail_slot == slot:
            self.fail_slot = None
            raise RuntimeError("partial transmission failed")

    async def record(self, opcode, payload):
        slot = payload[1]
        self.calls.append(("read", slot))
        value = copy.deepcopy(self.value["raw"][f"macro_{slot}"])
        if self.bad_read == slot:
            self.bad_read = None
            data = bytearray.fromhex(value["hex"])
            data[-1] ^= 1
            value["hex"] = data.hex()
        return value


class RearCodecTests(unittest.TestCase):
    def test_held_chord_preserves_idle_sticks_and_no_timer(self):
        snap = fixture()
        data = rear.encode_change(snap, {"kind": "hold", "keys": [1, 5]})
        program = rear.codec.parse_macro_payload(data)
        spec = rear.layout(snap)
        self.assertEqual(program.steps[0].mask, spec.neutral | 1 << spec.digital[rear.codec.Key.A] | 1 << spec.digital[rear.codec.Key.LB])
        self.assertEqual(program.steps[0].duration_ms, 0)
        self.assertIn("A + LB", rear.describe(snap, 0, {"kind": "record", "payload": data.hex()}))

    def test_invalid_hold_and_unknown_mask_rejected(self):
        snap = fixture()
        for keys in ([], [1, 1], [999], [True], [13,14], [15,16]):
            with self.subTest(keys=keys), self.assertRaises(ValueError):
                rear.encode_change(snap, {"kind": "hold", "keys": keys})
        data = bytearray.fromhex(rear.payload_hex(snap, 0))
        data[3] = 0xF8  # invalid analog nibble
        with self.assertRaises(ValueError):
            rear.validate_record(snap, bytes(data))

    def test_profile_roundtrip_stages_differences_without_writes(self):
        snap = fixture()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/"rear.json"
            rear.save_profile(path, snap)
            changed = copy.deepcopy(snap)
            changed["raw"]["macro_2"] = changed["raw"]["macro_0"]
            with patch.object(board, "BoardSession", side_effect=AssertionError("Hardware must not be opened")):
                changes = rear.load_profile(path, changed)
            self.assertEqual(set(changes), {2})
            self.assertEqual(changes[2]["payload"], rear.payload_hex(snap, 2))

    def test_full_automatic_backup_restores_rear_fields_only(self):
        original = fixture()
        current = copy.deepcopy(original)
        current["raw"]["macro_0"] = current["raw"]["macro_2"]
        current["raw"]["motors"]["hex"] = "00 "*8
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/"backup.json"
            path.write_text(json.dumps(original), encoding="utf-8")
            changes = rear.load_profile(path, current)
        self.assertEqual(set(changes), {0})
        self.assertEqual(changes[0]["payload"], rear.payload_hex(original,0))

    def test_profile_rejects_wrong_model_layout_duplicates_and_size(self):
        snap = fixture()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/"rear.json"
            rear.save_profile(path, snap)
            original = json.loads(path.read_text(encoding="utf-8"))
            for field in ("identity", "macro_keys", "duplicate"):
                value = copy.deepcopy(original)
                if field == "identity":
                    value["identity"]["version_display"] = "1.38"
                elif field == "macro_keys":
                    value["macro_keys"].reverse()
                else:
                    value["slots"][1]["slot"] = 0
                path.write_text(json.dumps(value), encoding="utf-8")
                with self.assertRaises(ValueError):
                    rear.load_profile(path, snap)
            path.write_text(" "*65537, encoding="utf-8")
            with self.assertRaises(ValueError):
                rear.load_profile(path, snap)

    def test_labels_are_device_scoped_and_cannot_duplicate(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(board, "data_dir", return_value=Path(directory)):
            rear.save_labels("AA", {0:"M1",1:"M2"})
            self.assertEqual(rear.load_labels("aa"), {0:"M1",1:"M2"})
            self.assertEqual(rear.load_labels("BB"), {})
            with self.assertRaises(ValueError):
                rear.save_labels("AA", {0:"M1",1:"M1"})

    def test_verified_model_labels_reuse_across_addresses_without_writes(self):
        snap = fixture()
        snap["capabilities"] = {"declared":10,"hex":"03 03 0f 00 3f 01 0b 00 c0 00"}
        original = copy.deepcopy(snap)
        with tempfile.TemporaryDirectory() as directory, patch.object(board, "data_dir", return_value=Path(directory)), \
                patch.object(board, "BoardSession", side_effect=AssertionError("No hardware needed")):
            for address in ("NEW:ONE", "NEW:TWO"):
                snap["address"] = address
                labels, source = rear.resolve_labels(snap)
                self.assertEqual(labels, dict(enumerate(rear.PHYSICAL_NAMES)))
                self.assertIn("型号预设", source)
            self.assertEqual(list(Path(directory).iterdir()), [])
        snap["address"] = original["address"]
        self.assertEqual(snap, original)

    def test_model_preset_rejects_unknown_firmware_layout_and_slot_mask(self):
        snap = fixture()
        snap["capabilities"] = {"hex":"03 03 0f 00 3f 01 0b 00 c0 00"}
        cases = []
        for field, value in (("version_display","1.38"),("pid","2002"),("mode",2),("generation",1)):
            changed = copy.deepcopy(snap)
            changed["identity"][field] = value
            cases.append(changed)
        changed = copy.deepcopy(snap)
        changed["decoded"]["macro_keys"].reverse()
        cases.append(changed)
        for caps in ({}, {"hex":"03 03 0f 00 0f 01 0b 00 c0 00"}, {"hex":"bad"}):
            cases.append({**snap,"capabilities":caps})
        with tempfile.TemporaryDirectory() as directory, patch.object(board, "data_dir", return_value=Path(directory)):
            for changed in cases:
                self.assertEqual(rear.resolve_labels(changed)[0], {})

    def test_saved_correction_takes_priority_without_duplicate_preset_names(self):
        snap = fixture()
        snap["capabilities"] = {"hex":"03 03 0f 00 3f 01 0b 00 c0 00"}
        with tempfile.TemporaryDirectory() as directory, patch.object(board, "data_dir", return_value=Path(directory)):
            rear.save_labels(snap["address"], {0:"LK"})
            labels, source = rear.resolve_labels(snap)
            self.assertEqual(labels[0], "LK")
            self.assertNotIn(4, labels)
            self.assertEqual(labels[1], "M2")
            self.assertIn("本机保存", source)
            self.assertEqual(len(labels), len(set(labels.values())))


class RearTransactionTests(unittest.IsolatedAsyncioTestCase):
    async def run_change(self, session, changes, expected=None):
        def backed_up(_):
            session.calls.append("backup")
            return "test-backup"
        with patch.object(board, "BoardSession", return_value=session), \
                patch.object(board, "backup", side_effect=backed_up), patch.object(board, "remember_address"):
            return await rear.apply_changes("test", changes, expected=expected)

    async def test_batch_writes_only_changed_slots_and_can_undo_exactly(self):
        session = FakeSession()
        original = copy.deepcopy(session.value)
        result = await self.run_change(session, {1:{"kind":"hold","keys":[5,6]}, 4:{"kind":"macro","sequence":"A:35/15, B:40/0"}})
        self.assertEqual(session.calls[:2], ["snapshot", "backup"])
        self.assertEqual([c for c in session.calls if isinstance(c,tuple) and c[0]=="write"], [("write",1),("write",4)])
        self.assertEqual(rear.payload_hex(session.value, 0), rear.payload_hex(original, 0))
        self.assertTrue(result["write_result"]["readback_verified"])
        await self.run_change(session, result["undo_changes"], result["undo_expected"])
        self.assertEqual(session.value["raw"], original["raw"])

    async def test_late_partial_write_failure_restores_all_attempted_slots(self):
        session = FakeSession(fail_slot=4)
        with self.assertRaisesRegex(RuntimeError, "已恢复本次尝试的所有背键"):
            await self.run_change(session, {1:{"kind":"hold","keys":[5]},4:{"kind":"hold","keys":[6]}})
        self.assertEqual(session.value["raw"], session.initial["raw"])
        writes = [c for c in session.calls if isinstance(c,tuple) and c[0]=="write"]
        self.assertEqual(writes, [("write",1),("write",4),("write",4),("write",1)])

    async def test_mismatch_rolls_back_and_failed_restore_does_not_skip_other_slots(self):
        session = FakeSession(bad_read=4, fail_restore=4)
        with self.assertRaisesRegex(RuntimeError, "部分恢复未确认"):
            await self.run_change(session, {1:{"kind":"hold","keys":[5]},4:{"kind":"hold","keys":[6]}})
        self.assertEqual(rear.payload_hex(session.value,1), rear.payload_hex(session.initial,1))
        self.assertIn(("write",1), session.calls[-3:])

    async def test_conflict_and_late_invalid_change_prevent_all_writes(self):
        for changes, expected in [({1:{"kind":"hold","keys":[5]}},{1:"00"}),
                                  ({1:{"kind":"hold","keys":[5]},4:{"kind":"hold","keys":[999]}},None)]:
            session = FakeSession()
            with self.assertRaises((ValueError, RuntimeError)):
                await self.run_change(session, changes, expected)
            self.assertFalse(any(isinstance(c,tuple) and c[0]=="write" for c in session.calls))

    async def test_no_op_does_not_write_and_empty_original_stays_guarded(self):
        session = FakeSession()
        result = await self.run_change(session, {0:{"kind":"hold","keys":[1]}})
        self.assertEqual(result["write_result"]["changed_slots"], [])
        self.assertNotIn("backup", session.calls)
        session.value["raw"]["macro_4"] = {"declared":0,"hex":""}
        with self.assertRaisesRegex(ValueError,"空槽恢复尚未验证"):
            await self.run_change(session, {1:{"kind":"hold","keys":[5]},4:{"kind":"hold","keys":[6]}})
        self.assertFalse(any(isinstance(c,tuple) and c[0]=="write" for c in session.calls))


if __name__ == "__main__":
    unittest.main()
