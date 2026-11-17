from __future__ import annotations

import ctypes
import json
import os
import subprocess
import unittest
from ctypes import wintypes
from unittest import mock

from oplus import diagnostics


def _raw_hid_record(
    instance_id: str,
    vendor_id: int,
    product_id: int,
    usage_page: int,
    usage: int,
    *,
    input_length: int = 8,
    output_length: int = 0,
    feature_length: int = 0,
) -> dict[str, object]:
    gamepad = diagnostics._is_supported_gamepad(
        vendor_id, product_id, usage_page, usage
    )
    reasons = []
    if not gamepad:
        reasons = diagnostics._candidate_collection_reasons(
            usage_page, output_length, feature_length
        )
    return {
        "device_path": rf"\\?\hid#{instance_id.replace(chr(92), '#')}",
        "instance_id": instance_id,
        "description": "mock HID collection",
        "friendly_name": None,
        "vendor_id": f"0x{vendor_id:04x}",
        "product_id": f"0x{product_id:04x}",
        "version_number": "0x0001",
        "usage_page": usage_page,
        "usage": usage,
        "input_report_byte_length": input_length,
        "output_report_byte_length": output_length,
        "feature_report_byte_length": feature_length,
        "_controller_usage": diagnostics._controller_usage_kind(usage_page, usage),
        "_gamepad_interface": gamepad,
        "_candidate_reasons": reasons,
        "_vid_pid_pair": (vendor_id, product_id),
        "_deferred_errors": [],
    }


