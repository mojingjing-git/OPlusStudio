from __future__ import annotations

import ctypes
import unittest

from oplus.engine import MappingEngine
from oplus.windows_input import (
    BUTTONS,
    INPUT,
    State,
    WindowsOutput,
    XINPUT_STATE,
    XINPUT_VIBRATION,
    XInput,
    available_keys,
)


def make_state(
    *,
    index: int = 0,
    buttons: int = 0,
    lt: int = 0,
    rt: int = 0,
    lx: int = 0,
    ly: int = 0,
    rx: int = 0,
    ry: int = 0,
    packet: int = 1,
) -> State:
    return State(index, packet, buttons, lt, rt, lx, ly, rx, ry)


class FakeOutput:
    def __init__(self) -> None:
        self.events: list[tuple] = []
        self.fail_on: tuple[str, bool] | None = None
        self.panic = False
        self.moves: list[tuple[int, int]] = []

    def key(self, name: str, down: bool) -> None:
        self.events.append((name, down))
        if self.fail_on == (name, down):
            raise OSError("simulated SendInput failure")

    def move_mouse(self, dx: int, dy: int) -> None:
        self.events.append(("MOVE", dx, dy))
        self.moves.append((dx, dy))

    def panic_pressed(self) -> bool:
        return self.panic


class WindowsInputTests(unittest.TestCase):
    def test_button_contract_and_active_inputs(self) -> None:
        self.assertEqual(
            set(BUTTONS),
            {
                "A",
                "B",
                "X",
                "Y",
                "LB",
                "RB",
                "Back",
                "Start",
                "LS",
                "RS",
                "Up",
                "Down",
                "Left",
                "Right",
            },
        )
        state = make_state(
            buttons=BUTTONS["A"] | BUTTONS["Right"],
            lt=41,
            rt=40,
            lx=-8001,
            ly=8001,
            rx=-9000,
            ry=12000,
        )
        self.assertEqual(
            state.active_inputs(),
            {"A", "Right", "LT", "LX-", "LY+", "RX-", "RY+"},
        )
        self.assertEqual(make_state(lx=8000, ly=-8000).active_inputs(), set())

    def test_win32_structure_layout(self) -> None:
        expected = 40 if ctypes.sizeof(ctypes.c_void_p) == 8 else 28
        self.assertEqual(ctypes.sizeof(INPUT), expected)
        self.assertEqual(ctypes.sizeof(XINPUT_STATE), 16)
        self.assertEqual(ctypes.sizeof(XINPUT_VIBRATION), 4)

    def test_xinput_injected_read_and_vibration(self) -> None:
        calls = []

        def get_state(slot, pointer):
            raw = pointer._obj
            raw.dwPacketNumber = 99
            raw.Gamepad.wButtons = BUTTONS["B"]
            raw.Gamepad.sThumbRY = -1234
            calls.append(("get", int(slot)))
            return 0

        def set_state(slot, pointer):
            vibration = pointer._obj
            calls.append(
                (
                    "set",
                    int(slot),
                    int(vibration.wLeftMotorSpeed),
                    int(vibration.wRightMotorSpeed),
                )
            )
            return 0

        controller = XInput(get_state=get_state, set_state=set_state)
        state = controller.read(2)
        self.assertEqual(state.packet, 99)
        self.assertEqual(state.buttons, BUTTONS["B"])
        self.assertEqual(state.ry, -1234)
        controller.vibrate(2, 0.5, 2.0)
        self.assertEqual(calls, [("get", 2), ("set", 2, 32768, 65535)])
        with self.assertRaises(ValueError):
            controller.read(4)

    def test_windows_output_sendinput_abi_and_panic(self) -> None:
        events = []

        def send_input(count, pointer, size):
            raw = ctypes.cast(pointer, ctypes.POINTER(INPUT)).contents
            event = INPUT()
            ctypes.memmove(ctypes.byref(event), ctypes.byref(raw), size)
            events.append((int(count), size, event.type, event))
            return 1

        output = WindowsOutput(
            send_input=send_input,
            get_async_key_state=lambda key: 0x8000 if key == 0x77 else 0,
        )
        output.key("a", True)
        output.key("MouseLeft", False)
        output.move_mouse(4, -3)

        expected_size = 40 if ctypes.sizeof(ctypes.c_void_p) == 8 else 28
        self.assertEqual(
            [event[:3] for event in events],
            [(1, expected_size, 1), (1, expected_size, 0), (1, expected_size, 0)],
        )
        self.assertEqual(events[0][3].ki.wVk, ord("A"))
        self.assertEqual(events[0][3].ki.dwFlags, 0)
        self.assertEqual(events[1][3].mi.dwFlags, 0x0004)
        self.assertEqual((events[2][3].mi.dx, events[2][3].mi.dy), (4, -3))
        self.assertTrue(output.panic_pressed())
        self.assertIn("A", output.available_keys())
        self.assertIn("MouseMiddle", output.available_keys())
        self.assertEqual(output.available_keys(), available_keys())
        self.assertIn("F8", available_keys())


