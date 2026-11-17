"""Read-only WinMM sampling for the O+ USB DInput identity 0079:181C."""
from __future__ import annotations

import argparse
import ctypes as c
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import time

TARGET = (0x0079, 0x181C)


class JoyCaps(c.Structure):
    _fields_ = [("mid", c.c_uint16), ("pid", c.c_uint16), ("name_utf16", c.c_uint16*32)] + [
        (name, c.c_uint32) for name in (
            "xmin", "xmax", "ymin", "ymax", "zmin", "zmax", "buttons", "periodmin", "periodmax",
            "rmin", "rmax", "umin", "umax", "vmin", "vmax", "caps", "maxaxes", "axes", "maxbuttons")
    ] + [("regkey_utf16", c.c_uint16*32), ("oem_utf16", c.c_uint16*260)]


class JoyInfo(c.Structure):
    _fields_ = [(name, c.c_uint32) for name in (
        "size", "flags", "x", "y", "z", "r", "u", "v", "buttons", "number", "pov", "reserved1", "reserved2")]


class DInputProbe:
    def __init__(self):
        if os.name != "nt":
            raise RuntimeError("DInput 采样需要 Windows")
        self.api = c.WinDLL("winmm.dll")
        self.api.joyGetDevCapsW.argtypes = [c.c_size_t, c.POINTER(JoyCaps), c.c_uint32]
        self.api.joyGetDevCapsW.restype = c.c_uint32
        self.api.joyGetPosEx.argtypes = [c.c_uint32, c.POINTER(JoyInfo)]
        self.api.joyGetPosEx.restype = c.c_uint32
        self.api.joyGetNumDevs.argtypes = []
        self.api.joyGetNumDevs.restype = c.c_uint32

    def devices(self):
        result = []
        for index in range(min(self.api.joyGetNumDevs(), 16)):
            caps = JoyCaps()
            if self.api.joyGetDevCapsW(index, c.byref(caps), c.sizeof(caps)):
                continue
            if (caps.mid, caps.pid) != TARGET or self.read(index) is None:
                continue
            result.append({"index": index, "vid": f"{caps.mid:04X}", "pid": f"{caps.pid:04X}",
                           "name": bytes(caps.name_utf16).decode("utf-16-le").split("\0", 1)[0],
                           "buttons": caps.buttons, "axes": caps.axes, "capabilities": caps.caps})
        return result

    def read(self, index):
        data = JoyInfo()
        data.size, data.flags = c.sizeof(data), 0xFF
        if self.api.joyGetPosEx(index, c.byref(data)):
            return None
        return {name: int(getattr(data, name)) for name in ("x", "y", "z", "r", "u", "v", "buttons", "pov")}

    def capture(self, label, seconds=30, presses=3):
        if not 0 < seconds <= 60:
            raise ValueError("采样时长必须大于 0 且不超过 60 秒")
        devices = self.devices()
        if len(devices) != 1:
            raise RuntimeError(f"需要恰好一个在线 0079:181C 手柄，当前为 {len(devices)}")
        device = devices[0]
        result = {"label": label, "timestamp": datetime.now(timezone.utc).isoformat(),
                  "device": device, "events": [], "press_release_cycles": 0,
                  "note": "原始 DInput 输入记录，不预设任何按钮属于背键。"}
        start = time.monotonic()
        previous = None
        armed = False
        held = False
        while time.monotonic()-start < seconds:
            state = self.read(device["index"])
            if state is None:
                result["disconnected"] = True
                break
            active = bool(state["buttons"] or state["pov"] != 65535)
            if not active:
                armed = True
            signature = (state["buttons"], state["pov"])
            if signature != previous:
                event = {"ms": round((time.monotonic()-start)*1000), **state,
                         "pressed_buttons": [i+1 for i in range(32) if state["buttons"] & (1 << i)]}
                result["events"].append(event)
                print(json.dumps(event, ensure_ascii=True), flush=True)
                previous = signature
            if armed and held and not active:
                result["press_release_cycles"] += 1
                if presses and result["press_release_cycles"] >= presses:
                    break
            held = active
            time.sleep(.005)
        result["duration_s"] = round(time.monotonic()-start, 3)
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--label", required=True)
    parser.add_argument("--seconds", type=float, default=30)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    result = DInputProbe().capture(args.label, args.seconds)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"captured": result["press_release_cycles"], "duration_s": result["duration_s"]}), flush=True)


if __name__ == "__main__":
    main()
