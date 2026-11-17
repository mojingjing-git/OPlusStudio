"""Small, dependency-free Windows input primitives.

The module is importable on every platform. Native libraries are opened lazily,
so importing it never polls a controller, reads the keyboard, sends input, or
changes vibration state.
"""

from __future__ import annotations

import ctypes
import math
import os
from dataclasses import dataclass
from typing import Callable


ERROR_SUCCESS = 0

# Windows SDK XInput button masks. Keeping these public makes configuration
# code independent of the ctypes structures below.
BUTTONS = {
    "A": 0x1000,
    "B": 0x2000,
    "X": 0x4000,
    "Y": 0x8000,
    "LB": 0x0100,
    "RB": 0x0200,
    "Back": 0x0020,
    "Start": 0x0010,
    "LS": 0x0040,
    "RS": 0x0080,
    "Up": 0x0001,
    "Down": 0x0002,
    "Left": 0x0004,
    "Right": 0x0008,
}


# Fixed-width aliases are important: ctypes.c_long is 8 bytes on some non-
# Windows hosts, while the Windows ABI defines LONG as 32 bits. This keeps the
# INPUT union layout correct both on Windows and when tests inspect it elsewhere.
DWORD = ctypes.c_uint32
WORD = ctypes.c_uint16
BYTE = ctypes.c_ubyte
LONG = ctypes.c_int32
SHORT = ctypes.c_int16
UINT = ctypes.c_uint32
ULONG_PTR = ctypes.c_uint64 if ctypes.sizeof(ctypes.c_void_p) == 8 else ctypes.c_ulong


class XINPUT_GAMEPAD(ctypes.Structure):
    _fields_ = (
        ("wButtons", WORD),
        ("bLeftTrigger", BYTE),
        ("bRightTrigger", BYTE),
        ("sThumbLX", SHORT),
        ("sThumbLY", SHORT),
        ("sThumbRX", SHORT),
        ("sThumbRY", SHORT),
    )


class XINPUT_STATE(ctypes.Structure):
    _fields_ = (
        ("dwPacketNumber", DWORD),
        ("Gamepad", XINPUT_GAMEPAD),
    )


class XINPUT_VIBRATION(ctypes.Structure):
    _fields_ = (
        ("wLeftMotorSpeed", WORD),
        ("wRightMotorSpeed", WORD),
    )


class MOUSEINPUT(ctypes.Structure):
    _fields_ = (
        ("dx", LONG),
        ("dy", LONG),
        ("mouseData", DWORD),
        ("dwFlags", DWORD),
        ("time", DWORD),
        ("dwExtraInfo", ULONG_PTR),
    )


class KEYBDINPUT(ctypes.Structure):
    _fields_ = (
        ("wVk", WORD),
        ("wScan", WORD),
        ("dwFlags", DWORD),
        ("time", DWORD),
        ("dwExtraInfo", ULONG_PTR),
    )


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = (
        ("uMsg", DWORD),
        ("wParamL", WORD),
        ("wParamH", WORD),
    )


class _INPUTUNION(ctypes.Union):
    _fields_ = (
        ("mi", MOUSEINPUT),
        ("ki", KEYBDINPUT),
        ("hi", HARDWAREINPUT),
    )


class INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = (
        ("type", DWORD),
        ("u", _INPUTUNION),
    )


@dataclass(frozen=True, slots=True)
class State:
    index: int
    packet: int
    buttons: int
    left_trigger: int
    right_trigger: int
    lx: int
    ly: int
    rx: int
    ry: int

    def active_inputs(
        self,
        deadzone: int = 8000,
        trigger_threshold: int = 40,
    ) -> set[str]:
        """Return the currently active semantic input names.

        Stick components and trigger values activate strictly beyond their
        respective threshold.
        """

        deadzone = max(0, min(32767, int(deadzone)))
        trigger_threshold = max(0, min(255, int(trigger_threshold)))

        active = {
            name for name, mask in BUTTONS.items() if int(self.buttons) & mask
        }
        if int(self.left_trigger) > trigger_threshold:
            active.add("LT")
        if int(self.right_trigger) > trigger_threshold:
            active.add("RT")

        # A move including the deadzone itself is neutral. This avoids a one-
        # count input at rest and gives callers a stable threshold contract.
        if int(self.lx) < -deadzone:
            active.add("LX-")
        if int(self.lx) > deadzone:
            active.add("LX+")
        if int(self.ly) < -deadzone:
            active.add("LY-")
        if int(self.ly) > deadzone:
            active.add("LY+")
        if int(self.rx) < -deadzone:
            active.add("RX-")
        if int(self.rx) > deadzone:
            active.add("RX+")
        if int(self.ry) < -deadzone:
            active.add("RY-")
        if int(self.ry) > deadzone:
            active.add("RY+")
        return active


