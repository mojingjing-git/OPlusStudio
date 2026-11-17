"""Read-only Windows hardware diagnostics for O+ controller investigations.

The module deliberately separates device discovery from any device I/O.  HID
objects are opened with zero desired access solely so SetupAPI/HID can return
attributes and the preparsed report descriptor.  It never reads an input
report and never sends output or feature reports.
"""

from __future__ import annotations

import base64
import ctypes
import datetime as _datetime
import json
import locale
import os
import platform as _platform
import re
import shutil
import subprocess
import threading
from ctypes import wintypes
from typing import Any, Iterable, Mapping, Sequence


COLLECT_REPORT_KEYS = (
    "timestamp",
    "platform",
    "pnp",
    "hid",
    "bluetooth",
    "bluetooth_candidates",
    "radio_context",
    "errors",
    "conclusions",
)

_CREATE_NO_WINDOW = 0x08000000
_PNP_TIMEOUT_SECONDS = 30
_ERROR_NO_MORE_ITEMS = 259
_ERROR_INSUFFICIENT_BUFFER = 122
_HIDP_STATUS_SUCCESS = 0x00110000

_DIGCF_PRESENT = 0x00000002
_DIGCF_DEVICEINTERFACE = 0x00000010
_GENERIC_READ = 0x80000000
_GENERIC_WRITE = 0x40000000
_FILE_SHARE_READ = 0x00000001
_FILE_SHARE_WRITE = 0x00000002
_OPEN_EXISTING = 3
_FILE_ATTRIBUTE_NORMAL = 0x00000080

_SPDRP_DEVICEDESC = 0x00000000
_SPDRP_FRIENDLYNAME = 0x0000000C

_GUID_DEVINTERFACE_HID = "{4D1E55B2-F16F-11CF-88CB-001111000030}"
_XBOX_360_VID = 0x045E
_XBOX_360_PID = 0x028E
_INTEL_BLUETOOTH_CANDIDATE_VID = 0x8087
_INTEL_BLUETOOTH_CANDIDATE_PID = 0x0029
_INTEL_AX200_WIFI_VENDOR_ID = 0x8086
_INTEL_AX200_WIFI_DEVICE_ID = 0x2723
_HID_USAGE_PAGE_GENERIC_DESKTOP = 0x01
_HID_USAGE_JOYSTICK = 0x04
_HID_USAGE_GAMEPAD = 0x05
_HID_USAGE_PAGE_VENDOR_DEFINED = 0xFF00


class _GUID(ctypes.Structure):
    _fields_ = (
        ("Data1", wintypes.DWORD),
        ("Data2", wintypes.WORD),
        ("Data3", wintypes.WORD),
        ("Data4", wintypes.BYTE * 8),
    )

    @classmethod
    def from_string(cls, value: str) -> "_GUID":
        cleaned = value.strip("{}").replace("-", "")
        if len(cleaned) != 32:
            raise ValueError(f"invalid GUID: {value!r}")
        data4 = bytes.fromhex(cleaned[16:])
        return cls(
            int(cleaned[:8], 16),
            int(cleaned[8:12], 16),
            int(cleaned[12:16], 16),
            (wintypes.BYTE * 8)(*data4),
        )


class _SP_DEVINFO_DATA(ctypes.Structure):
    _fields_ = (
        ("cbSize", wintypes.DWORD),
        ("ClassGuid", _GUID),
        ("DevInst", wintypes.DWORD),
        ("Reserved", ctypes.c_size_t),
    )


class _SP_DEVICE_INTERFACE_DATA(ctypes.Structure):
    _fields_ = (
        ("cbSize", wintypes.DWORD),
        ("InterfaceClassGuid", _GUID),
        ("Flags", wintypes.DWORD),
        ("Reserved", ctypes.c_size_t),
    )


class _SP_DEVICE_INTERFACE_DETAIL_DATA_W(ctypes.Structure):
    _fields_ = (
        ("cbSize", wintypes.DWORD),
        ("DevicePath", wintypes.WCHAR * 1),
    )


class _HIDD_ATTRIBUTES(ctypes.Structure):
    _fields_ = (
        ("Size", wintypes.DWORD),
        ("VendorID", wintypes.USHORT),
        ("ProductID", wintypes.USHORT),
        ("VersionNumber", wintypes.USHORT),
    )


class _HIDP_PREPARSED_DATA(ctypes.Structure):
    pass


class _HIDP_CAPS(ctypes.Structure):
    _fields_ = (
        ("Usage", wintypes.USHORT),
        ("UsagePage", wintypes.USHORT),
        ("InputReportByteLength", wintypes.USHORT),
        ("OutputReportByteLength", wintypes.USHORT),
        ("FeatureReportByteLength", wintypes.USHORT),
        ("Reserved", wintypes.USHORT * 17),
        ("NumberLinkCollectionNodes", wintypes.USHORT),
        ("NumberInputButtonCaps", wintypes.USHORT),
        ("NumberInputValueCaps", wintypes.USHORT),
        ("NumberInputDataIndices", wintypes.USHORT),
        ("NumberOutputButtonCaps", wintypes.USHORT),
        ("NumberOutputValueCaps", wintypes.USHORT),
        ("NumberOutputDataIndices", wintypes.USHORT),
        ("NumberFeatureButtonCaps", wintypes.USHORT),
        ("NumberFeatureValueCaps", wintypes.USHORT),
        ("NumberFeatureDataIndices", wintypes.USHORT),
    )


_INVALID_HANDLE_VALUE = (1 << (ctypes.sizeof(ctypes.c_void_p) * 8)) - 1
_API_LOCK = threading.Lock()
_SETUPAPI: Any | None = None
_HID: Any | None = None
_KERNEL32: Any | None = None


