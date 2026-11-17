import asyncio
import random
import unittest

from oplus import protocol as p
from oplus.ble import Identifier


class ProtocolTests(unittest.TestCase):
    def test_captured_hardware_response(self):
        # x20ctl's independently captured EasySMX X20 identity response.
        packet = p.parse(bytes.fromhex("268cb68ef74c7e10bfc1fddf62"))
        self.assertEqual((packet.opcode, packet.serial), (0x19, 1))
        self.assertEqual(packet.payload, bytes.fromhex("0710132009012352"))
        identity = p.identity(packet.payload)
        self.assertEqual(identity["vid"], "1013")
        self.assertEqual(identity["pid"], "2009")
        self.assertEqual(identity["version_display"], "1.23")
        self.assertEqual(identity["generation"], 2)

    def test_short_and_corrupt_packets_rejected(self):
        for raw in [b"", b"1234", bytes(21)]:
            with self.assertRaises(ValueError):
                p.parse(raw)
        raw = bytearray.fromhex("268cb68ef74c7e10bfc1fddf62")
        raw[-1] ^= 1
        with self.assertRaisesRegex(ValueError, "CRC"):
            p.parse(bytes(raw))

    def test_all_configuration_and_mode_writes_are_rejected(self):
        for opcode in range(256):
            if opcode in (0x90, 0x91, 0xB0):
                continue
            with self.assertRaises(ValueError):
                p.identification_query(opcode, b"", 1)
        for opcode, payload in [(0x91, b"\x01"), (0xB0, b"\x00"), (0xB0, b"\x00\x06"), (0x90, b"\x08")]:
            with self.assertRaises(ValueError):
                p.identification_query(opcode, payload, 1)

    def test_framing_matches_all_nonce_values(self):
        for nonce in range(256):
            raw = p.identification_query(0xB0, b"\x00\x03", 130, nonce)
            packet = p.parse(raw)
            self.assertEqual((packet.opcode, packet.serial, packet.payload), (0xB0, 130, b"\x00\x03"))

    def test_scramble_inverts_random_frames(self):
        rng = random.Random(71)
        for length in range(5, 21):
            for _ in range(20):
                body = rng.randbytes(length-1)
                frame = body + bytes([p.crc8(body)])
                self.assertEqual(p.unscramble(p.scramble(frame)), frame)


class FakeClient:
    def __init__(self):
        self.sent = []

    async def write_gatt_char(self, *args, **kwargs):
        self.sent.append(args)


class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_rejected_request_cannot_reach_transport(self):
        client = FakeClient()
        identifier = Identifier(client)
        with self.assertRaises(ValueError):
            await identifier.query(0x37, b"\x01")
        self.assertEqual(client.sent, [])

    async def test_only_valid_response_with_matching_serial_is_used(self):
        identifier = Identifier(FakeClient())
        waiter = asyncio.get_running_loop().create_future()
        identifier.waiters[1] = waiter
        identifier.notified(None, bytearray(p.identification_query(0x91, b"", 1, 10)))
        self.assertFalse(waiter.done())
        identifier.notified(None, bytearray.fromhex("268cb68ef74c7e10bfc1fddf62"))
        self.assertEqual(waiter.result().serial, 1)


if __name__ == "__main__":
    unittest.main()
