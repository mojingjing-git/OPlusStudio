import copy
import unittest
from unittest.mock import patch

from oplus import board, protocol
from oplus.vendor import keylinker as codec


def fixture():
    return {"identity": dict(board.EXPECTED_ID), "decoded": {
        "remap_keys": [1,2,3,4,5,6,7,8,13,14,15,16,11,12,93,94],
        "macro_keys": [18,19,13,14,15,16,1,2,3,4,5,6,7,8,11,12,93,94],
        "capabilities": {"lighting": 11}}, "raw": {
        "motors": {"declared": 8, "hex": "bf bf 4c 4c 20 bf 02 00"},
        "remapping": {"declared": 0, "hex": ""},
        "lighting": {"declared": 24, "hex": "ff ff ff 00 00 20 00 ff 00 10 00 40 00 00 ff 40 80 80 80 80 80 a0 80 ff"}}}


class BoardCodecTests(unittest.TestCase):
    def test_identity_must_match_exact_tested_mode_and_firmware(self):
        self.assertTrue(board.matched(dict(board.EXPECTED_ID)))
        for change in ({"version_display": "1.38"}, {"mode": 2}, {"vid": "1013"}):
            self.assertFalse(board.matched({**board.EXPECTED_ID, **change}))

    def test_motor_change_preserves_all_unknown_trailing_bytes(self):
        snap = fixture()
        _, payload, _ = board.desired_payload(snap, "motors", {"levels": [74,75,30,30]})
        self.assertEqual(payload, bytes.fromhex("08 bd bf 4c 4c 20 bf 02 00"))

    def test_lighting_changes_only_rgb_and_rejects_unsupported_zone(self):
        snap = fixture()
        original = board.current_payload(snap, "lighting")
        _, payload, _ = board.desired_payload(snap, "lighting", {"zone": 1, "rgb": "#123456"})
        self.assertEqual(payload[:7], original[:7])
        self.assertEqual(payload[7:10], bytes.fromhex("12 34 56"))
        self.assertEqual(payload[10:], original[10:])
        with self.assertRaises(ValueError):
            board.desired_payload(snap, "lighting", {"zone": 2, "rgb": "#123456"})

    def test_remap_preserves_device_order(self):
        _, payload, _ = board.desired_payload(fixture(), "remapping", {"source": 11, "target": 12})
        self.assertEqual(len(payload), 17)
        self.assertEqual(payload[13], 12)
        self.assertEqual(sum(payload[1:]), 12)

    def test_back_mapping_has_neutral_analog_nibbles_and_zero_duration(self):
        # Captured O+ slot 4 stores RT (code 8), with zero duration.
        _, payload, slot = board.desired_payload(fixture(), "back_mapping", {"slot": 3, "target": 8})
        self.assertEqual(slot, 3)
        self.assertEqual(payload, bytes.fromhex("07 00 00 88 00 08 00 00"))

    def test_macro_uses_actual_device_layout_and_retains_release_gap(self):
        keys = fixture()["decoded"]["macro_keys"]
        payload = board.encode_macro("A+B:100/60, LT:80/0", keys)
        layout = codec.layout_from_key_list(keys)
        program = codec.parse_macro_payload(payload)
        self.assertEqual(program.steps[1].mask, layout.neutral)
        self.assertEqual(program.steps[1].duration_ms, 60)
        raw = {"declared": payload[0], "hex": payload[1:].hex()}
        shown = board.macro_sequence(raw, layout)
        self.assertEqual(board.encode_macro(shown["sequence"], keys), payload)

    def test_macro_timing_and_length_are_validated(self):
        keys = fixture()["decoded"]["macro_keys"]
        for sequence in ("A:101/60", "A:0/60", "MouseLeft:100/60", ",".join(["A:100/60"]*22)):
            with self.assertRaises(ValueError):
                board.encode_macro(sequence, keys)

    def test_read_allowlist_cannot_enter_control_or_ota(self):
        for opcode in (0x16,0x1D,0x1E,0x31,0x35,0xF1):
            with self.assertRaises(ValueError):
                protocol.settings_query(opcode, b"\x00", 1)
        packet = protocol.parse(protocol.settings_query(0xB5, b"\x01\x05", 1))
        self.assertEqual(packet.payload, b"\x01\x05")


class BoardBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_discovery_prefers_single_named_oplus_and_verifies_through_reader(self):
        async def scan(**_):
            return [{"name":"Xpert2","address":"other","likely":True},
                    {"name":"致动O+_ABCDEF","address":"oplus","likely":True}]
        from unittest.mock import AsyncMock
        reader = AsyncMock(return_value={"verified":True})
        with patch.object(board.ble,"scan",scan), patch.object(board,"read_settings",reader):
            result = await board.discover_settings()
        reader.assert_awaited_once_with("oplus")
        self.assertTrue(result["verified"])

    async def test_discovery_does_not_choose_between_multiple_oplus_controllers(self):
        async def scan(**_):
            return [{"name":"致动O+_A","address":"a"},{"name":"致动O+_B","address":"b"}]
        from unittest.mock import AsyncMock
        reader = AsyncMock()
        with patch.object(board.ble,"scan",scan), patch.object(board,"read_settings",reader):
            with self.assertRaisesRegex(RuntimeError,"多个候选"):
                await board.discover_settings()
        reader.assert_not_awaited()

    async def test_unverified_session_cannot_read_settings_or_write(self):
        session = board.BoardSession("not-a-real-address")
        with self.assertRaises(RuntimeError):
            session.build_query(0xB3, b"\x00", 1)
        with self.assertRaises(ValueError):
            await session.write_record("motors", bytes.fromhex("08 bf bf 4c 4c 20 bf 02 00"))

    async def test_write_boundary_rejects_unknown_feature_and_bad_record(self):
        session = board.BoardSession("not-a-real-address")
        session.verified = True
        for feature, payload in [("factory_reset", b"\x00"), ("motors", b"\x01\x00"),
                                 ("macro", b"\x01\x00"), ("lighting", bytes(30))]:
            with self.assertRaises(ValueError):
                await session.write_record(feature, payload)

    async def test_successful_apply_reads_fresh_and_saves_backup_before_write(self):
        session = FakeSession()
        calls = []
        session.calls = calls
        with patch.object(board, "BoardSession", return_value=session), \
             patch.object(board, "backup", side_effect=lambda snap: calls.append("backup") or "test-backup"), \
             patch.object(board, "remember_address"):
            result = await board.apply_settings("test-address", "motors", {"levels": [74,75,30,30]})
        self.assertEqual(calls[:3], ["snapshot", "backup", "write"])
        self.assertTrue(result["write_result"]["readback_verified"])
        self.assertEqual(session.payload[1], 189)

    async def test_mismatch_restores_exact_original_before_returning_error(self):
        session = FakeSession(mismatch=True)
        original = session.payload
        with patch.object(board, "BoardSession", return_value=session), \
             patch.object(board, "backup", return_value="test-backup"), \
             patch.object(board, "remember_address"), \
             self.assertRaisesRegex(RuntimeError, "已恢复原记录"):
            await board.apply_settings("test-address", "motors", {"levels": [74,75,30,30]})
        self.assertEqual(session.payload, original)
        self.assertEqual(session.calls.count("write"), 2)


class FakeSession:
    def __init__(self, mismatch=False):
        self.payload = board.current_payload(fixture(), "motors")
        self.mismatch = mismatch
        self.calls = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        pass

    async def snapshot(self):
        self.calls.append("snapshot")
        value = fixture()
        value["raw"]["motors"] = {"declared": self.payload[0], "hex": self.payload[1:].hex()}
        return value

    async def write_record(self, _feature, payload, _slot):
        self.calls.append("write")
        self.payload = payload

    async def record(self, _opcode, _payload):
        self.calls.append("readback")
        data = self.payload
        if self.mismatch:
            self.mismatch = False
            data = data[:-1] + bytes([data[-1]^1])
        return {"declared": data[0], "hex": data[1:].hex()}


if __name__ == "__main__":
    unittest.main()