_POWERSHELL_PNP_SCRIPT = r"""
$ErrorActionPreference = 'Stop'

try {
    $targetVidPids = __TARGET_VID_PIDS__
    $allDevices = @(Get-PnpDevice -PresentOnly -ErrorAction Stop)
    $selectedDevices = @(
        $allDevices | Where-Object {
            $id = [string]$_.InstanceId
            $class = [string]$_.Class
            $friendly = [string]$_.FriendlyName
            $service = ([string]$_.Service).ToLowerInvariant()
            $isIntelBluetoothCandidate = $id -match '(?i)^USB\\VID_8087&PID_0029(?:\\|$)'
            $isIntelRadioContext = $id -match '(?i)^PCI\\VEN_8086&DEV_2723(?:\\|&|$)'
            $pair = ''
            if ($id -match '(?i)VID_([0-9A-F]{4})&PID_([0-9A-F]{4})') {
                $pair = ($matches[1].ToLowerInvariant() + ':' + $matches[2].ToLowerInvariant())
            }
            $targetVidPidMatch = $pair -and ($targetVidPids -contains $pair)

            $gamepadRelated = (
                $targetVidPidMatch -or
                ($id -match '(?i)VID_045E&PID_028E') -or
                ($class -in @('XnaComposite', 'XboxComposite', 'XboxGamepad')) -or
                (
                    $class -eq 'HIDClass' -and
                    (
                        $friendly -match '(?i)xbox|gamepad|game\s*controller|joystick|手柄|游戏控制器' -or
                        $service -in @('xusb22', 'xinputhid')
                    )
                )
            )

            $bluetoothAdapter = (
                $class -in @('Bluetooth', 'BluetoothRadio') -and
                (
                    $service -in @('bthusb', 'ibtusb', 'bthenum', 'bthleenum') -or
                    $id -match '(?i)^BTH\\MS_BTHBRB\\' -or
                    (
                        $id -match '(?i)^USB\\' -and
                        $friendly -match '(?i)bluetooth|蓝牙'
                    )
                )
            )

            $gamepadRelated -or $bluetoothAdapter -or $isIntelBluetoothCandidate -or $isIntelRadioContext
        }
    )

    $propertyMap = @{}
    $warnings = @()
    if ($selectedDevices.Count -gt 0) {
        try {
            $keys = @(
                'DEVPKEY_Device_Parent',
                'DEVPKEY_Device_ContainerId',
                'DEVPKEY_Device_Service',
                'DEVPKEY_Device_BusReportedDeviceDesc'
            )
            $properties = @(
                $selectedDevices |
                    Get-PnpDeviceProperty -KeyName $keys -ErrorAction Stop
            )
            foreach ($property in $properties) {
                $deviceId = [string]$property.InstanceId
                $key = [string]$property.KeyName
                if (-not $propertyMap.ContainsKey($deviceId)) {
                    $propertyMap[$deviceId] = @{}
                }
                $propertyMap[$deviceId][$key] = [string]$property.Data
            }
        }
        catch {
            $warnings += ('Get-PnpDeviceProperty: ' + $_.Exception.Message)
        }
    }

    $records = foreach ($device in $selectedDevices) {
        $id = [string]$device.InstanceId
        $class = [string]$device.Class
        $props = $propertyMap[$id]
        if ($null -eq $props) {
            $props = @{}
        }

        $service = [string]$props['DEVPKEY_Device_Service']
        if ([string]::IsNullOrWhiteSpace($service)) {
            $service = [string]$device.Service
        }
        $kindHint = 'gamepad_related'
        if ($id -match '(?i)^USB\\VID_8087&PID_0029(?:\\|$)') {
            $kindHint = 'intel_bluetooth_hardware_candidate'
        }
        elseif ($id -match '(?i)^PCI\\VEN_8086&DEV_2723(?:\\|&|$)') {
            $kindHint = 'intel_wifi_radio_context'
        }
        elseif ($class -in @('Bluetooth', 'BluetoothRadio')) {
            $kindHint = 'bluetooth_adapter'
        }

        [pscustomobject][ordered]@{
            Status = [string]$device.Status
            Class = $class
            FriendlyName = [string]$device.FriendlyName
            InstanceId = $id
            IsPresent = [bool]$device.Present
            Parent = [string]$props['DEVPKEY_Device_Parent']
            ContainerId = [string]$props['DEVPKEY_Device_ContainerId']
            Service = $service
            BusReportedDeviceDesc = [string]$props['DEVPKEY_Device_BusReportedDeviceDesc']
            Problem = [string]$device.Problem
            ProblemDescription = [string]$device.ProblemDescription
            KindHint = $kindHint
        }
    }

    $payload = [ordered]@{
        devices = @($records)
        warnings = @($warnings)
    }
    $json = ConvertTo-Json -InputObject $payload -Depth 6 -Compress
    $encoding = New-Object System.Text.UTF8Encoding($true)
    $bytes = $encoding.GetBytes([string]$json)
    $stream = [Console]::OpenStandardOutput()
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush()
}
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
"""


def _is_windows() -> bool:
    return os.name == "nt" and _platform.system().lower() == "windows"


