from __future__ import annotations

import argparse
import asyncio
from dataclasses import asdict
import json
from pathlib import Path
import time


def main(argv=None):
    parser = argparse.ArgumentParser(description="O+ Studio — Windows 手柄工具")
    parser.add_argument("--diagnose", action="store_true", help="只读 PnP / HID / XInput 诊断")
    parser.add_argument("--classic", action="store_true", help="打开经典工具界面")
    parser.add_argument("--scan-ble", action="store_true", help="扫描 KeyLinker 配置广播")
    parser.add_argument("--identify", metavar="ADDRESS", help="查询所选 BLE 设备身份和能力")
    parser.add_argument("--sample", type=float, metavar="SECONDS", help="只读采样 XInput")
    parser.add_argument("--slot", type=int, choices=range(4), default=0)
    parser.add_argument("--out", type=Path, help="JSON 输出路径")
    args = parser.parse_args(argv)
    command_mode = args.diagnose or args.scan_ble or args.identify or args.sample is not None
    try:
        result = run(args, parser)
        failed = False
    except Exception as exc:
        if not command_mode:
            raise
        result = {"error": type(exc).__name__, "message": str(exc)}
        failed = True
    if result is None:
        return
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text, encoding="utf-8")
    else:
        print(text)
    if failed:
        raise SystemExit(1)


def run(args, parser):
    result = None
    if args.diagnose:
        from .diagnostics import collect_report
        from .windows_input import XInput
        result = collect_report()
        pad = XInput()
        result["xinput"] = [asdict(state) for index in range(4) if (state := pad.read(index)) is not None]
    elif args.scan_ble:
        from .ble import scan
        result = asyncio.run(scan())
    elif args.identify:
        from .ble import identify
        result = asyncio.run(identify(args.identify))
    elif args.sample is not None:
        if not 0 < args.sample <= 60:
            parser.error("采样时长必须为 0–60 秒")
        from .windows_input import XInput
        pad = XInput()
        samples, previous = [], None
        until = time.monotonic() + args.sample
        while time.monotonic() < until:
            state = pad.read(args.slot)
            signal = asdict(state) if state else None
            if signal != previous:
                samples.append({"monotonic": time.monotonic(), "state": signal})
                previous = signal
            time.sleep(.01)
        result = {"slot": args.slot, "samples": samples}
    else:
        if args.classic:
            from .app import main as gui
        else:
            from .desktop import main as gui
        gui()
        return
    return result


if __name__ == "__main__":
    main()