class ClassificationTests(unittest.TestCase):
    def test_xbox_identifier_and_gamepad_usage_are_supported(self) -> None:
        self.assertTrue(diagnostics._is_supported_gamepad(0x045E, 0x028E, None, None))
        self.assertTrue(diagnostics._is_supported_gamepad(None, None, 0x01, 0x05))
        self.assertTrue(diagnostics._is_supported_gamepad(None, None, 0x01, 0x04))
        self.assertFalse(diagnostics._is_supported_gamepad(0x045E, 0x028F, None, None))
        self.assertFalse(diagnostics._is_supported_gamepad(None, None, 0x01, 0x02))

    def test_same_vid_pid_vendor_collection_is_retained_as_candidate(self) -> None:
        records = [
            _raw_hid_record(
                r"HID\VID_1234&PID_ABCD&MI_00&COL01\1",
                0x1234,
                0xABCD,
                0x01,
                0x04,
            ),
            _raw_hid_record(
                r"HID\VID_1234&PID_ABCD&MI_00&COL02\2",
                0x1234,
                0xABCD,
                0xFF00,
                0x0001,
            ),
            _raw_hid_record(
                r"HID\VID_1234&PID_ABCD&MI_01&COL01\3",
                0x1234,
                0xABCD,
                0x0C,
                0x0001,
                feature_length=16,
            ),
            _raw_hid_record(
                r"HID\VID_9999&PID_0001&MI_00&COL01\4",
                0x9999,
                0x0001,
                0x01,
                0x02,
                feature_length=8,
            ),
        ]

        selected, _ = diagnostics._select_gamepad_related_hid_records(records)

        by_id = {item["instance_id"]: item for item in selected}
        self.assertIn(r"HID\VID_1234&PID_ABCD&MI_00&COL01\1", by_id)
        self.assertIn(r"HID\VID_1234&PID_ABCD&MI_00&COL02\2", by_id)
        self.assertIn(r"HID\VID_1234&PID_ABCD&MI_01&COL01\3", by_id)
        self.assertNotIn(r"HID\VID_9999&PID_0001&MI_00&COL01\4", by_id)
        vendor = by_id[r"HID\VID_1234&PID_ABCD&MI_00&COL02\2"]
        self.assertTrue(vendor["same_vid_pid_candidate"])
        self.assertFalse(vendor["confirmed_same_device"])
        self.assertIn("vendor_usage_0xff00_or_higher", vendor["candidate_reasons"])

    def test_unrelated_mouse_is_filtered_without_a_gamepad_group(self) -> None:
        records = [
            _raw_hid_record(
                r"HID\VID_1111&PID_2222&MI_00&COL01\1",
                0x1111,
                0x2222,
                0x01,
                0x02,
                output_length=4,
                feature_length=8,
            )
        ]

        selected, _ = diagnostics._select_gamepad_related_hid_records(records)

        self.assertEqual(selected, [])

    def test_device_path_parser_is_case_insensitive(self) -> None:
        vendor, product = diagnostics._parse_vid_pid(
            r"\\?\HID#vid_045e&pid_028e&ig_00#9&6ec1b80&0&0000"
        )
        self.assertEqual((vendor, product), (0x045E, 0x028E))
        self.assertEqual(diagnostics._parse_vid_pid(r"\\?\HID#VID_1234"), (None, None))

    def test_virtual_evidence_marks_synthetic_devices(self) -> None:
        self.assertTrue(
            diagnostics._has_virtual_evidence(
                r"SWD\SYNTHETICGAMEPADENUM\SYNTHETICGAMEPAD0"
            )
        )
        self.assertTrue(
            diagnostics._has_virtual_evidence(r"ROOT\VIGEMBUS\0000")
        )
        self.assertFalse(
            diagnostics._has_virtual_evidence(
                r"USB\VID_045E&PID_028E\1187A89",
                "Controller (XBOX 360 For Windows)",
            )
        )

    def test_hid_to_pnp_association_observes_physical_bus(self) -> None:
        hid_devices = [
            {
                "device_path": (
                    r"\\?\hid#vid_045e&pid_028e&ig_00#9&6ec1b80&0&0000"
                    r"#{4d1e55b2-f16f-11cf-88cb-001111000030}"
                ),
                "instance_id": r"HID\VID_045E&PID_028E&IG_00\9&6EC1B80&0&0000",
                "description": "HID-compliant game controller",
                "friendly_name": None,
            }
        ]
        pnp_devices = [
            {
                "instance_id": r"USB\VID_045E&PID_028E\1187A89",
                "parent": r"USB\VID_1A40&PID_0101\6&3a222523&0&3",
                "container_id": "{1D6D3CB2-FAEF-514E-9C30-3937D679613F}",
                "service": "xusb22",
                "bus_reported_device_desc": "Controller",
                "friendly_name": "XBOX 360 Controller",
            }
        ]

        diagnostics._annotate_hid_records(hid_devices, pnp_devices)

        self.assertEqual(hid_devices[0]["transport_family"], "usb")
        self.assertFalse(hid_devices[0]["virtual_evidence"])
        self.assertEqual(
            hid_devices[0]["physicality"], "physical_bus_topology_observed"
        )

    def test_candidate_uses_container_association_but_stays_unconfirmed(self) -> None:
        gamepad_id = r"HID\VID_1234&PID_ABCD&MI_00&COL01\1"
        candidate_id = r"HID\VID_1234&PID_ABCD&MI_00&COL02\2"
        hid_devices = [
            {
                "instance_id": gamepad_id,
                "device_path": rf"\\?\hid#{gamepad_id.replace(chr(92), '#')}",
                "vendor_id": "0x1234",
                "product_id": "0xabcd",
                "same_vid_pid_candidate": False,
                "gamepad_usage": True,
                "controller_usage": "gamepad",
            },
            {
                "instance_id": candidate_id,
                "device_path": rf"\\?\hid#{candidate_id.replace(chr(92), '#')}",
                "vendor_id": "0x1234",
                "product_id": "0xabcd",
                "same_vid_pid_candidate": True,
                "candidate_for_gamepad_instance_ids": [gamepad_id],
                "confirmed_same_device": False,
            },
        ]
        pnp_devices = [
            {
                "instance_id": gamepad_id,
                "parent": r"USB\VID_1234&PID_ABCD\3",
                "container_id": "{11111111-2222-3333-4444-555555555555}",
            },
            {
                "instance_id": candidate_id,
                "parent": r"USB\VID_1234&PID_ABCD\3",
                "container_id": "{11111111-2222-3333-4444-555555555555}",
            },
        ]

        diagnostics._annotate_hid_records(hid_devices, pnp_devices)

        candidate = hid_devices[1]
        self.assertEqual(candidate["association_evidence"], "container_id_match")
        self.assertEqual(candidate["candidate_for_gamepad_instance_ids"], [gamepad_id])
        self.assertFalse(candidate["confirmed_same_device"])


