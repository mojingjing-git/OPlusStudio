import unittest
from unittest.mock import patch

from oplus import live_probe


class FakeProbe:
    def __init__(self, *, fail_page=False):
        self.controls = []
        self.trace = []
        self.closed = False
        self.fail_page = fail_page

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        self.closed = True

    async def record(self, *_args):
        return b"unchanged capabilities"

    async def control(self, operation):
        self.controls.append(operation)
        if self.fail_page and operation == "button_start":
            raise RuntimeError("page selection failed")


class NoGamepad:
    def read(self, _index):
        return None


class LiveProbeTests(unittest.IsolatedAsyncioTestCase):
    async def test_button_page_requires_stream_start_and_cleanup(self):
        session = FakeProbe()
        ready = []

        async def operator_ready():
            self.assertEqual(session.controls, [])
            ready.append(True)

        with patch.object(live_probe, "LiveProbe", return_value=session), \
                patch.object(live_probe, "XInput", NoGamepad):
            result = await live_probe.capture("fake", .001, buttons=True,
                                              before_start=operator_ready)
        self.assertEqual(ready, [True])
        self.assertEqual(session.controls, ["start", "button_start", "stop"])
        self.assertTrue(session.closed)
        self.assertTrue(result["capabilities_unchanged"])
        self.assertEqual(result["back_key_support"], "unknown")

    async def test_failed_page_selection_still_stops_and_disconnects(self):
        session = FakeProbe(fail_page=True)
        with patch.object(live_probe, "LiveProbe", return_value=session), \
                patch.object(live_probe, "XInput", NoGamepad):
            with self.assertRaisesRegex(RuntimeError, "page selection failed"):
                await live_probe.capture("fake", .001, buttons=True)
        self.assertEqual(session.controls, ["start", "button_start", "stop"])
        self.assertTrue(session.closed)


if __name__ == "__main__":
    unittest.main()
