import copy
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from oplus import board, rear, rear_identify
from oplus.windows_input import State, BUTTONS
from test_rear import FakeSession


class IdentificationTests(unittest.IsolatedAsyncioTestCase):
    async def run_identification(self, *, disconnect=False, cancel_early=False):
        session = FakeSession()
        data = rear.encode_change(session.value, {"kind":"hold", "keys":[7]})
        for i in range(6):
            session.value["raw"][f"macro_{i}"] = {"declared":data[0],"hex":data[1:].hex()}
        session.initial = copy.deepcopy(session.value)
        clock = [0.0]
        permutation = [3,0,5,1,2,4]
        masks = [BUTTONS[k] for k in ["A","B","X","Y","LB","RB"]]
        cancel = threading.Event()
        async def sleep(_):
            clock[0] += .02
        class Pad:
            def read(self, index):
                if index != 0:
                    return None
                if disconnect and clock[0] > .3:
                    return None
                phase = int(clock[0]/.15)
                buttons = masks[permutation[min(phase//3,5)]] if phase%3 == 1 else 0
                return State(0,phase,buttons,0,0,0,0,0,0)
        def status(text):
            if cancel_early and "3/6" in text:
                cancel.set()
        with patch.object(board, "BoardSession", return_value=session), \
                patch.object(board,"backup",return_value="test-backup"), \
                patch.object(rear_identify,"time",SimpleNamespace(monotonic=lambda:clock[0])), \
                patch.object(rear_identify.asyncio,"sleep",sleep):
            if disconnect:
                with self.assertRaisesRegex(RuntimeError,"原配置已恢复"):
                    await rear_identify.identify_slots("test",pad=Pad(),cancel=cancel,on_status=status)
                result = None
            else:
                result = await rear_identify.identify_slots("test",pad=Pad(),cancel=cancel,on_status=status)
        self.assertEqual(session.value["raw"], session.initial["raw"])
        self.assertEqual(session.calls[-1],"disconnect")
        return result, permutation

    async def test_learns_actual_slot_permutation_and_restores_all_records(self):
        result, order = await self.run_identification()
        self.assertEqual(result["identified_labels"], {slot:name for slot,name in zip(order,rear.PHYSICAL_NAMES)})
        self.assertTrue(result["identification"]["originals_restored"])

    async def test_cancel_during_marker_setup_restores_attempted_records(self):
        result, _ = await self.run_identification(cancel_early=True)
        self.assertTrue(result["identification"]["cancelled"])
        self.assertEqual(result["identified_labels"],{})

    async def test_gameplay_disconnect_still_restores_all_records(self):
        await self.run_identification(disconnect=True)


if __name__ == "__main__":
    unittest.main()