class PnpParsingTests(unittest.TestCase):
    def test_parse_pnp_output_accepts_utf8_bom_and_warnings(self) -> None:
        payload = {
            "devices": [{"InstanceId": r"USB\VID_045E&PID_028E\1"}],
            "warnings": ["属性不可用"],
        }
        raw = b"\xef\xbb\xbf" + json.dumps(payload, ensure_ascii=False).encode("utf-8")

        devices, warnings = diagnostics._parse_pnp_output(raw)

        self.assertEqual(devices[0]["InstanceId"], r"USB\VID_045E&PID_028E\1")
        self.assertEqual(warnings, ["属性不可用"])

    def test_parse_pnp_output_handles_utf16_and_plain_arrays(self) -> None:
        payload = [{"InstanceId": "HID\\VID_045E&PID_028E"}]
        raw = json.dumps(payload).encode("utf-16")

        devices, warnings = diagnostics._parse_pnp_output(raw)

        self.assertEqual(devices, payload)
        self.assertEqual(warnings, [])

    def test_pnp_filter_excludes_unrelated_hid_system_controllers(self) -> None:
        payload = {
            "devices": [
                {
                    "Class": "XnaComposite",
                    "FriendlyName": "XBOX 360 Controller",
                    "InstanceId": r"USB\VID_045E&PID_028E\1",
                    "Parent": r"USB\VID_1A40&PID_0101\2",
                    "Service": "xusb22",
                },
                {
                    "Class": "HIDClass",
                    "FriendlyName": "HID-compliant system controller",
                    "InstanceId": r"HID\VID_1234&PID_5678\3",
                    "Parent": r"USB\VID_1234&PID_5678\4",
                },
                {
                    "Class": "HIDClass",
                    "FriendlyName": "符合 HID 标准的系统控制器",
                    "InstanceId": r"HID\VID_1111&PID_2222\5",
                    "Parent": r"USB\VID_1111&PID_2222\6",
                },
                {
                    "Class": "Bluetooth",
                    "FriendlyName": "Generic Bluetooth Adapter",
                    "InstanceId": r"USB\VID_8087&PID_0033\7",
                    "Parent": r"USB\ROOT_HUB30\8",
                    "Service": "BTHUSB",
                },
                {
                    "Class": "Camera",
                    "FriendlyName": "Private Camera",
                    "InstanceId": r"USB\VID_9999&PID_9999\9",
                },
            ],
            "warnings": [],
        }
        raw = json.dumps(payload).encode("utf-8")

        with mock.patch.object(
            diagnostics, "_run_powershell_json", return_value=raw
        ):
            pnp, bluetooth, candidates, radio, errors = (
                diagnostics._collect_pnp_devices()
            )

        self.assertEqual(errors, [])
        self.assertEqual([item["instance_id"] for item in pnp], [r"USB\VID_045E&PID_028E\1"])
        self.assertEqual(
            [item["instance_id"] for item in bluetooth],
            [r"USB\VID_8087&PID_0033\7"],
        )
        self.assertEqual(candidates, [])
        self.assertEqual(radio, [])

    def test_bluetooth_filter_excludes_paired_device_enumeration(self) -> None:
        paired = diagnostics._normalize_pnp_device(
            {
                "Class": "Bluetooth",
                "FriendlyName": "A paired private headset",
                "InstanceId": r"BTHENUM\DEV_PRIVATE\1",
                "Service": "BthHFEnum",
            }
        )
        adapter = diagnostics._normalize_pnp_device(
            {
                "Class": "Bluetooth",
                "FriendlyName": "Bluetooth Adapter",
                "InstanceId": r"USB\VID_8087&PID_0033\7",
                "Service": "BTHUSB",
            }
        )

        self.assertFalse(diagnostics._is_bluetooth_adapter(paired))
        self.assertTrue(diagnostics._is_bluetooth_adapter(adapter))

    def test_unbound_intel_8087_0029_is_candidate_not_available(self) -> None:
        payload = {
            "devices": [
                {
                    "Status": "OK",
                    "Class": "",
                    "FriendlyName": "",
                    "InstanceId": r"USB\VID_8087&PID_0029\8&6654480&0&4",
                    "IsPresent": True,
                    "Service": "",
                    "Driver": "",
                    "Problem": "CM_PROB_NONE",
                    "KindHint": "intel_bluetooth_hardware_candidate",
                },
                {
                    "Status": "OK",
                    "Class": "Net",
                    "FriendlyName": "Intel(R) Wi-Fi 6 AX200 160MHz",
                    "InstanceId": r"PCI\VEN_8086&DEV_2723&SUBSYS_00841A56&REV_1A\4&2B2A0A0&0&00E3",
                    "IsPresent": True,
                    "Service": "Netwtw10",
                    "KindHint": "intel_wifi_radio_context",
                },
                {
                    "Status": "OK",
                    "Class": "",
                    "FriendlyName": "",
                    "InstanceId": r"USB\VID_8087&PID_0033\9",
                    "IsPresent": True,
                    "Service": "",
                },
            ],
            "warnings": [],
        }

        with mock.patch.object(
            diagnostics,
            "_run_powershell_json",
            return_value=json.dumps(payload).encode("utf-8"),
        ):
            pnp, bluetooth, candidates, radio, errors = (
                diagnostics._collect_pnp_devices()
            )

        self.assertEqual(errors, [])
        self.assertEqual(pnp, [])
        self.assertEqual(bluetooth, [])
        self.assertEqual(len(candidates), 1)
        self.assertEqual(
            candidates[0]["instance_id"], r"USB\VID_8087&PID_0029\8&6654480&0&4"
        )
        self.assertEqual(candidates[0]["adapter_usability"], "not_usable_adapter")
        self.assertFalse(candidates[0]["usable_as_bluetooth_adapter"])
        self.assertTrue(candidates[0]["is_present"])
        self.assertEqual(len(radio), 1)
        self.assertEqual(radio[0]["context_role"], "intel_ax200_wifi_radio")

    def test_unbound_other_intel_usb_id_is_not_broadly_classified(self) -> None:
        other = diagnostics._normalize_pnp_device(
            {
                "Class": "",
                "InstanceId": r"USB\VID_8087&PID_0033\9",
                "IsPresent": True,
                "Status": "OK",
            }
        )

        self.assertFalse(diagnostics._is_intel_bluetooth_hardware_candidate(other))
        self.assertFalse(diagnostics._is_bluetooth_adapter(other))

    def test_candidate_conclusion_states_ble_unavailable(self) -> None:
        candidate = {
            "instance_id": r"USB\VID_8087&PID_0029\8&6654480&0&4",
            "adapter_usability": "not_usable_adapter",
        }

        text = "\n".join(
            diagnostics._build_conclusions([], [], [], [candidate], [])
        )

        self.assertIn(
            "发现 Intel 8087:0029 USB蓝牙硬件候选，但没有绑定蓝牙类别/服务，Windows BLE尚不可用",
            text,
        )

    def test_conclusions_use_descriptor_and_do_not_claim_o_plus_identity(self) -> None:
        hid = [
            {
                "gamepad_usage": True,
                "controller_usage": "gamepad",
                "same_vid_pid_candidate": False,
                "input_report_byte_length": 15,
                "output_report_byte_length": 0,
                "feature_report_byte_length": 0,
                "xbox_360_compatible_vid_pid": True,
                "physicality": "physical_bus_topology_observed",
            },
            {
                "same_vid_pid_candidate": True,
                "candidate_reasons": ["vendor_usage_0xff00_or_higher"],
                "association_evidence": "container_id_match",
                "input_report_byte_length": 0,
                "output_report_byte_length": 0,
                "feature_report_byte_length": 64,
                "physicality": "unconfirmed",
            },
        ]

        text = "\n".join(diagnostics._build_conclusions(hid, [], []))

        self.assertIn("Usage Page 0x0001", text)
        self.assertIn("额外 collection 候选数量为 1", text)
        self.assertIn("same_vid_pid_candidate", text)
        self.assertIn("不能证明设备是 O+", text)
        self.assertIn("不能证明蓝牙硬件不存在", text)