def _utc_timestamp() -> str:
    return (
        _datetime.datetime.now(_datetime.timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def _platform_details() -> dict[str, Any]:
    return {
        "system": _platform.system(),
        "release": _platform.release(),
        "version": _platform.version(),
        "machine": _platform.machine(),
        "python_pointer_bits": ctypes.sizeof(ctypes.c_void_p) * 8,
        "access_mode": "read_only_enumeration",
    }


def _error_record(
    source: str,
    message: str,
    *,
    error_type: str = "diagnostic_error",
    winerror: int | None = None,
    device_path: str | None = None,
) -> dict[str, Any]:
    record: dict[str, Any] = {
        "source": source,
        "error_type": error_type,
        "message": _clean_text(message, limit=700),
    }
    if winerror is not None:
        record["winerror"] = int(winerror)
    if device_path:
        record["device_path"] = device_path
    return record


def _clean_text(value: Any, *, limit: int = 700) -> str:
    try:
        text = str(value)
    except Exception:
        text = "unknown error"
    text = " ".join(text.replace("\x00", "").split())
    return text[:limit]


def _exception_error(source: str, exc: BaseException) -> dict[str, Any]:
    return _error_record(
        source,
        _clean_text(exc) or exc.__class__.__name__,
        error_type=exc.__class__.__name__,
    )


def _winerror_message(code: int) -> str:
    if not code:
        return "Windows API call failed"
    try:
        return ctypes.FormatError(code)
    except Exception:
        return f"Windows error {code}"


def _load_windows_apis() -> tuple[Any, Any, Any]:
    global _SETUPAPI, _HID, _KERNEL32

    if not _is_windows():
        raise OSError("Windows SetupAPI/HID APIs are unavailable on this platform")
    if _SETUPAPI is not None and _HID is not None and _KERNEL32 is not None:
        return _SETUPAPI, _HID, _KERNEL32

    with _API_LOCK:
        if _SETUPAPI is None or _HID is None or _KERNEL32 is None:
            setupapi = ctypes.WinDLL("setupapi", use_last_error=True)
            hid = ctypes.WinDLL("hid", use_last_error=True)
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

            setupapi.SetupDiGetClassDevsW.argtypes = [
                ctypes.POINTER(_GUID),
                wintypes.LPCWSTR,
                wintypes.HWND,
                wintypes.DWORD,
            ]
            setupapi.SetupDiGetClassDevsW.restype = wintypes.HANDLE
            setupapi.SetupDiDestroyDeviceInfoList.argtypes = [wintypes.HANDLE]
            setupapi.SetupDiDestroyDeviceInfoList.restype = wintypes.BOOL
            setupapi.SetupDiEnumDeviceInterfaces.argtypes = [
                wintypes.HANDLE,
                ctypes.POINTER(_SP_DEVINFO_DATA),
                ctypes.POINTER(_GUID),
                wintypes.DWORD,
                ctypes.POINTER(_SP_DEVICE_INTERFACE_DATA),
            ]
            setupapi.SetupDiEnumDeviceInterfaces.restype = wintypes.BOOL
            setupapi.SetupDiGetDeviceInterfaceDetailW.argtypes = [
                wintypes.HANDLE,
                ctypes.POINTER(_SP_DEVICE_INTERFACE_DATA),
                ctypes.POINTER(_SP_DEVICE_INTERFACE_DETAIL_DATA_W),
                wintypes.DWORD,
                ctypes.POINTER(wintypes.DWORD),
                ctypes.POINTER(_SP_DEVINFO_DATA),
            ]
            setupapi.SetupDiGetDeviceInterfaceDetailW.restype = wintypes.BOOL
            setupapi.SetupDiGetDeviceInstanceIdW.argtypes = [
                wintypes.HANDLE,
                ctypes.POINTER(_SP_DEVINFO_DATA),
                wintypes.LPWSTR,
                wintypes.DWORD,
                ctypes.POINTER(wintypes.DWORD),
            ]
            setupapi.SetupDiGetDeviceInstanceIdW.restype = wintypes.BOOL
            setupapi.SetupDiGetDeviceRegistryPropertyW.argtypes = [
                wintypes.HANDLE,
                ctypes.POINTER(_SP_DEVINFO_DATA),
                wintypes.DWORD,
                ctypes.POINTER(wintypes.DWORD),
                ctypes.POINTER(wintypes.BYTE),
                wintypes.DWORD,
                ctypes.POINTER(wintypes.DWORD),
            ]
            setupapi.SetupDiGetDeviceRegistryPropertyW.restype = wintypes.BOOL

            hid.HidD_GetAttributes.argtypes = [
                wintypes.HANDLE,
                ctypes.POINTER(_HIDD_ATTRIBUTES),
            ]
            hid.HidD_GetAttributes.restype = wintypes.BOOLEAN
            hid.HidD_GetPreparsedData.argtypes = [
                wintypes.HANDLE,
                ctypes.POINTER(ctypes.POINTER(_HIDP_PREPARSED_DATA)),
            ]
            hid.HidD_GetPreparsedData.restype = wintypes.BOOLEAN
            hid.HidP_GetCaps.argtypes = [
                ctypes.POINTER(_HIDP_PREPARSED_DATA),
                ctypes.POINTER(_HIDP_CAPS),
            ]
            hid.HidP_GetCaps.restype = wintypes.LONG
            hid.HidD_FreePreparsedData.argtypes = [
                ctypes.POINTER(_HIDP_PREPARSED_DATA)
            ]
            hid.HidD_FreePreparsedData.restype = wintypes.BOOLEAN

            kernel32.CreateFileW.argtypes = [
                wintypes.LPCWSTR,
                wintypes.DWORD,
                wintypes.DWORD,
                ctypes.c_void_p,
                wintypes.DWORD,
                wintypes.DWORD,
                wintypes.HANDLE,
            ]
            kernel32.CreateFileW.restype = wintypes.HANDLE
            kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
            kernel32.CloseHandle.restype = wintypes.BOOL

            _SETUPAPI = setupapi
            _HID = hid
            _KERNEL32 = kernel32

    return _SETUPAPI, _HID, _KERNEL32


def _parse_vid_pid(device_path: str) -> tuple[int | None, int | None]:
    match = re.search(
        r"(?i)(?:^|[#\\])VID_([0-9A-F]{4})&PID_([0-9A-F]{4})(?:[#\\&]|$)",
        device_path,
    )
    if not match:
        return None, None
    return int(match.group(1), 16), int(match.group(2), 16)


def _is_supported_gamepad(
    vendor_id: int | None,
    product_id: int | None,
    usage_page: int | None,
    usage: int | None,
) -> bool:
    xbox_360_compatible = (
        vendor_id == _XBOX_360_VID and product_id == _XBOX_360_PID
    )
    controller_usage = (
        usage_page == _HID_USAGE_PAGE_GENERIC_DESKTOP
        and usage in {_HID_USAGE_JOYSTICK, _HID_USAGE_GAMEPAD}
    )
    return xbox_360_compatible or controller_usage


def _controller_usage_kind(
    usage_page: int | None, usage: int | None
) -> str | None:
    if usage_page != _HID_USAGE_PAGE_GENERIC_DESKTOP:
        return None
    if usage == _HID_USAGE_GAMEPAD:
        return "gamepad"
    if usage == _HID_USAGE_JOYSTICK:
        return "joystick"
    return None


def _candidate_collection_reasons(
    usage_page: int | None,
    output_report_byte_length: int | None,
    feature_report_byte_length: int | None,
) -> list[str]:
    reasons: list[str] = []
    if usage_page is not None and usage_page >= _HID_USAGE_PAGE_VENDOR_DEFINED:
        reasons.append("vendor_usage_0xff00_or_higher")
    if output_report_byte_length is not None and output_report_byte_length > 0:
        reasons.append("output_report_present")
    if feature_report_byte_length is not None and feature_report_byte_length > 0:
        reasons.append("feature_report_present")
    return reasons


def _open_hid_handle(kernel32: Any, device_path: str) -> int | None:
    handle = kernel32.CreateFileW(
        device_path,
        0,
        _FILE_SHARE_READ | _FILE_SHARE_WRITE,
        None,
        _OPEN_EXISTING,
        _FILE_ATTRIBUTE_NORMAL,
        None,
    )
    if handle in (None, 0, _INVALID_HANDLE_VALUE):
        return None
    return int(handle)


def _read_detail_device_path(
    detail: ctypes.POINTER(_SP_DEVICE_INTERFACE_DETAIL_DATA_W),
) -> str:
    """Read the variable-length WCHAR path instead of the declared one-item field."""

    address = ctypes.addressof(detail.contents)
    path_offset = _SP_DEVICE_INTERFACE_DETAIL_DATA_W.DevicePath.offset
    return ctypes.wstring_at(address + path_offset)


def _get_instance_id(
    setupapi: Any,
    device_info_set: int,
    devinfo: _SP_DEVINFO_DATA,
) -> tuple[str | None, int | None]:
    capacity = 1024
    buffer = ctypes.create_unicode_buffer(capacity)
    required = wintypes.DWORD()
    success = setupapi.SetupDiGetDeviceInstanceIdW(
        device_info_set,
        ctypes.byref(devinfo),
        buffer,
        capacity,
        ctypes.byref(required),
    )
    if not success:
        return None, ctypes.get_last_error()
    value = buffer.value.strip()
    return (value or None), None


def _get_device_string_property(
    setupapi: Any,
    device_info_set: int,
    devinfo: _SP_DEVINFO_DATA,
    property_id: int,
) -> tuple[str | None, int | None]:
    capacity = 2048
    buffer = (wintypes.BYTE * capacity)()
    required = wintypes.DWORD()
    success = setupapi.SetupDiGetDeviceRegistryPropertyW(
        device_info_set,
        ctypes.byref(devinfo),
        property_id,
        None,
        buffer,
        capacity,
        ctypes.byref(required),
    )
    if not success:
        return None, ctypes.get_last_error()
    byte_count = min(int(required.value or capacity), capacity)
    raw = bytes(buffer[:byte_count])
    try:
        value = raw.decode("utf-16-le").rstrip("\x00").strip()
    except UnicodeDecodeError:
        value = ""
    return (value or None), None


def _public_hid_record(
    record: Mapping[str, Any], gamepad_instance_ids: Sequence[str]
) -> dict[str, Any]:
    is_gamepad = bool(record.get("_gamepad_interface"))
    candidate_for = [] if is_gamepad else sorted(set(gamepad_instance_ids))
    public = {
        key: value
        for key, value in record.items()
        if not str(key).startswith("_")
    }
    public.update(
        {
            "controller_usage": record.get("_controller_usage"),
            "xbox_360_compatible_vid_pid": bool(
                record.get("_vid_pid_pair") == (_XBOX_360_VID, _XBOX_360_PID)
            ),
            "gamepad_usage": is_gamepad,
            "same_vid_pid_candidate": not is_gamepad,
            "confirmed_same_device": False,
            "candidate_reasons": (
                [] if is_gamepad else list(record.get("_candidate_reasons", []))
            ),
            "candidate_for_gamepad_instance_ids": candidate_for,
            "association_evidence": (
                None if is_gamepad else "same_vid_pid_only"
            ),
            "identity_assessment": "not_sufficient",
        }
    )
    return public


def _select_gamepad_related_hid_records(
    records: Sequence[dict[str, Any]],
) -> tuple[list[dict[str, Any]], set[int]]:
    groups: dict[tuple[int, int], list[dict[str, Any]]] = {}
    ungrouped_gamepads: list[dict[str, Any]] = []
    for record in records:
        pair = record.get("_vid_pid_pair")
        if isinstance(pair, tuple) and len(pair) == 2:
            groups.setdefault(pair, []).append(record)
        elif record.get("_gamepad_interface"):
            ungrouped_gamepads.append(record)

    selected: list[dict[str, Any]] = []
    selected_record_ids: set[int] = set()
    for grouped_records in groups.values():
        gamepads = [
            record for record in grouped_records if record.get("_gamepad_interface")
        ]
        if not gamepads:
            continue
        gamepad_ids = sorted(
            {
                str(record.get("instance_id") or record.get("device_path") or "")
                for record in gamepads
                if record.get("instance_id") or record.get("device_path")
            }
        )
        for record in grouped_records:
            if record.get("_gamepad_interface") or record.get("_candidate_reasons"):
                selected.append(_public_hid_record(record, gamepad_ids))
                selected_record_ids.add(id(record))

    for record in ungrouped_gamepads:
        selected.append(_public_hid_record(record, []))
        selected_record_ids.add(id(record))

    selected.sort(
        key=lambda item: (
            bool(item.get("same_vid_pid_candidate")),
            str(item.get("instance_id") or item.get("device_path") or ""),
        )
    )
    return selected, selected_record_ids


def _gamepad_vid_pid_pairs(
    hid_devices: Sequence[Mapping[str, Any]],
) -> list[str]:
    pairs: set[str] = set()
    for record in hid_devices:
        if record.get("same_vid_pid_candidate"):
            continue
        vendor = str(record.get("vendor_id") or "").lower().removeprefix("0x")
        product = str(record.get("product_id") or "").lower().removeprefix("0x")
        if re.fullmatch(r"[0-9a-f]{4}", vendor) and re.fullmatch(
            r"[0-9a-f]{4}", product
        ):
            pairs.add(f"{vendor}:{product}")
    return sorted(pairs)


def _collect_hid_devices() -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Read all HID caps, then retain gamepads and verified-group candidates."""

    setupapi, hid, kernel32 = _load_windows_apis()
    errors: list[dict[str, Any]] = []
    raw_interfaces: list[dict[str, Any]] = []
    open_failures = 0

    interface_guid = _GUID.from_string(_GUID_DEVINTERFACE_HID)
    device_info_set = setupapi.SetupDiGetClassDevsW(
        ctypes.byref(interface_guid),
        None,
        None,
        _DIGCF_PRESENT | _DIGCF_DEVICEINTERFACE,
    )
    if device_info_set in (None, 0, _INVALID_HANDLE_VALUE):
        code = ctypes.get_last_error()
        errors.append(
            _error_record(
                "hid.setupapi",
                _winerror_message(code),
                error_type="SetupDiGetClassDevsW",
                winerror=code,
            )
        )
        return [], errors

    try:
        index = 0
        while True:
            interface = _SP_DEVICE_INTERFACE_DATA()
            interface.cbSize = ctypes.sizeof(_SP_DEVICE_INTERFACE_DATA)
            ctypes.set_last_error(0)
            success = setupapi.SetupDiEnumDeviceInterfaces(
                device_info_set,
                None,
                ctypes.byref(interface_guid),
                index,
                ctypes.byref(interface),
            )
            if not success:
                code = ctypes.get_last_error()
                if code == _ERROR_NO_MORE_ITEMS:
                    break
                errors.append(
                    _error_record(
                        "hid.setupapi",
                        _winerror_message(code),
                        error_type="SetupDiEnumDeviceInterfaces",
                        winerror=code,
                    )
                )
                break
            index += 1

            devinfo = _SP_DEVINFO_DATA()
            devinfo.cbSize = ctypes.sizeof(_SP_DEVINFO_DATA)
            required_size = wintypes.DWORD()
            ctypes.set_last_error(0)
            setupapi.SetupDiGetDeviceInterfaceDetailW(
                device_info_set,
                ctypes.byref(interface),
                None,
                0,
                ctypes.byref(required_size),
                ctypes.byref(devinfo),
            )
            size_error = ctypes.get_last_error()
            if not required_size.value:
                errors.append(
                    _error_record(
                        "hid.setupapi",
                        _winerror_message(size_error),
                        error_type="SetupDiGetDeviceInterfaceDetailW.size",
                        winerror=size_error,
                    )
                )
                continue

            header_size = 8 if ctypes.sizeof(ctypes.c_void_p) == 8 else 6
            buffer_size = max(
                int(required_size.value), header_size + ctypes.sizeof(wintypes.WCHAR)
            )
            raw_detail = ctypes.create_string_buffer(buffer_size)
            detail = ctypes.cast(
                raw_detail, ctypes.POINTER(_SP_DEVICE_INTERFACE_DETAIL_DATA_W)
            )
            detail.contents.cbSize = header_size
            ctypes.set_last_error(0)
            detail_ok = setupapi.SetupDiGetDeviceInterfaceDetailW(
                device_info_set,
                ctypes.byref(interface),
                detail,
                buffer_size,
                ctypes.byref(required_size),
                ctypes.byref(devinfo),
            )
            if not detail_ok:
                code = ctypes.get_last_error()
                errors.append(
                    _error_record(
                        "hid.setupapi",
                        _winerror_message(code),
                        error_type="SetupDiGetDeviceInterfaceDetailW",
                        winerror=code,
                    )
                )
                continue

            device_path = _read_detail_device_path(detail)
            path_vid, path_pid = _parse_vid_pid(device_path)
            handle: int | None = None
            preparsed_data = ctypes.POINTER(_HIDP_PREPARSED_DATA)()
            deferred_errors: list[dict[str, Any]] = []
            try:
                handle = _open_hid_handle(kernel32, device_path)
                if handle is None:
                    open_failures += 1
                    continue

                attributes = _HIDD_ATTRIBUTES()
                attributes.Size = ctypes.sizeof(_HIDD_ATTRIBUTES)
                ctypes.set_last_error(0)
                attributes_ok = bool(
                    hid.HidD_GetAttributes(handle, ctypes.byref(attributes))
                )
                attributes_error = ctypes.get_last_error()

                caps = _HIDP_CAPS()
                preparsed_ok = bool(
                    hid.HidD_GetPreparsedData(handle, ctypes.byref(preparsed_data))
                )
                preparsed_error = ctypes.get_last_error()
                caps_ok = False
                caps_status: int | None = None
                if preparsed_ok:
                    caps_status = int(
                        hid.HidP_GetCaps(preparsed_data, ctypes.byref(caps))
                    )
                    caps_ok = caps_status == _HIDP_STATUS_SUCCESS

                vendor_id = attributes.VendorID if attributes_ok else path_vid
                product_id = attributes.ProductID if attributes_ok else path_pid
                usage_page = int(caps.UsagePage) if caps_ok else None
                usage = int(caps.Usage) if caps_ok else None
                input_length = (
                    int(caps.InputReportByteLength) if caps_ok else None
                )
                output_length = (
                    int(caps.OutputReportByteLength) if caps_ok else None
                )
                feature_length = (
                    int(caps.FeatureReportByteLength) if caps_ok else None
                )
                controller_usage = _controller_usage_kind(usage_page, usage)
                gamepad_interface = _is_supported_gamepad(
                    vendor_id, product_id, usage_page, usage
                )
                candidate_reasons = []
                if not gamepad_interface:
                    candidate_reasons = _candidate_collection_reasons(
                        usage_page, output_length, feature_length
                    )

                if not attributes_ok:
                    deferred_errors.append(
                        _error_record(
                            "hid.attributes",
                            _winerror_message(attributes_error),
                            error_type="HidD_GetAttributes",
                            winerror=attributes_error,
                            device_path=device_path,
                        )
                    )
                if not preparsed_ok:
                    deferred_errors.append(
                        _error_record(
                            "hid.descriptor",
                            _winerror_message(preparsed_error),
                            error_type="HidD_GetPreparsedData",
                            winerror=preparsed_error,
                            device_path=device_path,
                        )
                    )
                elif not caps_ok:
                    deferred_errors.append(
                        _error_record(
                            "hid.descriptor",
                            f"HidP_GetCaps returned {caps_status}",
                            error_type="HidP_GetCaps",
                            device_path=device_path,
                        )
                    )

                instance_id: str | None = None
                device_description: str | None = None
                friendly_name: str | None = None
                if gamepad_interface or candidate_reasons:
                    instance_id, instance_error = _get_instance_id(
                        setupapi, device_info_set, devinfo
                    )
                    if instance_error is not None:
                        deferred_errors.append(
                            _error_record(
                                "hid.setupapi",
                                _winerror_message(instance_error),
                                error_type="SetupDiGetDeviceInstanceIdW",
                                winerror=instance_error,
                                device_path=device_path,
                            )
                        )

                    device_description, description_error = (
                        _get_device_string_property(
                            setupapi,
                            device_info_set,
                            devinfo,
                            _SPDRP_DEVICEDESC,
                        )
                    )
                    friendly_name, friendly_error = _get_device_string_property(
                        setupapi,
                        device_info_set,
                        devinfo,
                        _SPDRP_FRIENDLYNAME,
                    )
                    if device_description is None and friendly_name is None:
                        deferred_errors.append(
                            _error_record(
                                "hid.description",
                                _winerror_message(
                                    description_error or friendly_error or 0
                                ),
                                error_type="SetupDiGetDeviceRegistryPropertyW",
                                winerror=description_error or friendly_error,
                                device_path=device_path,
                            )
                        )

                raw_interfaces.append(
                    {
                        "device_path": device_path,
                        "instance_id": instance_id,
                        "description": device_description,
                        "friendly_name": friendly_name,
                        "vendor_id": (
                            f"0x{int(vendor_id):04x}"
                            if vendor_id is not None
                            else None
                        ),
                        "product_id": (
                            f"0x{int(product_id):04x}"
                            if product_id is not None
                            else None
                        ),
                        "version_number": (
                            f"0x{int(attributes.VersionNumber):04x}"
                            if attributes_ok
                            else None
                        ),
                        "usage_page": usage_page,
                        "usage": usage,
                        "input_report_byte_length": input_length,
                        "output_report_byte_length": output_length,
                        "feature_report_byte_length": feature_length,
                        "_controller_usage": controller_usage,
                        "_gamepad_interface": gamepad_interface,
                        "_candidate_reasons": candidate_reasons,
                        "_vid_pid_pair": (
                            (vendor_id, product_id)
                            if vendor_id is not None and product_id is not None
                            else None
                        ),
                        "_deferred_errors": deferred_errors,
                    }
                )
            except Exception as exc:
                error = _exception_error("hid.enumeration", exc)
                if (path_vid, path_pid) == (_XBOX_360_VID, _XBOX_360_PID):
                    error["device_path"] = device_path
                errors.append(error)
            finally:
                if preparsed_data:
                    try:
                        if not hid.HidD_FreePreparsedData(preparsed_data):
                            code = ctypes.get_last_error()
                            errors.append(
                                _error_record(
                                    "hid.release",
                                    _winerror_message(code),
                                    error_type="HidD_FreePreparsedData",
                                    winerror=code,
                                )
                            )
                    except Exception as exc:
                        errors.append(_exception_error("hid.release", exc))
                    finally:
                        preparsed_data = ctypes.POINTER(_HIDP_PREPARSED_DATA)()
                if handle is not None:
                    try:
                        if not kernel32.CloseHandle(handle):
                            code = ctypes.get_last_error()
                            errors.append(
                                _error_record(
                                    "hid.release",
                                    _winerror_message(code),
                                    error_type="CloseHandle",
                                    winerror=code,
                                )
                            )
                    except Exception as exc:
                        errors.append(_exception_error("hid.release", exc))
    finally:
        try:
            destroyed = setupapi.SetupDiDestroyDeviceInfoList(device_info_set)
            if not destroyed:
                code = ctypes.get_last_error()
                errors.append(
                    _error_record(
                        "hid.setupapi",
                        _winerror_message(code),
                        error_type="SetupDiDestroyDeviceInfoList",
                        winerror=code,
                    )
                )
        except Exception as exc:
            errors.append(_exception_error("hid.setupapi", exc))

    devices, selected_record_ids = _select_gamepad_related_hid_records(
        raw_interfaces
    )
    seen_errors: set[tuple[Any, ...]] = set()
    for record in raw_interfaces:
        is_selected = id(record) in selected_record_ids
        for deferred_error in record.get("_deferred_errors", []):
            error = dict(deferred_error)
            if not is_selected:
                error.pop("device_path", None)
            key = (
                error.get("source"),
                error.get("error_type"),
                error.get("message"),
                error.get("winerror"),
                error.get("device_path"),
            )
            if key not in seen_errors:
                errors.append(error)
                seen_errors.add(key)

    if open_failures:
        errors.append(
            _error_record(
                "hid.open",
                f"{open_failures} HID interface(s) could not be opened with zero access; they were skipped.",
                error_type="CreateFileW",
            )
        )

    return devices, errors


def _decode_powershell_bytes(raw: bytes) -> str:
    if raw.startswith(b"\xff\xfe"):
        return raw.decode("utf-16")
    if raw.startswith(b"\xfe\xff"):
        return raw.decode("utf-16")
    if raw.startswith(b"\xef\xbb\xbf"):
        return raw.decode("utf-8-sig")
    if len(raw) >= 2 and raw[0:1] == b"{" and raw[1:2] == b"\x00":
        return raw.decode("utf-16-le")
    if len(raw) >= 2 and raw[0:1] == b"\x00" and raw[1:2] == b"{":
        return raw.decode("utf-16-be")

    encodings = ["utf-8-sig"]
    preferred = locale.getpreferredencoding(False)
    if preferred and preferred.lower().replace("-", "") not in {"utf8"}:
        encodings.append(preferred)
    encodings.append("mbcs")
    last_error: UnicodeDecodeError | None = None
    for encoding in encodings:
        try:
            return raw.decode(encoding)
        except (LookupError, UnicodeDecodeError) as exc:
            if isinstance(exc, UnicodeDecodeError):
                last_error = exc
    if last_error is not None:
        raise last_error
    return raw.decode("utf-8", errors="replace")


def _parse_pnp_output(raw: bytes | str) -> tuple[list[dict[str, Any]], list[str]]:
    if isinstance(raw, bytes):
        text = _decode_powershell_bytes(raw)
    else:
        text = raw
    text = text.lstrip("\ufeff").strip()
    if not text:
        return [], []
    payload = json.loads(text)
    if isinstance(payload, list):
        devices = payload
        warnings: list[Any] = []
    elif isinstance(payload, Mapping):
        devices = payload.get("devices", [])
        warnings = payload.get("warnings", [])
    else:
        raise ValueError("PowerShell PnP payload must be a JSON object or array")
    if devices is None:
        devices = []
    if warnings is None:
        warnings = []
    if not isinstance(devices, list):
        devices = [devices]
    if not isinstance(warnings, list):
        warnings = [warnings]
    clean_devices = [dict(item) for item in devices if isinstance(item, Mapping)]
    clean_warnings = [_clean_text(item, limit=500) for item in warnings if item]
    return clean_devices, clean_warnings


def _target_vid_pid_literal(vid_pid_pairs: Iterable[str] | None) -> str:
    normalized = sorted(
        {
            str(pair).lower()
            for pair in (vid_pid_pairs or [])
            if re.fullmatch(r"[0-9a-fA-F]{4}:[0-9a-fA-F]{4}", str(pair))
        }
    )
    if not normalized:
        return "@()"
    return "@(" + ",".join(f"'{pair}'" for pair in normalized) + ")"


def _run_powershell_json(
    timeout: int = _PNP_TIMEOUT_SECONDS,
    *,
    vid_pid_pairs: Iterable[str] | None = None,
) -> bytes:
    executable = shutil.which("powershell.exe") or shutil.which("pwsh.exe")
    if not executable:
        raise FileNotFoundError("Neither powershell.exe nor pwsh.exe is available")
    script = _POWERSHELL_PNP_SCRIPT.replace(
        "__TARGET_VID_PIDS__", _target_vid_pid_literal(vid_pid_pairs)
    )
    encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    command = [
        executable,
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        encoded,
    ]
    completed = subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=timeout,
        creationflags=_CREATE_NO_WINDOW if _is_windows() else 0,
    )
    if completed.returncode != 0:
        stderr = _decode_powershell_bytes(completed.stderr or b"").strip()
        detail = _clean_text(stderr, limit=500) or f"exit code {completed.returncode}"
        raise RuntimeError(f"Get-PnpDevice failed: {detail}")
    return completed.stdout


def _first_value(item: Mapping[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in item and item[key] not in (None, ""):
            return item[key]
    return None


def _optional_text(item: Mapping[str, Any], *keys: str) -> str | None:
    value = _first_value(item, *keys)
    if value is None:
        return None
    text = _clean_text(value, limit=1000)
    return text or None


def _optional_bool(item: Mapping[str, Any], *keys: str) -> bool | None:
    value = _first_value(item, *keys)
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in {"true", "1", "yes"}:
        return True
    if text in {"false", "0", "no"}:
        return False
    return None


def _normalize_pnp_device(item: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "status": _optional_text(item, "Status", "status"),
        "is_present": _optional_bool(item, "IsPresent", "Present", "is_present"),
        "device_class": _optional_text(item, "Class", "PNPClass", "device_class"),
        "friendly_name": _optional_text(item, "FriendlyName", "friendly_name"),
        "instance_id": _optional_text(item, "InstanceId", "instance_id"),
        "parent": _optional_text(item, "Parent", "parent"),
        "container_id": _optional_text(item, "ContainerId", "container_id"),
        "service": _optional_text(item, "Service", "service"),
        "driver": _optional_text(item, "Driver", "driver"),
        "bus_reported_device_desc": _optional_text(
            item,
            "BusReportedDeviceDesc",
            "bus_reported_device_desc",
        ),
        "problem": _optional_text(item, "Problem", "problem"),
        "problem_description": _optional_text(
            item, "ProblemDescription", "problem_description"
        ),
        "kind_hint": _optional_text(item, "KindHint", "kind_hint"),
    }


def _is_intel_bluetooth_hardware_candidate(device: Mapping[str, Any]) -> bool:
    instance_id = str(device.get("instance_id") or "")
    return bool(
        re.match(
            rf"(?i)^USB\\VID_{_INTEL_BLUETOOTH_CANDIDATE_VID:04X}"
            rf"&PID_{_INTEL_BLUETOOTH_CANDIDATE_PID:04X}(?:\\|$)",
            instance_id,
        )
    )


def _is_intel_ax200_radio_context(device: Mapping[str, Any]) -> bool:
    instance_id = str(device.get("instance_id") or "")
    return bool(
        re.match(
            rf"(?i)^PCI\\VEN_{_INTEL_AX200_WIFI_VENDOR_ID:04X}"
            rf"&DEV_{_INTEL_AX200_WIFI_DEVICE_ID:04X}(?:\\|&|$)",
            instance_id,
        )
    )


def _annotate_bluetooth_candidate(device: dict[str, Any]) -> dict[str, Any]:
    device = _annotate_pnp_record(device)
    device.update(
        {
            "hardware_id": "8087:0029",
            "adapter_usability": "not_usable_adapter",
            "usable_as_bluetooth_adapter": False,
            "classification": "intel_usb_bluetooth_hardware_candidate",
            "candidate_reason": (
                "present Intel USB 8087:0029 without a bound Bluetooth class/service"
            ),
        }
    )
    return device


def _is_bluetooth_adapter(device: Mapping[str, Any]) -> bool:
    device_class = str(device.get("device_class") or "").lower()
    service = str(device.get("service") or "").lower()
    instance_id = str(device.get("instance_id") or "")
    friendly = str(device.get("friendly_name") or "")
    kind_hint = str(device.get("kind_hint") or "").lower()
    if kind_hint == "bluetooth_adapter" and device_class in {
        "bluetooth",
        "bluetoothradio",
    }:
        return True
    if device_class not in {"bluetooth", "bluetoothradio"}:
        return False
    if service in {"bthusb", "ibtusb", "bthenum", "bthleenum"}:
        return True
    if re.match(r"(?i)^BTH\\MS_BTHBRB\\", instance_id):
        return True
    return bool(
        re.match(r"(?i)^USB\\", instance_id)
        and re.search(r"(?i)bluetooth|蓝牙", friendly)
    )


def _is_gamepad_pnp_device(device: Mapping[str, Any]) -> bool:
    instance_id = str(device.get("instance_id") or "")
    device_class = str(device.get("device_class") or "").lower()
    friendly = str(device.get("friendly_name") or "")
    bus_desc = str(device.get("bus_reported_device_desc") or "")
    service = str(device.get("service") or "").lower()
    if re.search(r"(?i)VID_045E&PID_028E", instance_id):
        return True
    if device_class in {"xnaComposite".lower(), "xboxcomposite", "xboxgamepad"}:
        return True
    if device_class == "hidclass":
        return bool(
            re.search(
                r"(?i)xbox|gamepad|game\s*controller|joystick|手柄|游戏控制器",
                f"{friendly} {bus_desc}",
            )
            or service in {"xusb22", "xinputhid"}
        )
    return False


_VIRTUAL_MARKERS = re.compile(
    r"(?i)(?:^|[\\#])(?:root|swd)\\|vigem|nefarius|vi\s*gem|"
    r"virtual\s+(?:gamepad|controller|device)|虚拟(?:手柄|控制器|设备)|emulat(?:ed|or)"
)


def _has_virtual_evidence(*values: Any) -> bool:
    haystack = " ".join(
        str(value) for value in values if value not in (None, "")
    )
    return bool(_VIRTUAL_MARKERS.search(haystack))


def _transport_family(*values: Any) -> str | None:
    haystack = " ".join(str(value).lower() for value in values if value)
    if re.search(r"(?:^|[\s\\#])usb\\", haystack):
        return "usb"
    if re.search(r"(?:^|[\s\\#])(?:bthenum|bth)\\", haystack):
        return "bluetooth"
    return None


def _normalize_device_path(value: str) -> str:
    normalized = value.lower().replace("#", "\\")
    if normalized.startswith("\\\\?\\"):
        normalized = normalized[4:]
    guid_index = normalized.find("\\{")
    if guid_index >= 0:
        normalized = normalized[:guid_index]
    return normalized.strip("\\")


def _hid_directly_relates_to_pnp(
    hid_record: Mapping[str, Any], pnp_record: Mapping[str, Any]
) -> bool:
    hid_path = _normalize_device_path(str(hid_record.get("device_path") or ""))
    hid_instance = _normalize_device_path(str(hid_record.get("instance_id") or ""))
    pnp_instance = _normalize_device_path(str(pnp_record.get("instance_id") or ""))
    return bool(
        pnp_instance
        and (
        pnp_instance == hid_instance
        or pnp_instance in hid_path
        or hid_instance in pnp_instance
        )
    )


def _hid_relates_to_pnp(hid_record: Mapping[str, Any], pnp_record: Mapping[str, Any]) -> bool:
    if _hid_directly_relates_to_pnp(hid_record, pnp_record):
        return True
    hid_vendor, hid_product = _parse_vid_pid(
        str(hid_record.get("device_path") or hid_record.get("instance_id") or "")
    )
    pnp_vendor, pnp_product = _parse_vid_pid(
        str(pnp_record.get("instance_id") or "")
    )
    return (
        hid_vendor is not None
        and hid_product is not None
        and (hid_vendor, hid_product) == (pnp_vendor, pnp_product)
    )


def _meaningful_container_id(value: Any) -> str | None:
    text = str(value or "").strip().lower()
    if not text or text in {
        "{00000000-0000-0000-0000-000000000000}",
        "{00000000-0000-0000-ffff-ffffffffffff}",
    }:
        return None
    return text


def _hid_instance_device_root(value: Any) -> str | None:
    normalized = _normalize_device_path(str(value or ""))
    parts = normalized.split("\\")
    if len(parts) < 2 or not parts[0] or not parts[1]:
        return None
    hardware_id = re.sub(r"&col[0-9a-f]{2}$", "", parts[1], flags=re.IGNORECASE)
    return f"{parts[0]}\\{hardware_id}"


def _candidate_gamepad_association(
    candidate: Mapping[str, Any],
    gamepads: Sequence[Mapping[str, Any]],
    pnp_devices: Sequence[Mapping[str, Any]],
) -> tuple[str, list[str]]:
    candidate_direct_pnp = [
        record
        for record in pnp_devices
        if _hid_directly_relates_to_pnp(candidate, record)
    ]
    candidate_containers = {
        container
        for container in (
            _meaningful_container_id(record.get("container_id"))
            for record in candidate_direct_pnp
        )
        if container
    }
    candidate_parents = {
        str(record.get("parent") or "").lower()
        for record in candidate_direct_pnp
        if record.get("parent")
    }
    candidate_root = _hid_instance_device_root(
        candidate.get("instance_id") or candidate.get("device_path")
    )

    matches: dict[str, list[str]] = {
        "container_id_match": [],
        "device_root_match": [],
        "instance_device_root_match": [],
    }
    for gamepad in gamepads:
        gamepad_id = str(
            gamepad.get("instance_id") or gamepad.get("device_path") or ""
        )
        gamepad_direct_pnp = [
            record
            for record in pnp_devices
            if _hid_directly_relates_to_pnp(gamepad, record)
        ]
        gamepad_containers = {
            container
            for container in (
                _meaningful_container_id(record.get("container_id"))
                for record in gamepad_direct_pnp
            )
            if container
        }
        if candidate_containers & gamepad_containers:
            matches["container_id_match"].append(gamepad_id)
            continue
        gamepad_parents = {
            str(record.get("parent") or "").lower()
            for record in gamepad_direct_pnp
            if record.get("parent")
        }
        if candidate_parents & gamepad_parents:
            matches["device_root_match"].append(gamepad_id)
            continue
        gamepad_root = _hid_instance_device_root(
            gamepad.get("instance_id") or gamepad.get("device_path")
        )
        if candidate_root and gamepad_root == candidate_root:
            matches["instance_device_root_match"].append(gamepad_id)

    for evidence in (
        "container_id_match",
        "device_root_match",
        "instance_device_root_match",
    ):
        if matches[evidence]:
            return evidence, sorted(set(matches[evidence]))
    return "same_vid_pid_only", sorted(
        {
            str(gamepad.get("instance_id") or gamepad.get("device_path") or "")
            for gamepad in gamepads
            if gamepad.get("instance_id") or gamepad.get("device_path")
        }
    )


def _annotate_hid_records(
    hid_devices: list[dict[str, Any]], pnp_devices: Sequence[Mapping[str, Any]]
) -> None:
    for hid_record in hid_devices:
        related = [
            pnp_record
            for pnp_record in pnp_devices
            if _hid_relates_to_pnp(hid_record, pnp_record)
        ]
        related_fields: list[Any] = []
        for pnp_record in related:
            related_fields.extend(
                pnp_record.get(key)
                for key in (
                    "instance_id",
                    "parent",
                    "container_id",
                    "service",
                    "bus_reported_device_desc",
                    "friendly_name",
                )
            )

        virtual_evidence = _has_virtual_evidence(
            hid_record.get("device_path"),
            hid_record.get("instance_id"),
            hid_record.get("description"),
            hid_record.get("friendly_name"),
            *related_fields,
        )
        transport = _transport_family(
            hid_record.get("instance_id"),
            hid_record.get("device_path"),
            *related_fields,
        )
        if virtual_evidence:
            physicality = "virtual"
        elif transport:
            physicality = "physical_bus_topology_observed"
        else:
            physicality = "unconfirmed"
        hid_record["pnp_related_instance_ids"] = sorted(
            {
                str(record.get("instance_id"))
                for record in related
                if record.get("instance_id")
            }
        )
        hid_record["transport_family"] = transport
        hid_record["virtual_evidence"] = virtual_evidence
        hid_record["physicality"] = physicality

    gamepads = [
        record for record in hid_devices if not record.get("same_vid_pid_candidate")
    ]
    for candidate in hid_devices:
        if not candidate.get("same_vid_pid_candidate"):
            continue
        candidate_pair = (
            str(candidate.get("vendor_id") or "").lower(),
            str(candidate.get("product_id") or "").lower(),
        )
        same_pair_gamepads = [
            gamepad
            for gamepad in gamepads
            if (
                str(gamepad.get("vendor_id") or "").lower(),
                str(gamepad.get("product_id") or "").lower(),
            )
            == candidate_pair
        ]
        evidence, associated_ids = _candidate_gamepad_association(
            candidate, same_pair_gamepads, pnp_devices
        )
        candidate["association_evidence"] = evidence
        candidate["candidate_for_gamepad_instance_ids"] = associated_ids
        candidate["confirmed_same_device"] = False


def _annotate_pnp_record(device: dict[str, Any]) -> dict[str, Any]:
    virtual_evidence = _has_virtual_evidence(
        device.get("instance_id"),
        device.get("parent"),
        device.get("container_id"),
        device.get("service"),
        device.get("bus_reported_device_desc"),
        device.get("friendly_name"),
    )
    transport = _transport_family(
        device.get("instance_id"),
        device.get("parent"),
        device.get("bus_reported_device_desc"),
    )
    if virtual_evidence:
        physicality = "virtual"
    elif transport:
        physicality = "physical_bus_topology_observed"
    else:
        physicality = "unconfirmed"
    device["transport_family"] = transport
    device["virtual_evidence"] = virtual_evidence
    device["physicality"] = physicality
    return device


def _pnp_matches_vid_pid_group(
    device: Mapping[str, Any], vid_pid_pairs: Iterable[str]
) -> bool:
    vendor, product = _parse_vid_pid(str(device.get("instance_id") or ""))
    if vendor is None or product is None:
        return False
    return f"{vendor:04x}:{product:04x}" in {
        str(pair).lower() for pair in vid_pid_pairs
    }


def _collect_pnp_devices(
    vid_pid_pairs: Iterable[str] | None = None,
) -> tuple[
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
]:
    errors: list[dict[str, Any]] = []
    target_pairs = sorted(
        {
            str(pair).lower()
            for pair in (vid_pid_pairs or [])
            if re.fullmatch(r"[0-9a-fA-F]{4}:[0-9a-fA-F]{4}", str(pair))
        }
    )
    try:
        raw = _run_powershell_json(vid_pid_pairs=target_pairs)
        raw_devices, warnings = _parse_pnp_output(raw)
    except subprocess.TimeoutExpired:
        return (
            [],
            [],
            [],
            [],
            [
                _error_record(
                    "pnp.powershell",
                    f"Get-PnpDevice timed out after {_PNP_TIMEOUT_SECONDS} seconds",
                    error_type="TimeoutExpired",
                )
            ],
        )
    except Exception as exc:
        return [], [], [], [], [_exception_error("pnp.powershell", exc)]

    for warning in warnings:
        errors.append(
            _error_record(
                "pnp.properties",
                warning,
                error_type="Get-PnpDeviceProperty",
            )
        )

    pnp_devices: list[dict[str, Any]] = []
    bluetooth_devices: list[dict[str, Any]] = []
    bluetooth_candidates: list[dict[str, Any]] = []
    radio_context: list[dict[str, Any]] = []
    for raw_device in raw_devices:
        normalized = _normalize_pnp_device(raw_device)
        if _is_bluetooth_adapter(normalized):
            adapter = _annotate_pnp_record(normalized)
            adapter["adapter_usability"] = "usable_adapter"
            adapter["usable_as_bluetooth_adapter"] = True
            bluetooth_devices.append(adapter)
        elif _is_intel_bluetooth_hardware_candidate(normalized):
            bluetooth_candidates.append(_annotate_bluetooth_candidate(normalized))
        elif _is_intel_ax200_radio_context(normalized):
            radio = _annotate_pnp_record(normalized)
            radio["context_role"] = "intel_ax200_wifi_radio"
            radio_context.append(radio)
        elif _is_gamepad_pnp_device(normalized) or _pnp_matches_vid_pid_group(
            normalized, target_pairs
        ):
            pnp_devices.append(_annotate_pnp_record(normalized))

    pnp_devices.sort(key=lambda item: str(item.get("instance_id") or ""))
    bluetooth_devices.sort(key=lambda item: str(item.get("instance_id") or ""))
    bluetooth_candidates.sort(key=lambda item: str(item.get("instance_id") or ""))
    radio_context.sort(key=lambda item: str(item.get("instance_id") or ""))
    return (
        pnp_devices,
        bluetooth_devices,
        bluetooth_candidates,
        radio_context,
        errors,
    )


def _build_conclusions(
    hid_devices: Sequence[Mapping[str, Any]],
    bluetooth_devices: Sequence[Mapping[str, Any]],
    errors: Sequence[Mapping[str, Any]],
    bluetooth_candidates: Sequence[Mapping[str, Any]] = (),
    radio_context: Sequence[Mapping[str, Any]] = (),
) -> list[str]:
    conclusions: list[str] = []
    hid_error = any(str(item.get("source", "")).startswith("hid.") for item in errors)
    pnp_error = any(str(item.get("source", "")).startswith("pnp.") for item in errors)

    if hid_devices:
        gamepads = [
            item for item in hid_devices if not item.get("same_vid_pid_candidate")
        ]
        candidates = [
            item for item in hid_devices if item.get("same_vid_pid_candidate")
        ]
        conclusions.append(
            f"检测到 {len(gamepads)} 个 gamepad/joystick HID 接口；"
            f"同 VID/PID 的额外 collection 候选数量为 {len(candidates)}。"
        )
        if any(item.get("controller_usage") for item in gamepads):
            conclusions.append(
                "HID 报告描述显示 Generic Desktop 控制器 usage（Usage Page 0x0001，"
                "Usage 0x0005 Gamepad 或 0x0004 Joystick）。"
            )
        if candidates:
            reasons = sorted(
                {
                    reason
                    for item in candidates
                    for reason in item.get("candidate_reasons", [])
                }
            )
            evidence = sorted(
                {
                    str(item.get("association_evidence"))
                    for item in candidates
                    if item.get("association_evidence")
                }
            )
            conclusions.append(
                f"保留 {len(candidates)} 个同 VID/PID 额外 collection 候选"
                f"（依据：{', '.join(reasons)}；关联依据：{', '.join(evidence)}）。"
                "这些记录均标记为 same_vid_pid_candidate，尚未证明属于同一已确认设备。"
            )
        else:
            conclusions.append(
                "同 VID/PID 下未保留额外 vendor usage 或 output/feature report collection。"
            )
        report_shapes = {
            (
                item.get("input_report_byte_length"),
                item.get("output_report_byte_length"),
                item.get("feature_report_byte_length"),
            )
            for item in hid_devices
        }
        shape_text = "、".join(
            f"input={inp}, output={out}, feature={feature}"
            for inp, out, feature in sorted(
                report_shapes, key=lambda value: tuple(-1 if x is None else x for x in value)
            )
        )
        conclusions.append(f"已读取报告长度：{shape_text} 字节；本次未读取输入流或报告内容。")
        if any(item.get("xbox_360_compatible_vid_pid") for item in hid_devices):
            conclusions.append(
                "检测到 045E:028E。该标识被大量 Xbox 360 兼容设备共享，只能说明兼容关系，不能证明设备是 O+。"
            )
        if any(item.get("physicality") == "virtual" for item in hid_devices):
            conclusions.append(
                "部分匹配项带有 ViGEm、ROOT/SWD 或其他软件设备证据，已标记为虚拟设备，不作为物理控制器。"
            )
        elif any(
            item.get("physicality") == "physical_bus_topology_observed"
            for item in hid_devices
        ):
            conclusions.append(
                "PnP 拓扑中可观察到 USB/蓝牙总线父级，但未据此区分 USB 线缆、接收器或其他连接形态。"
            )
        else:
            conclusions.append(
                "当前缺少足够的父设备或容器关联，无法确认匹配 HID 接口对应的物理控制器。"
            )
    elif hid_error:
        conclusions.append("HID 枚举或描述读取发生错误，当前不能确定是否连接了目标 gamepad。")
    else:
        conclusions.append(
            "未发现 Usage Page 0x0001 的 Gamepad/Joystick，也未发现 045E:028E HID 接口；"
            "同 VID/PID 的额外 collection 候选数量为 0。"
        )

    if bluetooth_devices:
        conclusions.append(
            f"PnP 中存在 {len(bluetooth_devices)} 个 present 的 Bluetooth 适配器相关组件。"
        )
        if bluetooth_candidates:
            conclusions.append(
                f"另有 {len(bluetooth_candidates)} 个 Intel 8087:0029 USB 蓝牙硬件候选"
                "未标记为可用适配器。"
            )
    elif bluetooth_candidates:
        conclusions.append(
            "发现 Intel 8087:0029 USB蓝牙硬件候选，但没有绑定蓝牙类别/服务，Windows BLE尚不可用。"
        )
    elif pnp_error:
        conclusions.append("Bluetooth 适配器枚举不完整，当前结果不能用于判断蓝牙硬件是否存在。")
    else:
        conclusions.append(
            "未发现 Windows 已绑定且可用的 present Bluetooth 适配器；"
            "该状态本身不能证明蓝牙硬件不存在。"
        )

    if radio_context:
        conclusions.append(
            f"检测到 {len(radio_context)} 个 Intel AX200 Wi-Fi radio context 记录，"
            "已与蓝牙可用性分开处理。"
        )

    conclusions.append(
        "本次仅执行设备、属性与报告描述枚举；未调用 GetFeature，未发送 SetFeature/输出报告，也未主动读取输入。"
    )
    return conclusions


def collect_report() -> dict[str, Any]:
    """Collect a JSON-friendly, read-only hardware diagnostic report."""

    report: dict[str, Any] = {
        "timestamp": _utc_timestamp(),
        "platform": _platform_details(),
        "pnp": [],
        "hid": [],
        "bluetooth": [],
        "bluetooth_candidates": [],
        "radio_context": [],
        "errors": [],
        "conclusions": [],
    }

    if not _is_windows():
        report["errors"].append(
            _error_record(
                "platform",
                "当前平台不是 Windows；只读 SetupAPI/HID 与 Get-PnpDevice 诊断不受支持。",
                error_type="unsupported_platform",
            )
        )
        report["conclusions"].append(
            "当前平台不是 Windows，无法执行本模块的只读硬件诊断；未访问任何硬件接口。"
        )
        return report

    hid_devices: list[dict[str, Any]] = []
    try:
        hid_devices, hid_errors = _collect_hid_devices()
        report["errors"].extend(hid_errors)
    except Exception as exc:
        report["errors"].append(_exception_error("hid.enumeration", exc))

    pnp_devices: list[dict[str, Any]] = []
    bluetooth_devices: list[dict[str, Any]] = []
    bluetooth_candidates: list[dict[str, Any]] = []
    radio_context: list[dict[str, Any]] = []
    try:
        (
            pnp_devices,
            bluetooth_devices,
            bluetooth_candidates,
            radio_context,
            pnp_errors,
        ) = _collect_pnp_devices(_gamepad_vid_pid_pairs(hid_devices))
        report["errors"].extend(pnp_errors)
    except Exception as exc:
        report["errors"].append(_exception_error("pnp.powershell", exc))

    try:
        _annotate_hid_records(hid_devices, pnp_devices)
    except Exception as exc:
        report["errors"].append(_exception_error("analysis.association", exc))
        for hid_device in hid_devices:
            hid_device.setdefault("physicality", "unconfirmed")
            hid_device.setdefault("virtual_evidence", False)
            hid_device.setdefault("transport_family", None)
            hid_device.setdefault("pnp_related_instance_ids", [])

    report["pnp"] = pnp_devices
    report["hid"] = hid_devices
    report["bluetooth"] = bluetooth_devices
    report["bluetooth_candidates"] = bluetooth_candidates
    report["radio_context"] = radio_context
    try:
        report["conclusions"] = _build_conclusions(
            hid_devices,
            bluetooth_devices,
            report["errors"],
            bluetooth_candidates,
            radio_context,
        )
    except Exception as exc:
        report["errors"].append(_exception_error("analysis.conclusions", exc))
        report["conclusions"] = ["诊断采样已完成，但生成可读结论时发生错误，请查看 errors。"]

    return report


__all__ = ["COLLECT_REPORT_KEYS", "collect_report"]