class XInput:
    """Read and vibrate the four documented XInput 1.4 slots."""

    def __init__(
        self,
        get_state: Callable | None = None,
        set_state: Callable | None = None,
    ) -> None:
        self._get_state = get_state
        self._set_state = set_state
        if os.name == "nt" and (self._get_state is None or self._set_state is None):
            try:
                library = ctypes.WinDLL("XInput1_4.dll")
                if self._get_state is None:
                    getter = library.XInputGetState
                    getter.argtypes = (DWORD, ctypes.POINTER(XINPUT_STATE))
                    getter.restype = DWORD
                    self._get_state = getter
                if self._set_state is None:
                    setter = library.XInputSetState
                    setter.argtypes = (DWORD, ctypes.POINTER(XINPUT_VIBRATION))
                    setter.restype = DWORD
                    self._set_state = setter
                self._library = library
            except (AttributeError, OSError):
                self._library = None
        else:
            self._library = None

    @staticmethod
    def _validate_index(index: int) -> int:
        index = int(index)
        if not 0 <= index < 4:
            raise ValueError("XInput slot must be in the range 0..3")
        return index

    def read(self, index: int) -> State | None:
        index = self._validate_index(index)
        if self._get_state is None:
            return None

        raw = XINPUT_STATE()
        try:
            result = self._get_state(index, ctypes.byref(raw))
        except (OSError, ctypes.ArgumentError):
            return None
        if int(result) != ERROR_SUCCESS:
            return None

        gamepad = raw.Gamepad
        return State(
            index=index,
            packet=int(raw.dwPacketNumber),
            buttons=int(gamepad.wButtons),
            left_trigger=int(gamepad.bLeftTrigger),
            right_trigger=int(gamepad.bRightTrigger),
            lx=int(gamepad.sThumbLX),
            ly=int(gamepad.sThumbLY),
            rx=int(gamepad.sThumbRX),
            ry=int(gamepad.sThumbRY),
        )

    def vibrate(self, index: int, left_float: float, right_float: float) -> None:
        index = self._validate_index(index)
        left = self._motor_value(left_float)
        right = self._motor_value(right_float)
        if self._set_state is None:
            return

        vibration = XINPUT_VIBRATION(left, right)
        try:
            self._set_state(index, ctypes.byref(vibration))
        except (OSError, ctypes.ArgumentError):
            # Vibration is best effort; disconnecting a controller is not an
            # error that should tear down the caller's polling loop.
            return

    @staticmethod
    def _motor_value(value: float) -> int:
        value = float(value)
        if not math.isfinite(value):
            raise ValueError("motor strength must be finite")
        return int(round(max(0.0, min(1.0, value)) * 65535))


_KEY_NAMES = tuple(
    [chr(code) for code in range(ord("A"), ord("Z") + 1)]
    + [str(number) for number in range(10)]
    + [
        "Space",
        "Enter",
        "Escape",
        "Tab",
        "Shift",
        "Ctrl",
        "Alt",
        *(f"F{number}" for number in range(1, 13)),
        "Up",
        "Down",
        "Left",
        "Right",
        "MouseLeft",
        "MouseRight",
        "MouseMiddle",
    ]
)

_KEYS_BY_CASEFOLD = {name.casefold(): name for name in _KEY_NAMES}
_KEY_CODES = {
    "Space": 0x20,
    "Enter": 0x0D,
    "Escape": 0x1B,
    "Tab": 0x09,
    "Shift": 0x10,
    "Ctrl": 0x11,
    "Alt": 0x12,
    "Up": 0x26,
    "Down": 0x28,
    "Left": 0x25,
    "Right": 0x27,
}
_KEY_CODES.update({chr(code): code for code in range(ord("A"), ord("Z") + 1)})
_KEY_CODES.update({str(number): ord(str(number)) for number in range(10)})
_KEY_CODES.update({f"F{number}": 0x6F + number for number in range(1, 13)})

_MOUSE_BUTTON_FLAGS = {
    "MouseLeft": (0x0002, 0x0004),
    "MouseRight": (0x0008, 0x0010),
    "MouseMiddle": (0x0020, 0x0040),
}

INPUT_MOUSE = 0
INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_EXTENDEDKEY = 0x0001
MOUSEEVENTF_MOVE = 0x0001
VK_F8 = 0x77


