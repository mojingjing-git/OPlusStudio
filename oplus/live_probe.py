"""Bounded live-data investigation with a fixed enter/exit pair, no config writes.

This is a temporary device mode change, not a read-only settings query. It
does not infer physical back-button identities from macro or XInput masks.
"""
from __future__ import annotations

import asyncio
from dataclasses import asdict
import time

from . import protocol as p
from .board import BoardSession
from .vendor import keylinker as codec
from .windows_input import XInput


class LiveProbe(BoardSession):
    async def control(self, operation):
        if not self.verified or operation not in ("start", "button_start", "stop"):
            raise ValueError("不允许的实时探针状态切换")
        opcode = 0x1E if operation == "stop" else 0x1D
        payload = bytes.fromhex("05 df ab 00 06 05") if operation == "button_start" else bytes.fromhex("02 df ab")
        self.serial += 1
        serial = self.serial % 128 + (128 if self.serial % 2 == 0 else 0)
        wire = codec.build(opcode, payload, serial=serial)
        checked = p.parse(wire)
        if checked.opcode != opcode or checked.payload != payload:
            raise ValueError("实时探针命令校验失败")
        self.trace.append({"direction": "tx", "opcode": opcode, "payload": payload.hex(" "),
                           "serial": serial, "wire": wire.hex(" ")})
        characteristic = self.client.services.get_characteristic(p.CONFIG_WRITE)
        await self.client.write_gatt_char(characteristic, wire, response="write" in characteristic.properties)

    def notified(self, sender, raw):
        super().notified(sender, raw)
        if self.trace:
            self.trace[-1]["monotonic"] = time.monotonic()


async def capture(address, seconds=3, *, buttons=False, before_start=None):
    if not 0 < seconds <= 15:
        raise ValueError("实时探针持续时间为 0–15 秒")
    xinput = XInput()
    state = xinput.read(0)
    result = {"duration": seconds, "mode": "button_test" if buttons else "status", "back_key_support": "unknown",
              "xinput_before": asdict(state) if state else None}
    async with LiveProbe(address) as session:
        before = await session.record(0xB0, b"\x00\x01")
        try:
            # Allow an operator to wait for physical readiness after connection,
            # without consuming the bounded live-mode interval.
            if before_start is not None:
                await before_start()
            # Selecting the app's button-test page does not start the live
            # stream. Always issue the documented stream request first.
            await session.control("start")
            if buttons:
                await session.control("button_start")
            result["start_monotonic"] = time.monotonic()
            deadline = time.monotonic()+seconds
            next_page = time.monotonic()+.5
            result["xinput_events"] = []
            previous_input = object()
            while time.monotonic() < deadline:
                state = xinput.read(0)
                signature = (state.buttons, state.left_trigger, state.right_trigger) if state else None
                if signature != previous_input:
                    result["xinput_events"].append({"monotonic": time.monotonic(),
                                                     "state": asdict(state) if state else None})
                    previous_input = signature
                if buttons and time.monotonic() >= next_page:
                    # KeyLinker keeps its selected test page alive periodically.
                    await session.control("button_start")
                    next_page = time.monotonic()+.5
                await asyncio.sleep(min(.01, max(0, deadline-time.monotonic())))
        finally:
            try:
                await session.control("stop")
                result["stop_monotonic"] = time.monotonic()
                await asyncio.sleep(.4)
                after = await session.record(0xB0, b"\x00\x01")
                result["capabilities_unchanged"] = before == after
            finally:
                result["trace"] = list(session.trace)
    # Explicit BLE disconnect above is also a fallback for stopping a stream.
    result["live_frames"] = [record for record in result["trace"]
                             if record.get("direction") == "rx" and record.get("opcode") == 0x1F]
    state = xinput.read(0)
    result["xinput_after"] = asdict(state) if state else None
    result["post_exit_live_frames"] = sum(1 for record in result["live_frames"]
        if record.get("monotonic", 0) > result.get("stop_monotonic", float("inf"))+.2)
    return result


def main():
    import argparse
    import json
    from pathlib import Path

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("address")
    parser.add_argument("--seconds", type=float, default=15)
    parser.add_argument("--buttons", action="store_true")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--ready-file", type=Path)
    parser.add_argument("--go-file", type=Path)
    args = parser.parse_args()
    if bool(args.ready_file) != bool(args.go_file):
        parser.error("--ready-file and --go-file must be used together")

    async def wait_for_operator():
        if args.go_file.exists():
            raise ValueError("Start marker already exists; use fresh marker paths")
        args.ready_file.parent.mkdir(parents=True, exist_ok=True)
        args.ready_file.write_text("connected; live mode has not started", encoding="utf-8")
        deadline = time.monotonic()+120
        while not args.go_file.exists():
            if time.monotonic() >= deadline:
                raise TimeoutError("Operator did not start within 120 seconds")
            await asyncio.sleep(.1)

    try:
        result = asyncio.run(capture(args.address, args.seconds, buttons=args.buttons,
                                    before_start=wait_for_operator if args.ready_file else None))
    except Exception as exc:
        result = {"error": str(exc), "error_type": type(exc).__name__}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    raise SystemExit(1 if "error" in result else 0)


if __name__ == "__main__":
    main()