class ErrorHandlingTests(unittest.TestCase):
    def test_non_windows_report_is_explicit_and_complete(self) -> None:
        with mock.patch.object(diagnostics, "_is_windows", return_value=False):
            report = diagnostics.collect_report()

        self.assertEqual(set(report), set(diagnostics.COLLECT_REPORT_KEYS))
        self.assertEqual(report["pnp"], [])
        self.assertEqual(report["hid"], [])
        self.assertEqual(report["bluetooth"], [])
        self.assertEqual(report["errors"][0]["error_type"], "unsupported_platform")
        self.assertIn("不是 Windows", report["conclusions"][0])

    def test_collector_exceptions_are_preserved_without_crashing(self) -> None:
        with (
            mock.patch.object(diagnostics, "_is_windows", return_value=True),
            mock.patch.object(
                diagnostics,
                "_collect_hid_devices",
                side_effect=RuntimeError("mock HID failure"),
            ),
            mock.patch.object(
                diagnostics,
                "_collect_pnp_devices",
                side_effect=RuntimeError("mock PnP failure"),
            ),
        ):
            report = diagnostics.collect_report()

        self.assertEqual(set(report), set(diagnostics.COLLECT_REPORT_KEYS))
        messages = [item["message"] for item in report["errors"]]
        self.assertIn("mock HID failure", messages)
        self.assertIn("mock PnP failure", messages)
        self.assertTrue(report["conclusions"])

    def test_powershell_timeout_becomes_an_error_record(self) -> None:
        timeout = subprocess.TimeoutExpired(cmd=["powershell.exe"], timeout=30)
        with (
            mock.patch.object(
                diagnostics.shutil, "which", side_effect=lambda name: "powershell.exe"
            ),
            mock.patch.object(diagnostics.subprocess, "run", side_effect=timeout),
        ):
            pnp, bluetooth, candidates, radio, errors = (
                diagnostics._collect_pnp_devices()
            )

        self.assertEqual(pnp, [])
        self.assertEqual(bluetooth, [])
        self.assertEqual(candidates, [])
        self.assertEqual(radio, [])
        self.assertEqual(errors[0]["error_type"], "TimeoutExpired")
        self.assertIn("timed out", errors[0]["message"])

    def test_powershell_uses_encoded_command_and_no_window_flag(self) -> None:
        completed = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout=b'{"devices":[],"warnings":[]}',
            stderr=b"",
        )
        with (
            mock.patch.object(diagnostics, "_is_windows", return_value=True),
            mock.patch.object(
                diagnostics.shutil, "which", side_effect=lambda name: "powershell.exe"
            ),
            mock.patch.object(
                diagnostics.subprocess, "run", return_value=completed
            ) as run_mock,
        ):
            output = diagnostics._run_powershell_json(timeout=7)

        self.assertEqual(output, completed.stdout)
        command = run_mock.call_args.args[0]
        self.assertIn("-EncodedCommand", command)
        self.assertEqual(run_mock.call_args.kwargs["timeout"], 7)
        self.assertEqual(
            run_mock.call_args.kwargs["creationflags"], diagnostics._CREATE_NO_WINDOW
        )

    @unittest.skipUnless(os.name == "nt", "Windows-only ctypes signature check")
    def test_native_handles_remain_pointer_sized_on_64_bit_python(self) -> None:
        setupapi, hid, kernel32 = diagnostics._load_windows_apis()
        if ctypes.sizeof(ctypes.c_void_p) == 8:
            self.assertEqual(ctypes.sizeof(wintypes.HANDLE), 8)
            self.assertIs(setupapi.SetupDiGetClassDevsW.restype, wintypes.HANDLE)
            self.assertIs(kernel32.CreateFileW.restype, wintypes.HANDLE)
            self.assertIs(hid.HidD_GetAttributes.argtypes[0], wintypes.HANDLE)
            self.assertIs(hid.HidD_GetPreparsedData.argtypes[0], wintypes.HANDLE)


if __name__ == "__main__":
    unittest.main()
