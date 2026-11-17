"""Native Tk panel for the O+ on-board configuration protocol."""

from __future__ import annotations

import asyncio
import json
import re
import tkinter as tk
from collections.abc import Mapping, Sequence
from tkinter import messagebox, ttk
from typing import Any, Callable

from . import board


MACRO_SLOTS = 6
MOTOR_CHANNELS = 4
LIGHTING_ZONES = 4
ENABLED_LIGHTING_ZONES = (0, 1, 3)
FEATURE_LABELS = {
    "motors": "马达强度",
    "remapping": "标准键映射",
    "lighting": "RGB",
    "macro": "宏",
    "back_mapping": "背键单键映射",
    "rear": "背键配置",
}


def _mapping(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        return dict(value)
    return {}


def _sequence(value: Any) -> list[Any]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return list(value)
    return []


def _integer(value: Any, default: int | None = None) -> int | None:
    if isinstance(value, bool):
        return int(value)
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return default


def _int_sequence(value: Any) -> list[int]:
    result: list[int] = []
    for item in _sequence(value):
        number = _integer(item)
        if number is not None:
            result.append(number)
    return result


def _json_mapping(value: Any) -> dict[Any, Any]:
    current = value
    for _ in range(3):
        if isinstance(current, Mapping):
            return dict(current)
        if not isinstance(current, str) or not current.strip():
            return {}
        try:
            current = json.loads(current)
        except (TypeError, ValueError, json.JSONDecodeError):
            return {}
    return dict(current) if isinstance(current, Mapping) else {}


def _int_mapping(value: Any) -> dict[int, int]:
    result: dict[int, int] = {}
    for raw_source, raw_target in _json_mapping(value).items():
        source = _integer(raw_source)
        target = _integer(raw_target)
        if source is not None and target is not None:
            result[source] = target
    return result


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "identified", "verified"}


def _macro_timing_groups(sequence: str) -> list[tuple[str, int, int]]:
    groups: list[tuple[str, int, int]] = []
    for raw_group in sequence.split(","):
        group = raw_group.strip()
        if not group:
            raise ValueError("宏序列包含空分组。")
        keys, separator, timing = group.partition(":")
        if not separator or not keys.strip():
            raise ValueError("宏序列格式应为 A:100/60, B:80/0。")
        hold_text, slash, gap_text = timing.partition("/")
        try:
            hold = int(hold_text or "100")
            gap = int(gap_text if slash else "60")
        except ValueError:
            raise ValueError("宏序列时间必须为整数。") from None
        groups.append((keys.strip(), hold, gap))
    return groups


def _single_key_hold_timing(sequence: str) -> str | None:
    try:
        groups = _macro_timing_groups(sequence)
    except ValueError:
        return None
    if len(groups) != 1:
        return None
    keys, hold, gap = groups[0]
    if hold == 0 and gap == 0 and "+" not in keys:
        return keys
    return None


def _raw_byte_to_percent(value: int) -> int:
    return max(0, min(100, round(max(0, min(255, value)) * 100 / 255)))