class MappingEngineTests(unittest.TestCase):
    def armed_engine(self, output: FakeOutput, **options) -> MappingEngine:
        engine = MappingEngine(output)
        engine.configure(**options)
        engine.enabled = True
        engine.tick(make_state(), 0.0)
        self.assertTrue(engine.enabled)
        return engine

    def test_shared_key_is_not_released_until_last_owner(self) -> None:
        output = FakeOutput()
        engine = self.armed_engine(
            output,
            mappings={"A": "Ctrl", "B": "ctrl"},
            macros={},
        )

        engine.tick(make_state(buttons=BUTTONS["A"] | BUTTONS["B"]), 0.01)
        engine.tick(make_state(buttons=BUTTONS["A"]), 0.02)
        self.assertEqual(output.events, [("Ctrl", True)])
        engine.tick(make_state(), 0.03)
        self.assertEqual(output.events, [("Ctrl", True), ("Ctrl", False)])

    def test_mapping_and_macro_share_a_key_reference(self) -> None:
        output = FakeOutput()
        engine = self.armed_engine(
            output,
            mappings={"A": "X"},
            macros={"A": [{"key": "X", "hold_ms": 100, "after_ms": 0}]},
        )

        engine.tick(make_state(buttons=BUTTONS["A"]), 0.01)
        self.assertEqual(output.events, [("X", True)])
        engine.tick(make_state(buttons=BUTTONS["A"]), 0.11)
        self.assertEqual(output.events, [("X", True)])
        engine.tick(make_state(), 0.12)
        self.assertEqual(output.events, [("X", True), ("X", False)])

    def test_macro_timing_and_same_macro_retrigger_ignore(self) -> None:
        output = FakeOutput()
        engine = self.armed_engine(
            output,
            mappings={},
            macros={
                "A": [
                    {"key": "X", "hold_ms": 50, "after_ms": 50},
                    {"key": "Y", "hold_ms": 60, "after_ms": 0},
                ]
            },
        )

        engine.tick(make_state(buttons=BUTTONS["A"]), 0.01)
        engine.tick(make_state(buttons=BUTTONS["A"]), 0.02)
        self.assertEqual(output.events, [("X", True)])
        engine.tick(make_state(buttons=BUTTONS["A"]), 0.06)
        self.assertEqual(output.events, [("X", True), ("X", False)])
        engine.tick(make_state(), 0.11)
        self.assertEqual(output.events[-1], ("Y", True))
        engine.tick(make_state(), 0.17)
        self.assertEqual(output.events[-1], ("Y", False))

    def test_disconnect_releases_macro_and_requires_new_neutral_arm(self) -> None:
        output = FakeOutput()
        engine = self.armed_engine(
            output,
            mappings={"A": "Ctrl"},
            macros={"A": [{"key": "Z", "hold_ms": 1000, "after_ms": 0}]},
        )

        engine.tick(make_state(buttons=BUTTONS["A"]), 0.01)
        self.assertEqual(output.events, [("Ctrl", True), ("Z", True)])
        engine.tick(None, 0.02)
        self.assertEqual(
            output.events,
            [("Ctrl", True), ("Z", True), ("Ctrl", False), ("Z", False)],
        )

        engine.tick(make_state(buttons=BUTTONS["A"]), 0.03)
        self.assertEqual(len(output.events), 4)
        engine.tick(make_state(), 0.04)
        engine.tick(make_state(buttons=BUTTONS["A"]), 0.05)
        self.assertEqual(output.events[-2:], [("Ctrl", True), ("Z", True)])

    def test_first_frame_and_held_input_do_not_fire(self) -> None:
        output = FakeOutput()
        engine = MappingEngine(output)
        engine.configure({"A": "Space"}, {"A": [{"key": "X", "hold_ms": 10}]})
        engine.enabled = True

        engine.tick(make_state(buttons=BUTTONS["A"]), 0.0)
        self.assertEqual(output.events, [])
        engine.tick(make_state(buttons=BUTTONS["A"]), 0.1)
        self.assertEqual(output.events, [])
        engine.tick(make_state(), 0.2)
        engine.tick(make_state(buttons=BUTTONS["A"]), 0.3)
        self.assertEqual(output.events, [("Space", True), ("X", True)])

    def test_slot_change_and_property_disable_release_safely(self) -> None:
        output = FakeOutput()
        engine = self.armed_engine(output, mappings={"A": "Space"}, macros={})

        engine.tick(make_state(buttons=BUTTONS["A"]), 0.01)
        engine.tick(make_state(index=1, buttons=BUTTONS["A"]), 0.02)
        self.assertEqual(
            output.events,
            [("Space", True), ("Space", False)],
        )
        engine.tick(make_state(index=1), 0.03)
        engine.tick(make_state(index=1, buttons=BUTTONS["A"]), 0.04)
        engine.enabled = False
        self.assertFalse(engine.enabled)
        self.assertEqual(
            output.events,
            [
                ("Space", True),
                ("Space", False),
                ("Space", True),
                ("Space", False),
            ],
        )

    def test_send_failure_disables_and_releases_other_keys(self) -> None:
        output = FakeOutput()
        output.fail_on = ("Y", True)
        engine = self.armed_engine(
            output,
            mappings={"A": "X", "B": "Y"},
            macros={},
        )

        engine.tick(make_state(buttons=BUTTONS["A"]), 0.01)
        engine.tick(make_state(buttons=BUTTONS["A"] | BUTTONS["B"]), 0.02)
        self.assertFalse(engine.enabled)
        self.assertIn("simulated SendInput failure", engine.last_error)
        self.assertEqual(
            output.events,
            [("X", True), ("Y", True), ("X", False)],
        )

    def test_stop_and_panic_release_everything(self) -> None:
        output = FakeOutput()
        engine = self.armed_engine(
            output,
            mappings={"LB": "Shift"},
            macros={"RB": [{"key": "F1", "hold_ms": 1000}]},
        )
        engine.tick(make_state(buttons=BUTTONS["LB"] | BUTTONS["RB"]), 0.01)
        output.panic = True
        engine.tick(make_state(buttons=BUTTONS["LB"] | BUTTONS["RB"]), 0.02)
        self.assertFalse(engine.enabled)
        self.assertEqual(
            output.events,
            [
                ("Shift", True),
                ("F1", True),
                ("Shift", False),
                ("F1", False),
            ],
        )

        output.panic = False
        engine.enabled = True
        engine.tick(make_state(), 0.03)
        engine.tick(make_state(buttons=BUTTONS["LB"]), 0.04)
        engine.stop()
        self.assertFalse(engine.enabled)
        self.assertEqual(output.events[-2:], [("Shift", True), ("Shift", False)])

    def test_mouse_deadzone_time_scaling_and_dt_clamp(self) -> None:
        output = FakeOutput()
        engine = self.armed_engine(
            output,
            mappings={},
            macros={},
            mouse_enabled=True,
            mouse_speed=12,
            mouse_deadzone=8000,
        )
        engine.tick(make_state(), 0.0)
        engine.tick(make_state(rx=8000), 1.0)
        self.assertEqual(output.moves, [])

        engine.tick(make_state(rx=32767, ry=0), 1.1)
        self.assertEqual(output.moves, [(36, 0)])
        engine.tick(make_state(), 1.2)
        engine.tick(make_state(rx=32767, ry=32767), 1.21)
        self.assertEqual(output.moves[-1], (5, -5))

    def test_mouse_uses_configured_radial_deadzone(self) -> None:
        output = FakeOutput()
        engine = self.armed_engine(
            output,
            mappings={},
            macros={},
            mouse_enabled=True,
            mouse_speed=12,
            mouse_deadzone=1000,
        )
        engine.tick(make_state(rx=1500), 0.1)
        self.assertEqual(output.moves, [(1, 0)])


if __name__ == "__main__":
    unittest.main()