class WindowsOutput:
    """Send keyboard/mouse input and expose the F8 panic state."""

    def __init__(
        self,
        send_input: Callable | None = None,
        get_async_key_state: Callable | None = None,
    ) -> None:
        self._send_input = send_input
        self._get_async_key_state = get_async_key_state
        self._user32 = None

    @staticmethod
    def available_keys() -> list[str]:
        return list(_KEY_NAMES)

    @staticmethod
    def _resolve_key(name: str) -> str:
        canonical = _KEYS_BY_CASEFOLD.get(str(name).casefold())
        if canonical is None:
            raise ValueError(f"unsupported output key: {name!r}")
        return canonical

    def key(self, name: str, down: bool) -> None:
        canonical = self._resolve_key(name)
        if canonical in _MOUSE_BUTTON_FLAGS:
            down_flag, up_flag = _MOUSE_BUTTON_FLAGS[canonical]
            event = INPUT()
            event.type = INPUT_MOUSE
            event.mi = MOUSEINPUT(
                dx=0,
                dy=0,
                mouseData=0,
                dwFlags=down_flag if down else up_flag,
                time=0,
                dwExtraInfo=0,
            )
            self._send(event)
            return

        flags = 0 if down else KEYEVENTF_KEYUP
        if canonical in {"Up", "Down", "Left", "Right"}:
            flags |= KEYEVENTF_EXTENDEDKEY
        event = INPUT()
        event.type = INPUT_KEYBOARD
        event.ki = KEYBDINPUT(
            wVk=_KEY_CODES[canonical],
            wScan=0,
            dwFlags=flags,
            time=0,
            dwExtraInfo=0,
        )
        self._send(event)

    def move_mouse(self, dx: int, dy: int) -> None:
        try:
            mouse_dx = int(round(dx))
            mouse_dy = int(round(dy))
        except (TypeError, ValueError, OverflowError) as exc:
            raise ValueError("mouse movement must be finite numeric values") from exc
        mouse_dx = max(-(2**31), min(2**31 - 1, mouse_dx))
        mouse_dy = max(-(2**31), min(2**31 - 1, mouse_dy))
        event = INPUT()
        event.type = INPUT_MOUSE
        event.mi = MOUSEINPUT(
            dx=mouse_dx,
            dy=mouse_dy,
            mouseData=0,
            dwFlags=MOUSEEVENTF_MOVE,
            time=0,
            dwExtraInfo=0,
        )
        self._send(event)

    def panic_pressed(self) -> bool:
        getter = self._get_async_key_state
        if getter is None:
            if os.name != "nt":
                return False
            try:
                user32 = self._get_user32()
                getter = user32.GetAsyncKeyState
                getter.argtypes = (ctypes.c_int,)
                getter.restype = SHORT
            except (AttributeError, OSError):
                return False
        try:
            value = int(getter(VK_F8))
        except (OSError, TypeError, ValueError, ctypes.ArgumentError):
            return False
        return bool(value & 0x8000)

    def _send(self, event: INPUT) -> None:
        sender = self._send_input
        if sender is None:
            if os.name != "nt":
                raise OSError("SendInput is only available on Windows")
            user32 = self._get_user32()
            sender = user32.SendInput
            sender.argtypes = (UINT, ctypes.POINTER(INPUT), ctypes.c_int)
            sender.restype = UINT
        sent = sender(1, ctypes.byref(event), ctypes.sizeof(INPUT))
        if int(sent) != 1:
            raise OSError(
                ctypes.get_last_error(),
                f"SendInput inserted {int(sent)} of 1 event(s)",
            )

    def _get_user32(self):
        if self._user32 is None:
            self._user32 = ctypes.WinDLL("user32", use_last_error=True)
        return self._user32


def available_keys() -> list[str]:
    """Return the canonical output key names accepted by WindowsOutput."""

    return WindowsOutput.available_keys()


def active_inputs(
    state: State,
    deadzone: int = 8000,
    trigger_threshold: int = 40,
) -> set[str]:
    """Functional form of State.active_inputs."""

    return state.active_inputs(deadzone=deadzone, trigger_threshold=trigger_threshold)


__all__ = [
    "BUTTONS",
    "State",
    "XInput",
    "WindowsOutput",
    "active_inputs",
    "available_keys",
    "INPUT",
    "KEYBDINPUT",
    "MOUSEINPUT",
    "XINPUT_STATE",
    "XINPUT_VIBRATION",
]