class BoardPanel(ttk.Frame):
    """One scrollable board-settings page hosted inside an existing Studio tab."""

    def __init__(self, studio: tk.Misc, host_frame: tk.Misc):
        super().__init__(host_frame, style="Panel.TFrame")
        self.studio = studio
        self.snapshot: dict[str, Any] | None = None
        self._read_ok = False
        self._address_trace_running = False
        self._write_buttons: list[tuple[ttk.Button, Callable[[], bool]]] = []
        self._key_label_values: dict[int, str] = {}
        self._key_codes_by_display: dict[str, int] = {}
        self._remap_code_by_display: dict[str, int] = {}
        self._target_code_by_display: dict[str, int] = {}
        self._back_target_by_display: dict[str, int] = {}
        self._remap_keys: list[int] = []
        self._all_keys: list[int] = []
        self._remappings: dict[int, int] = {}
        self._macros: list[dict[str, Any]] = []
        self._back_mapping: dict[int, int] = {}
        self._single_key_targets: dict[int, int] = {}
        self._macro_key_tokens: dict[str, int] = {}
        self._lighting: list[dict[str, Any]] = []
        self._lighting_caps = 0

        try:
            initial_address = str(board.saved_address() or "")
        except Exception:
            initial_address = ""
        self.address = tk.StringVar(master=studio, value=initial_address)
        self.status = tk.StringVar(value="手柄开机并退出手机 KeyLinker 后，点击“发现 O+ 并读取”。")
        self.summary = tk.StringVar(value="已有地址时也可直接连接并读取。")

        self.pack(fill="both", expand=True)
        self._build()
        self.address.trace_add("write", self._address_changed)
        self._set_write_buttons(False)

    def _build(self) -> None:
        header = ttk.Frame(self)
        header.pack(fill="x", pady=(0, 12))
        ttk.Label(header, text="O+ 板载配置", style="Section.TLabel").pack(anchor="w")
        ttk.Label(
            header,
            text="配置直接保存在手柄；写入后会立即重新读取并核对。",
            style="Muted.TLabel",
            wraplength=900,
        ).pack(anchor="w", pady=(5, 0))

        connection = ttk.LabelFrame(self, text="连接手柄", padding=12)
        connection.pack(fill="x", pady=(0, 12))
        address_row = ttk.Frame(connection)
        address_row.pack(fill="x")
        ttk.Label(address_row, text="BLE 地址").pack(side="left", padx=(0, 8))
        self.address_entry = ttk.Entry(address_row, textvariable=self.address, width=23)
        self.address_entry.pack(side="left")
        ttk.Button(address_row, text="连接并读取", command=self.read).pack(side="left", padx=10)
        ttk.Button(address_row, text="发现 O+ 并读取", command=self.discover, style="Accent.TButton").pack(side="left")
        ttk.Label(connection, textvariable=self.status, style="Muted.TLabel", wraplength=930).pack(
            anchor="w", fill="x", pady=(8, 0))
        ttk.Label(
            connection,
            textvariable=self.summary,
            style="Muted.TLabel",
            wraplength=930,
        ).pack(anchor="w", fill="x", pady=(10, 0))

        self._build_rear_slots()
        self._build_motors()
        self._build_remapping()
        self._build_curves()
        self._build_lighting()

    def _build_motors(self) -> None:
        section = ttk.LabelFrame(self, text="4 马达强度", padding=12)
        section.pack(fill="x", pady=(0, 12))
        self.motor_values: list[tk.DoubleVar] = []
        for index in range(MOTOR_CHANNELS):
            row = ttk.Frame(section)
            row.pack(fill="x", pady=2)
            ttk.Label(row, text=f"通道 {index + 1}", width=10).pack(side="left")
            variable = tk.DoubleVar(master=self.studio, value=0)
            self.motor_values.append(variable)
            ttk.Scale(
                row,
                variable=variable,
                from_=0,
                to=100,
                length=430,
            ).pack(side="left", fill="x", expand=True, padx=8)
            ttk.Spinbox(row, from_=0, to=100, increment=1,
                        textvariable=variable, width=6).pack(side="left", padx=(4, 0))
        self.motor_raw = tk.StringVar(master=self.studio, value="原始 8 字节：—")
        ttk.Label(section, textvariable=self.motor_raw, style="Muted.TLabel").pack(
            anchor="w", pady=(6, 6)
        )
        button = ttk.Button(
            section,
            text="写入并读回核对",
            style="Accent.TButton",
            command=self._apply_motors,
        )
        button.pack(anchor="w")
        self._register_write_button(button, lambda: bool(self._read_ok))

    def _build_remapping(self) -> None:
        section = ttk.LabelFrame(self, text="标准键映射", padding=12)
        section.pack(fill="x", pady=(0, 12))
        ttk.Label(
            section,
            text="来源仅使用设备返回的 remap_keys；目标来自设备支持的按键列表。",
            style="Muted.TLabel",
        ).pack(anchor="w", pady=(0, 8))
        row = ttk.Frame(section)
        row.pack(fill="x")
        self.remap_source = tk.StringVar(master=self.studio)
        self.remap_target = tk.StringVar(master=self.studio)
        ttk.Label(row, text="来源").pack(side="left")
        self.remap_source_combo = ttk.Combobox(
            row, textvariable=self.remap_source, state="readonly", width=18
        )
        self.remap_source_combo.pack(side="left", padx=(6, 16))
        self.remap_source_combo.bind("<<ComboboxSelected>>", self._remap_source_changed)
        ttk.Label(row, text="目标").pack(side="left")
        self.remap_target_combo = ttk.Combobox(
            row, textvariable=self.remap_target, state="readonly", width=18
        )
        self.remap_target_combo.pack(side="left", padx=(6, 10))
        button = ttk.Button(
            row,
            text="写入并读回核对",
            style="Accent.TButton",
            command=self._apply_remapping,
        )
        button.pack(side="left")
        self._register_write_button(
            button, lambda: self._read_ok and bool(self._remap_keys)
        )
        self.remap_summary = tk.StringVar(master=self.studio, value="尚未读取映射。")
        ttk.Label(
            section,
            textvariable=self.remap_summary,
            style="Muted.TLabel",
            wraplength=930,
        ).pack(anchor="w", fill="x", pady=(10, 0))

    def _build_rear_slots(self) -> None:
        from .rear_ui import RearEditor
        section = ttk.LabelFrame(self, text="背键配置", padding=12)
        section.pack(fill="x", pady=(0, 12))
        self.rear_editor = RearEditor(self.studio, section, on_refresh=self.set_snapshot)

    def _build_curves(self) -> None:
        section = ttk.LabelFrame(self, text="曲线 / 只读原始参数", padding=12)
        section.pack(fill="x", pady=(0, 12))
        ttk.Label(
            section,
            text=(
                "仅显示设备报告的内外原始参数与点位。outer 的 O+ 语义仍待验证，"
                "不会套用 vendor 的 100-raw 公式，也不提供写入。"
            ),
            style="Muted.TLabel",
            wraplength=930,
        ).pack(anchor="w", pady=(0, 8))
        self.curve_tree = ttk.Treeview(
            section,
            columns=("channel", "raw", "points", "status"),
            show="headings",
            height=4,
        )
        for column, title, width in (
            ("channel", "通道", 100),
            ("raw", "raw 内外参数", 280),
            ("points", "点位", 300),
            ("status", "标志 / 进度", 190),
        ):
            self.curve_tree.heading(column, text=title)
            self.curve_tree.column(column, width=width, minwidth=80, stretch=True)
        self.curve_tree.pack(fill="x")

    def _build_lighting(self) -> None:
        section = ttk.LabelFrame(self, text="RGB", padding=12)
        section.pack(fill="x", pady=(0, 6))
        ttk.Label(
            section,
            text=(
                "只启用 caps.lighting 中存在的 zone 1、2、4（内部 0、1、3）。"
                "提交仅包含 zone/rgb，其他灯光字段由 backend 保留。"
            ),
            style="Muted.TLabel",
            wraplength=930,
        ).pack(anchor="w", pady=(0, 8))
        self.lighting_values = [
            tk.StringVar(master=self.studio, value="#000000")
            for _ in range(LIGHTING_ZONES)
        ]
        self.lighting_entries: list[ttk.Entry] = []
        self.lighting_details: list[tk.StringVar] = []
        self.lighting_buttons: list[ttk.Button] = []
        for zone in range(LIGHTING_ZONES):
            row = ttk.Frame(section)
            row.pack(fill="x", pady=2)
            ttk.Label(row, text=f"Zone {zone + 1}", width=10).pack(side="left")
            entry = ttk.Entry(row, textvariable=self.lighting_values[zone], width=12)
            entry.configure(state="disabled")
            entry.pack(side="left", padx=(0, 10))
            self.lighting_entries.append(entry)
            detail = tk.StringVar(master=self.studio, value="尚未读取")
            self.lighting_details.append(detail)
            ttk.Label(row, textvariable=detail, style="Muted.TLabel").pack(
                side="left", fill="x", expand=True
            )
            button = ttk.Button(
                row,
                text="写入并读回核对",
                command=lambda selected_zone=zone: self._apply_lighting(selected_zone),
            )
            button.pack(side="right")
            self.lighting_buttons.append(button)
            self._register_write_button(
                button,
                lambda selected_zone=zone: (
                    self._read_ok
                    and selected_zone in ENABLED_LIGHTING_ZONES
                    and bool(self._lighting_caps & (1 << selected_zone))
                ),
            )

    def _register_write_button(
        self, button: ttk.Button, enabled: Callable[[], bool]
    ) -> None:
        self._write_buttons.append((button, enabled))
        button.configure(state="disabled")

    def _set_write_buttons(self, enabled: bool) -> None:
        for button, condition in self._write_buttons:
            allowed = enabled and condition() and not self.studio.busy
            button.configure(state="normal" if allowed else "disabled")
        if hasattr(self, "lighting_entries"):
            for zone, entry in enumerate(self.lighting_entries):
                available = (
                    enabled
                    and zone in ENABLED_LIGHTING_ZONES
                    and bool(self._lighting_caps & (1 << zone))
                )
                entry.configure(state="normal" if available else "disabled")

    def _update_write_buttons(self) -> None:
        self._set_write_buttons(self._read_ok)
        self.rear_editor.set_enabled(self._read_ok and self.rear_editor.snapshot is not None)

    def _address_value(self) -> str:
        return self.address.get().strip()

    def _set_address_value(self, value: str) -> None:
        self._address_trace_running = True
        try:
            self.address.set(value)
        finally:
            self._address_trace_running = False

    def _address_changed(self, *_args: Any) -> None:
        if self._address_trace_running:
            return
        if self.snapshot and self._address_value() != str(
            self.snapshot.get("address") or ""
        ):
            self._read_ok = False
            self.status.set("地址已改变；请重新读取配置后再写入。")
            self._update_write_buttons()

    def accept_identity(self, report: Mapping[str, Any] | None) -> bool:
        """Adopt an identified device address without reading settings."""

        if not isinstance(report, Mapping):
            return False
        identified = report.get("identified")
        if identified is None:
            identified = report.get("model_verified")
        address = str(report.get("address") or "").strip()
        if not _truthy(identified) or not address:
            return False
        self._set_address_value(address)
        self._read_ok = False
        self.status.set("已接受已识别设备地址；请点击“读取配置”。")
        self._update_write_buttons()
        return True

    def read(self) -> None:
        if self.studio.busy:
            self.status.set("请等待当前后台操作完成，再读取板载配置。")
            return
        address = self._address_value() or board.saved_address()
        if not address:
            self.discover()
            return
        self._set_address_value(address)
        self._read_ok = False
        self._update_write_buttons()
        self.status.set("正在读取板载配置…")
        self.studio.background(
            lambda: asyncio.run(board.read_settings(address)),
            self.set_snapshot,
            "正在读取 O+ 板载配置…",
            on_error=self._operation_failed,
        )

    def discover(self) -> None:
        if self.studio.busy:
            self.status.set("请等待当前操作完成。")
            return
        self._read_ok = False
        self._update_write_buttons()
        self.status.set("正在发现 O+，随后核实身份并读取配置…")
        self.studio.background(lambda: asyncio.run(board.discover_settings()), self.set_snapshot,
                               "正在发现并连接 O+…", on_error=self._operation_failed)

    def _operation_failed(self, error: str) -> None:
        self._read_ok = False
        self._update_write_buttons()
        self.status.set(error)

    def set_snapshot(self, snapshot: Mapping[str, Any] | None) -> None:
        """Populate every editor from a complete or partial board snapshot."""

        if not isinstance(snapshot, Mapping):
            self._read_ok = False
            self.snapshot = None
            self.status.set("读取失败：snapshot 不是对象。")
            self._update_write_buttons()
            return

        self.snapshot = dict(snapshot)
        snapshot_address = str(snapshot.get("address") or "").strip()
        if snapshot_address:
            self._set_address_value(snapshot_address)

        decoded = _mapping(snapshot.get("decoded"))
        capabilities = _mapping(decoded.get("capabilities"))
        identity = _mapping(snapshot.get("identity"))
        errors = [str(item) for item in _sequence(snapshot.get("errors")) if str(item)]
        self._lighting_caps = _integer(capabilities.get("lighting"), 0) or 0

        summary_bits = []
        if snapshot_address:
            summary_bits.append(f"地址 {snapshot_address}")
        if identity:
            summary_bits.append(
                "身份 VID/PID {vid}/{pid} 固件 {version}".format(
                    vid=identity.get("vid", "—"),
                    pid=identity.get("pid", "—"),
                    version=identity.get("version_display", "—"),
                )
            )
        if capabilities:
            summary_bits.append("6 个背键宏槽 · 4 路马达 · RGB 颜色配置")
        backup_path = snapshot.get("backup_path")
        if backup_path:
            summary_bits.append(f"备份 {backup_path}")
        write_result = _mapping(snapshot.get("write_result"))
        if write_result:
            feature = FEATURE_LABELS.get(
                str(write_result.get("feature") or ""), "板载配置"
            )
            if _truthy(write_result.get("readback_verified")):
                summary_bits.append(
                    f"最近写入：{feature}；记录已读回核对；实际效果请实测"
                )
            else:
                summary_bits.append(f"最近写入：{feature}；记录读回核对尚未完成")
        self.summary.set(" | ".join(summary_bits) or "snapshot 已读取，但未包含身份摘要。")

        self._load_motors(decoded)
        self._load_remapping(decoded)
        self._load_curves(snapshot, decoded)
        self._load_lighting(decoded)

        self._read_ok = bool(decoded) and not errors and board.matched(identity)
        self.rear_editor.set_snapshot(dict(snapshot), enabled=self._read_ok)
        if errors:
            self.status.set("读取不完整，写入已禁用：" + "；".join(errors[:3]))
        else:
            self.status.set("读取成功；可写入并立即读回核对。")
        self._update_write_buttons()
        self.studio.footer.configure(text=self.status.get())

    def _load_motors(self, decoded: Mapping[str, Any]) -> None:
        raw = _int_sequence(decoded.get("motors"))
        self.motor_raw.set(
            "原始 8 字节：" + (" ".join(f"{value:02X}" for value in raw) if raw else "—")
        )
        for index, variable in enumerate(self.motor_values):
            value = raw[index] if index < len(raw) else 0
            variable.set(_raw_byte_to_percent(value))

    def _key_label(self, code: int) -> str:
        labels = _mapping(getattr(board, "KEY_LABELS", {}))
        label = labels.get(code, labels.get(str(code), str(code)))
        return f"{label} ({code})"

    def _key_display(self, codes: Sequence[int]) -> tuple[list[str], dict[str, int]]:
        displays: list[str] = []
        by_display: dict[str, int] = {}
        seen: set[int] = set()
        for code in codes:
            if code in seen:
                continue
            seen.add(code)
            display = self._key_label(code)
            displays.append(display)
            by_display[display] = code
        return displays, by_display

    def _build_macro_key_tokens(self, codes: Sequence[int]) -> None:
        labels = _mapping(getattr(board, "KEY_LABELS", {}))
        key_enum = getattr(getattr(board, "codec", None), "Key", None)
        tokens: dict[str, int] = {}
        for code in codes:
            tokens[str(code).casefold()] = code
            label = labels.get(code, labels.get(str(code)))
            if label:
                tokens[str(label).strip().casefold()] = code
            if key_enum is not None:
                try:
                    tokens[key_enum(code).name.casefold()] = code
                except (ValueError, TypeError):
                    pass
        self._macro_key_tokens = tokens

    def _code_for_macro_token(self, token: str) -> int | None:
        return self._macro_key_tokens.get(token.strip().casefold())

    def _load_remapping(self, decoded: Mapping[str, Any]) -> None:
        self._remap_keys = _int_sequence(decoded.get("remap_keys"))
        all_keys = _int_sequence(decoded.get("all_keys"))
        if not all_keys:
            all_keys = list(self._remap_keys)
        self._remappings = _int_mapping(decoded.get("remapping"))
        for target in self._remappings.values():
            if target not in all_keys:
                all_keys.append(target)
        self._all_keys = all_keys
        self._build_macro_key_tokens(
            list(dict.fromkeys(self._remap_keys + _int_sequence(decoded.get("macro_keys"))))
        )

        previous_source = self._remap_code_by_display.get(self.remap_source.get())
        source_values, self._remap_code_by_display = self._key_display(self._remap_keys)
        target_values, self._target_code_by_display = self._key_display(self._remap_keys)
        self.remap_source_combo.configure(values=source_values)
        self.remap_target_combo.configure(values=target_values)
        if source_values:
            preferred = next(iter(self._remappings), self._remap_keys[0])
            source_code = previous_source if previous_source in self._remap_keys else preferred
            self.remap_source.set(self._key_label(source_code))
            self._remap_source_changed()
        else:
            self.remap_source.set("")
            self.remap_target.set("")

        if self._remappings:
            summary = "；".join(
                f"{self._key_label(source)} → {self._key_label(target)}"
                for source, target in sorted(self._remappings.items())
            )
        else:
            summary = "无自定义映射（所有来源保持原功能）。"
        self.remap_summary.set(summary)

    def _remap_source_changed(self, _event: Any = None) -> None:
        source = self._remap_code_by_display.get(self.remap_source.get())
        if source is None:
            return
        target = self._remappings.get(source, source)
        self.remap_target.set(self._key_label(target))

    def _load_curves(self, snapshot: Mapping[str, Any], decoded: Mapping[str, Any]) -> None:
        self.curve_tree.delete(*self.curve_tree.get_children())
        raw_records = _mapping(snapshot.get("raw"))
        labels = {
            "sticks": ("左摇杆", "右摇杆"),
            "triggers": ("左扳机", "右扳机"),
        }
        for group, names in labels.items():
            records = [_mapping(item) for item in _sequence(decoded.get(group))]
            raw_hex = _mapping(raw_records.get(group)).get("hex") or "—"
            for index, name in enumerate(names):
                record = records[index] if index < len(records) else {}
                inner = record.get("inner_deadzone", "—")
                outer = record.get("outer_raw", "—")
                point1 = record.get("point1", "—")
                point2 = record.get("point2", "—")
                status = (
                    f"flags={record.get('flags', '—')}; "
                    f"max_progress={record.get('max_progress', '—')}; "
                    f"raw={raw_hex}"
                )
                self.curve_tree.insert(
                    "",
                    "end",
                    values=(name, f"inner={inner}; outer_raw={outer}", f"p1={point1}; p2={point2}", status),
                )

    def _load_lighting(self, decoded: Mapping[str, Any]) -> None:
        self._lighting = [_mapping(item) for item in _sequence(decoded.get("lighting"))]
        for zone in range(LIGHTING_ZONES):
            record = self._lighting[zone] if zone < len(self._lighting) else {}
            red = _integer(record.get("r"), 0) or 0
            green = _integer(record.get("g"), 0) or 0
            blue = _integer(record.get("b"), 0) or 0
            self.lighting_values[zone].set(f"#{red:02x}{green:02x}{blue:02x}")
            self.lighting_details[zone].set(
                "data4={data4}; data5={data5}; light={light}".format(
                    data4=record.get("data4", "—"),
                    data5=record.get("data5", "—"),
                    light=record.get("light", "—"),
                )
            )

    def _show_validation_error(self, message: str) -> None:
        messagebox.showerror("参数无效", message, parent=self.studio)

    def _validated_change(self, feature: str, change: Mapping[str, Any]) -> dict[str, Any]:
        if feature == "motors":
            levels = _int_sequence(change.get("levels"))
            if len(levels) != MOTOR_CHANNELS or any(not 0 <= value <= 100 for value in levels):
                raise ValueError("马达强度必须提供 4 个 0–100 整数。")
            return {"levels": levels}
        if feature == "remapping":
            source = _integer(change.get("source"))
            target = _integer(change.get("target"))
            if source is None or target is None or source < 0 or target < 0:
                raise ValueError("标准键映射必须包含非负整数 source 和 target。")
            if source not in self._remap_keys:
                raise ValueError("映射来源不在设备报告的 remap_keys 中。")
            if target not in self._remap_keys:
                raise ValueError("映射目标不在设备报告的 remap_keys 中。")
            return {"source": source, "target": target}
        if feature == "lighting":
            zone = _integer(change.get("zone"))
            rgb = str(change.get("rgb") or "").lower()
            if zone not in ENABLED_LIGHTING_ZONES:
                raise ValueError("仅允许写入设备能力位对应的 zone 0、1、3。")
            if not self._lighting_caps & (1 << zone):
                raise ValueError("该 RGB zone 未在 caps.lighting 中启用。")
            if not re.fullmatch(r"#[0-9a-f]{6}", rgb):
                raise ValueError("RGB 必须是 #rrggbb 格式。")
            return {"zone": zone, "rgb": rgb}
        if feature == "macro":
            slot = _integer(change.get("slot"))
            loop_ms = _integer(change.get("loop_ms"))
            trigger = _integer(change.get("trigger"))
            sequence = str(change.get("sequence") or "").strip()
            if slot is None or not 0 <= slot < MACRO_SLOTS:
                raise ValueError("宏槽位必须是 0–5。")
            if not sequence:
                raise ValueError("手柄键序列不能为空。")
            if loop_ms is None or not 0 <= loop_ms <= 20000:
                raise ValueError("loop_ms 必须在 0–20000 之间。")
            if trigger not in (0, 1):
                raise ValueError("trigger 只能是 0 或 1。")
            for keys, hold, gap in _macro_timing_groups(sequence):
                if hold == 0 and gap == 0 and "+" not in keys:
                    raise ValueError(
                        f"{keys}:0/0 是单键保持记录，请使用上方“单键保持映射”按钮。"
                    )
                if not 5 <= hold <= 10000 or hold % 5:
                    raise ValueError("宏 hold 必须为 5–10000 ms，并按 5 ms 步进。")
                if not 0 <= gap <= 10000 or gap % 5:
                    raise ValueError("宏 gap 必须为 0–10000 ms，并按 5 ms 步进。")
            return {
                "slot": slot,
                "sequence": sequence,
                "loop_ms": loop_ms,
                "trigger": trigger,
            }
        if feature == "back_mapping":
            slot = _integer(change.get("slot"))
            target = _integer(change.get("target"))
            if slot is None or not 0 <= slot < MACRO_SLOTS:
                raise ValueError("背键槽位必须是 0–5。")
            if target is None or target < 0:
                raise ValueError("背键目标必须是非负整数。")
            if target not in self._remap_keys:
                raise ValueError("背键目标不在设备报告的 remap_keys 中。")
            return {"slot": slot, "target": target}
        raise ValueError(f"未知板载功能：{feature}")

    def apply(self, feature: str, change: Mapping[str, Any]) -> bool:
        """Validate and schedule one backend write without blocking Tk."""
        if self.studio.busy:
            self.status.set("请等待当前后台操作完成。")
            return False
        if not self._read_ok:
            self._show_validation_error("请先完整读取板载配置。")
            return False
        address = self._address_value()
        if not address:
            self._show_validation_error("BLE 地址不能为空。")
            return False
        try:
            clean_change = self._validated_change(feature, change)
        except ValueError as exc:
            self._show_validation_error(str(exc))
            return False

        feature_name = FEATURE_LABELS[feature]
        self.studio.stop("正在写入板载配置，电脑端键鼠 / 宏已暂停。")
        self.status.set(f"正在写入{feature_name}并读回核对…")
        self.studio.background(
            lambda: asyncio.run(board.apply_settings(address, feature, clean_change)),
            lambda fresh: self._apply_finished(feature_name, fresh),
            f"正在写入{feature_name}并读回核对…",
            on_error=self._operation_failed,
            critical=True,
        )
        return True

    def _apply_finished(self, feature_name: str, fresh_snapshot: Mapping[str, Any]) -> None:
        self.set_snapshot(fresh_snapshot)
        backup_path = str(fresh_snapshot.get("backup_path") or "").strip()
        backup_text = f" 备份：{backup_path}" if backup_path else ""
        if self._read_ok:
            result = _mapping(fresh_snapshot.get("write_result"))
            if _truthy(result.get("readback_verified")):
                self.status.set(
                    f"{feature_name}记录已读回核对；实际按键 / 灯光效果请实测。{backup_text}"
                )
            else:
                self.status.set(f"{feature_name}记录读回核对尚未完成。{backup_text}")
        else:
            self.status.set(
                f"{feature_name}已提交，但记录读回核对未完整成功；请检查状态与备份。{backup_text}"
            )

    def _apply_motors(self) -> None:
        self.apply(
            "motors",
            {"levels": [int(round(variable.get())) for variable in self.motor_values]},
        )

    def _apply_remapping(self) -> None:
        source = self._remap_code_by_display.get(self.remap_source.get())
        target = self._target_code_by_display.get(self.remap_target.get())
        self.apply("remapping", {"source": source, "target": target})

    def _apply_lighting(self, zone: int) -> None:
        self.apply("lighting", {"zone": zone, "rgb": self.lighting_values[zone].get()})


__all__ = ["BoardPanel"]
