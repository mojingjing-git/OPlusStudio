"""Read HID button usage metadata from already-enumerated gamepad interfaces.

No input, output or Feature reports are read or written by this helper.
"""
from __future__ import annotations

import argparse
import ctypes as c
import json
from pathlib import Path

from . import diagnostics as d


class ButtonCaps(c.Structure):
    _fields_ = [("usage_page", c.c_uint16), ("report_id", c.c_ubyte), ("is_alias", c.c_ubyte),
                ("bit_field", c.c_uint16), ("link_collection", c.c_uint16),
                ("link_usage", c.c_uint16), ("link_usage_page", c.c_uint16),
                ("is_range", c.c_ubyte), ("is_string_range", c.c_ubyte),
                ("is_designator_range", c.c_ubyte), ("is_absolute", c.c_ubyte),
                ("report_count", c.c_uint16), ("reserved2", c.c_uint16),
                ("reserved", c.c_uint32*9), ("range_or_usage", c.c_uint16*8)]


def button_caps(device_path):
    if not d._is_windows():
        raise RuntimeError("HID 元数据需要 Windows")
    _, hid, kernel = d._load_windows_apis()
    handle = d._open_hid_handle(kernel, device_path)
    if handle is None:
        raise OSError("无法打开手柄 HID 元数据接口")
    preparsed = c.POINTER(d._HIDP_PREPARSED_DATA)()
    try:
        if not hid.HidD_GetPreparsedData(handle, c.byref(preparsed)):
            raise c.WinError(c.get_last_error())
        caps = d._HIDP_CAPS()
        if hid.HidP_GetCaps(preparsed, c.byref(caps)) != 0x00110000:
            raise OSError("HID 描述解析失败")
        count = int(caps.NumberInputButtonCaps)
        if count > 1024:
            raise ValueError("异常的 HID button capability 数量")
        if not count:
            return []
        array = (ButtonCaps*count)()
        actual = c.c_uint16(count)
        hid.HidP_GetButtonCaps.argtypes = [c.c_int, c.POINTER(ButtonCaps), c.POINTER(c.c_uint16), c.POINTER(d._HIDP_PREPARSED_DATA)]
        hid.HidP_GetButtonCaps.restype = c.c_int32
        if hid.HidP_GetButtonCaps(0, array, c.byref(actual), preparsed) != 0x00110000:
            raise OSError("HID 按键 usage 元数据解析失败")
        return [{"usage_page": entry.usage_page, "report_id": entry.report_id,
                 "usage_min": entry.range_or_usage[0],
                 "usage_max": entry.range_or_usage[1] if entry.is_range else entry.range_or_usage[0],
                 "is_range": bool(entry.is_range), "is_alias": bool(entry.is_alias),
                 "link_collection": entry.link_collection,
                 "report_count": entry.report_count}
                for entry in array[:actual.value]]
    finally:
        if preparsed:
            hid.HidD_FreePreparsedData(preparsed)
        kernel.CloseHandle(handle)


def from_report(report):
    result = []
    for device in report.get("hid", []):
        row = {"device_path": device["device_path"], "vendor_id": device["vendor_id"],
               "product_id": device["product_id"]}
        try:
            row["button_caps"] = button_caps(device["device_path"])
        except (OSError, ValueError) as exc:
            row["error"] = str(exc)
        result.append(row)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    result = from_report(json.loads(args.report.read_text(encoding="utf-8-sig")))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    main()
