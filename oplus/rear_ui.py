"""Draft-based editor for six on-board gamepad rear slots."""
from __future__ import annotations

import asyncio
import queue
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from . import board, rear


class RearEditor(ttk.Frame):
    def __init__(self, studio, host_frame, *, on_refresh):
        super().__init__(host_frame)
        self.studio, self.on_refresh = studio, on_refresh
        self.snapshot = None
        self.pending, self.expected, self.labels = {}, {}, {}
        self.undo_changes, self.undo_expected = {}, {}
        self.enabled = False
        self.read_ok = False
        self.selected = 0
        self.form_cache = {}
        self.cancel_event = None
        self.pack(fill="x", expand=True)
        self.status = tk.StringVar(value="读取配置后，可编辑六个背键。修改先进入待写入列表。")
        ttk.Label(self, text="背键映射与宏", style="Section.TLabel").pack(anchor="w")
        ttk.Label(self, text="选择一行编辑；保持映射随背键按住，定时宏按步骤执行。配置保存到手柄。",
                  style="Muted.TLabel", wraplength=900).pack(anchor="w", pady=(5, 8))
        self.tree = ttk.Treeview(self, columns=("name", "current", "pending"), show="headings", height=6,
                                 selectmode="browse")
        for key, title, width in (("name", "背键 / 槽位", 155), ("current", "手柄当前配置", 340),
                                  ("pending", "待写入修改", 340)):
            self.tree.heading(key, text=title)
            self.tree.column(key, width=width, minwidth=100, stretch=True)
        self.tree.pack(fill="x")
        self.tree.bind("<<TreeviewSelect>>", self._selection_changed)
        name_row = ttk.Frame(self)
        name_row.pack(fill="x", pady=7)
        ttk.Label(name_row, text="实体键名称").pack(side="left")
        self.name = tk.StringVar()
        self.name_box = ttk.Combobox(name_row, textvariable=self.name, values=rear.PHYSICAL_NAMES, width=12)
        self.name_box.pack(side="left", padx=8)
        self.name_button = ttk.Button(name_row, text="记住名称", command=self.save_name)
        self.name_button.pack(side="left")
        self.identify_button = ttk.Button(name_row, text="引导识别六个背键", command=self.identify)
        self.identify_button.pack(side="left", padx=10)
        self.label_source = tk.StringVar(value="已知型号自动匹配名称；也可手动填写或重新校正。")
        ttk.Label(self, textvariable=self.label_source,
                  style="Muted.TLabel", wraplength=900).pack(anchor="w", pady=(0, 4))
        mode_row = ttk.Frame(self)
        mode_row.pack(fill="x", pady=(6, 4))
        self.mode = tk.StringVar(value="hold")
        self.mode_buttons = []
        for value, label in (("hold", "保持映射（单键 / 同时按多个键）"), ("macro", "定时宏")):
            button = ttk.Radiobutton(mode_row, text=label, variable=self.mode, value=value, command=self._show_mode)
            button.pack(side="left", padx=(0, 20))
            self.mode_buttons.append(button)
        self.hold_frame = ttk.Frame(self)
        self.hold_vars, self.hold_buttons = {}, []
        self.macro_frame = ttk.Frame(self)
        self.sequence = tk.StringVar()
        self.sequence_entry = ttk.Entry(self.macro_frame, textvariable=self.sequence)
        self.sequence_entry.pack(fill="x", pady=4)
        step_row = ttk.Frame(self.macro_frame)
        step_row.pack(fill="x", pady=3)
        self.step_key = tk.StringVar(value="A")
        self.step_hold, self.step_gap = tk.StringVar(value="100"), tk.StringVar(value="60")
        self.step_box = ttk.Combobox(step_row, textvariable=self.step_key, width=16,
                                    values=["A", "B", "X", "Y", "LB", "RB", "LT", "RT", "A+B", "LB+RB"])
        for label, widget in (("步骤按键", self.step_box),
                              ("按住 ms", ttk.Spinbox(step_row, textvariable=self.step_hold, from_=5, to=10000, increment=5, width=7)),
                              ("松开 ms", ttk.Spinbox(step_row, textvariable=self.step_gap, from_=0, to=10000, increment=5, width=7))):
            ttk.Label(step_row, text=label).pack(side="left", padx=(0, 6))
            widget.pack(side="left", padx=(0, 12))
        self.append_button = ttk.Button(step_row, text="追加一步", command=self.append_step)
        self.append_button.pack(side="left")
        self.loop = tk.StringVar(value="0")
        loop_row = ttk.Frame(self.macro_frame)
        loop_row.pack(fill="x", pady=4)
        ttk.Label(loop_row, text="循环间隔 ms（0 为执行一次）").pack(side="left")
        self.loop_box = ttk.Spinbox(loop_row, textvariable=self.loop, from_=0, to=20000, increment=5, width=8)
        self.loop_box.pack(side="left", padx=8)
        ttk.Label(self.macro_frame, text="例：A+B:100/60, X:80/0；加号同时按，逗号按顺序。时间按 5 ms 步进。",
                  style="Muted.TLabel", wraplength=880).pack(anchor="w", pady=3)
        self.trigger = 0
        edit_row = ttk.Frame(self)
        edit_row.pack(fill="x", pady=8)
        self.stage_button = ttk.Button(edit_row, text="加入待写入", command=self.stage, style="Accent.TButton")
        self.stage_button.pack(side="left")
        self.remove_button = ttk.Button(edit_row, text="撤销选中改动", command=self.remove_pending)
        self.remove_button.pack(side="left", padx=8)
        self.detail = tk.StringVar()
        ttk.Label(edit_row, textvariable=self.detail, style="Muted.TLabel", wraplength=620).pack(side="left", padx=8)
        self.hold_frame.pack(before=edit_row, fill="x", pady=4)
        self.action_row = ttk.Frame(self)
        self.action_row.pack(fill="x", pady=(3, 7))
        self.apply_button = ttk.Button(self.action_row, text="保存到手柄（0 项）", command=self.apply, style="Accent.TButton")
        self.apply_button.pack(side="left")
        self.undo_button = ttk.Button(self.action_row, text="恢复上次写入前配置", command=self.undo)
        self.undo_button.pack(side="left", padx=8)
        self.export_button = ttk.Button(self.action_row, text="导出背键配置", command=self.export_profile)
        self.export_button.pack(side="left", padx=5)
        self.import_button = ttk.Button(self.action_row, text="导入为待写入", command=self.import_profile)
        self.import_button.pack(side="left", padx=5)
        ttk.Label(self, textvariable=self.status, wraplength=900, style="Muted.TLabel").pack(anchor="w", fill="x", pady=(4, 8))
        self._edit_row = edit_row
        self.set_enabled(False)

    def set_enabled(self, enabled):
        self.enabled = bool(enabled and self.read_ok)
        active = self.enabled and not self.studio.busy
        for button in [self.stage_button, self.name_button, self.identify_button, self.export_button, self.import_button,
                       self.append_button, *self.mode_buttons, *self.hold_buttons]:
            button.configure(state="normal" if active else "disabled")
        for widget in [self.name_box, self.sequence_entry, self.step_box, self.loop_box]:
            widget.configure(state="normal" if active else "disabled")
        self.tree.configure(selectmode="browse" if active else "none")
        self.apply_button.configure(state="normal" if active and self.pending else "disabled",
                                    text=f"保存到手柄（{len(self.pending)} 项）")
        self.remove_button.configure(state="normal" if active and self.selected in self.pending else "disabled")
        self.undo_button.configure(state="normal" if active and self.undo_changes else "disabled")

    def set_snapshot(self, snapshot, enabled=True):
        self.read_ok = False
        old_address = (self.snapshot or {}).get("address")
        address = snapshot.get("address", "") if isinstance(snapshot, dict) else ""
        if old_address != address:
            self.pending.clear()
            self.expected.clear()
            self.form_cache.clear()
            self.undo_changes.clear()
            self.undo_expected.clear()
        self.snapshot = snapshot
        try:
            rear.layout(snapshot)
            for slot in range(6):
                rear.validate_record(snapshot, bytes.fromhex(rear.payload_hex(snapshot, slot)))
            self.labels, label_source = rear.resolve_labels(snapshot)
            self.label_source.set(label_source)
            self.identify_button.configure(text="重新校正六个背键" if len(self.labels) == 6 else "引导识别六个背键")
            codes = [k for k in snapshot["decoded"]["remap_keys"] if k in (1,2,3,4,5,6,7,8,11,12,13,14,15,16,93,94)]
        except (ValueError, KeyError, TypeError, AttributeError):
            self.status.set("背键记录尚未完整读取；请读取板载配置。")
            self.set_enabled(False)
            return
        self.read_ok = True
        if old_address == address and not getattr(self, "_reset_forms", False):
            self._remember_form()
        self._reset_forms = False
        for widget in self.hold_frame.winfo_children():
            widget.destroy()
        self.hold_vars, self.hold_buttons = {}, []
        names = {11: "LS（左杆按下）", 12: "RS（右杆按下）", 13: "十字键下", 14: "十字键上", 15: "十字键右", 16: "十字键左"}
        for index, code in enumerate(codes):
            variable = tk.BooleanVar(value=False)
            button = ttk.Checkbutton(self.hold_frame, text=names.get(code, board.KEY_LABELS.get(code, str(code))), variable=variable)
            button.grid(row=index//4, column=index%4, sticky="w", padx=(0, 25), pady=2)
            self.hold_vars[code] = variable
            self.hold_buttons.append(button)
        self._refresh_rows()
        self._load_form(self.selected)
        conflicts = [i+1 for i in self.pending if self.expected[i] != rear.payload_hex(snapshot, i)]
        self.status.set(f"槽 {conflicts} 的手柄配置已改变；请撤销相应草稿后重新编辑。" if conflicts else
                        "当前配置已读取。编辑后先加入待写入，再保存到手柄；写入前会自动备份。")
        self.set_enabled(enabled)

    def _refresh_rows(self):
        self.tree.delete(*self.tree.get_children())
        for slot in range(6):
            name = f"{self.labels.get(slot, '待识别')} · 槽 {slot+1}"
            self.tree.insert("", "end", iid=str(slot), values=(name, rear.describe(self.snapshot, slot),
                               rear.describe(self.snapshot, slot, self.pending[slot]) if slot in self.pending else "—"))
        self.tree.selection_set(str(self.selected))

    def _remember_form(self):
        if self.hold_vars:
            self.form_cache[self.selected] = {"mode": self.mode.get(), "keys": [k for k,v in self.hold_vars.items() if v.get()],
                                              "sequence": self.sequence.get(), "loop": self.loop.get(), "trigger": self.trigger}

    def _selection_changed(self, _event=None):
        selection = self.tree.selection()
        if not selection or not self.enabled or self.studio.busy:
            return
        slot = int(selection[0])
        if slot != self.selected:
            self._remember_form()
            self.selected = slot
            self._load_form(slot)
            self.set_enabled(self.enabled)

    def _load_form(self, slot):
        if not self.snapshot:
            return
        self.name.set(self.labels.get(slot, ""))
        cached = self.form_cache.get(slot)
        if cached is None:
            payload = rear.encode_change(self.snapshot, self.pending[slot]) if slot in self.pending else bytes.fromhex(rear.payload_hex(self.snapshot, slot))
            keys, sequence, loop, trigger, mode = [], "", 0, 0, "hold"
            if payload != b"\x00":
                program = rear.codec.parse_macro_payload(payload)
                spec = rear.layout(self.snapshot)
                if len(program.steps) == 1 and program.steps[0].duration_ms == 0 and not program.loop_interval_ms:
                    keys = [int(k) for k,bit in spec.digital.items() if program.steps[0].mask & (1 << bit)]
                else:
                    mode = "macro"
                    raw = {"declared": payload[0], "hex": payload[1:].hex()}
                    sequence = board.macro_sequence(raw, spec)["sequence"]
                loop, trigger = program.loop_interval_ms, program.trigger
            cached = {"mode": mode, "keys": keys, "sequence": sequence, "loop": str(loop), "trigger": trigger}
        self.mode.set(cached["mode"])
        for key, value in self.hold_vars.items():
            value.set(key in cached["keys"])
        self.sequence.set(cached["sequence"])
        self.loop.set(str(cached["loop"]))
        self.trigger = cached["trigger"]
        self.detail.set("当前：" + rear.describe(self.snapshot, slot))
        self._show_mode()

    def _show_mode(self):
        self.hold_frame.pack_forget()
        self.macro_frame.pack_forget()
        (self.hold_frame if self.mode.get() == "hold" else self.macro_frame).pack(before=self._edit_row, fill="x", pady=4)

    def _error(self, error):
        messagebox.showerror("背键配置", str(error), parent=self.studio)

    def append_step(self):
        try:
            fragment = f"{self.step_key.get().strip()}:{int(self.step_hold.get())}/{int(self.step_gap.get())}"
            rear.encode_change(self.snapshot, {"kind": "macro", "sequence": fragment})
            self.sequence.set((self.sequence.get().strip()+", " if self.sequence.get().strip() else "")+fragment)
        except (ValueError, KeyError) as exc:
            self._error(exc)

    def stage(self):
        if not self.enabled or self.studio.busy:
            return False
        try:
            change = ({"kind": "hold", "keys": [k for k,v in self.hold_vars.items() if v.get()]} if self.mode.get() == "hold" else
                      {"kind": "macro", "sequence": self.sequence.get().strip(), "loop_ms": int(self.loop.get()), "trigger": self.trigger})
            target = rear.encode_change(self.snapshot, change)
            current = rear.payload_hex(self.snapshot, self.selected)
            if target == bytes.fromhex(current):
                self.pending.pop(self.selected, None)
                self.expected.pop(self.selected, None)
            else:
                self.expected.setdefault(self.selected, current)
                self.pending[self.selected] = change
            self._remember_form()
            self._refresh_rows()
            self.status.set(f"已暂存 {len(self.pending)} 项修改，尚未写入手柄。")
            self.set_enabled(True)
            return True
        except (ValueError, KeyError, TypeError) as exc:
            self._error(exc)
            return False

    def remove_pending(self):
        if not self.enabled or self.studio.busy:
            return
        self.pending.pop(self.selected, None)
        self.expected.pop(self.selected, None)
        self.form_cache.pop(self.selected, None)
        self._refresh_rows()
        self._load_form(self.selected)
        self.set_enabled(True)

    def save_name(self):
        if not self.enabled or self.studio.busy:
            return
        try:
            labels = {**self.labels, self.selected: self.name.get().strip()}
            rear.save_labels(self.snapshot["address"], labels)
            self.labels, source = rear.resolve_labels(self.snapshot)
            self.label_source.set(source)
            self._refresh_rows()
            self.status.set("名称已记在此电脑；手柄配置未改变。")
        except (ValueError, OSError) as exc:
            self._error(exc)

    def _run_changes(self, changes, expected, *, undoing=False):
        if not self.enabled or self.studio.busy:
            return
        address = self.snapshot["address"]
        self.studio.stop("正在保存背键配置，电脑端映射已暂停。")
        self.set_enabled(False)
        self.status.set("正在备份、写入并核对；失败时会尝试恢复本次修改。")
        def finished(result):
            from .app import write_report
            try:
                write_report("rear-write", result)
            except OSError:
                pass
            if not undoing:
                self.undo_changes = result.get("undo_changes", {})
                self.undo_expected = result.get("undo_expected", {})
            else:
                self.undo_changes, self.undo_expected = {}, {}
            self.pending, self.expected, self.form_cache = {}, {}, {}
            self._reset_forms = True
            self.on_refresh(result)
            self.status.set("已恢复上次写入前的背键配置。" if undoing else "背键配置已保存到手柄，读回一致；请按实体背键确认效果。")
            self.studio.footer.configure(text=self.status.get())
        self.studio.background(lambda: asyncio.run(rear.apply_changes(address, changes, expected=expected)),
                               finished, "正在保存背键配置…", on_error=self._failed, critical=True)

    def _failed(self, error):
        self.read_ok = False
        self.set_enabled(False)
        self.status.set(str(error)+"；草稿已保留，请重新读取配置后检查。")

    def apply(self):
        if self.pending:
            self._run_changes(dict(self.pending), dict(self.expected))

    def undo(self):
        if self.pending:
            self._error("请先保存或逐项撤销待写入修改，再恢复上次配置。")
        elif self.undo_changes:
            self._run_changes(dict(self.undo_changes), dict(self.undo_expected), undoing=True)

    def export_profile(self):
        if not self.enabled or self.studio.busy:
            return
        path = filedialog.asksaveasfilename(parent=self.studio, initialfile="OPlus-rear.json", defaultextension=".json", filetypes=[("背键配置", "*.json")])
        if path:
            try:
                rear.save_profile(path, self.snapshot, self.labels)
                self.status.set("已导出手柄当前背键配置；待写入草稿未包含在内。")
            except (ValueError, OSError) as exc:
                self._error(exc)

    def import_profile(self):
        if not self.enabled or self.studio.busy:
            return
        path = filedialog.askopenfilename(parent=self.studio, initialdir=str(board.data_dir()/"backups"),
                                         filetypes=[("背键配置 / 自动备份", "*.json")])
        if path:
            try:
                changes = rear.load_profile(path, self.snapshot)
                for slot, change in changes.items():
                    self.expected.setdefault(slot, rear.payload_hex(self.snapshot, slot))
                    self.pending[slot] = change
                    self.form_cache.pop(slot, None)
                self._refresh_rows()
                self._load_form(self.selected)
                self.status.set(f"已导入 {len(changes)} 项到待写入列表，尚未改变手柄。")
                self.set_enabled(True)
            except (ValueError, KeyError, OSError, TypeError) as exc:
                self._error(exc)

    def identify(self):
        if not self.enabled or self.studio.busy:
            return
        if self.pending:
            self._error("识别前请先保存或撤销待写入修改。")
            return
        from .rear_identify import identify_slots
        self.cancel_event = threading.Event()
        events = queue.Queue()
        popup = tk.Toplevel(self.studio)
        popup.title("识别实体背键")
        popup.geometry("560x220")
        popup.transient(self.studio)
        popup.update_idletasks()
        popup.geometry(f"+{max(0,self.studio.winfo_rootx()+(self.studio.winfo_width()-560)//2)}+{max(0,self.studio.winfo_rooty()+(self.studio.winfo_height()-220)//2)}")
        popup.attributes("-topmost", True)
        message = tk.StringVar(value="正在备份并设置临时标记，请先松开手柄所有按键…")
        ttk.Label(popup, textvariable=message, wraplength=510, padding=20).pack(fill="both", expand=True)
        cancel = ttk.Button(popup, text="取消并恢复原配置", command=self.cancel_identification)
        cancel.pack(pady=12)
        popup.protocol("WM_DELETE_WINDOW", self.cancel_identification)
        self.studio.stop("正在识别背键，电脑端映射已暂停。")
        self.set_enabled(False)
        def consume():
            if not popup.winfo_exists():
                return
            while not events.empty():
                message.set(events.get_nowait())
            popup.after(80, consume)
        consume()
        def finish(result):
            popup.destroy()
            self.cancel_event = None
            labels = result.get("identified_labels", {})
            label_error = ""
            if len(labels) == 6:
                try:
                    rear.save_labels(result["address"], labels)
                except OSError as exc:
                    label_error = f"原配置已恢复，但名称保存失败：{exc}"
            from .app import write_report
            try:
                write_report("rear-identification", result)
            except OSError:
                pass
            self.on_refresh(result)
            self.status.set(label_error or ("六个背键名称已识别，原配置已全部恢复。" if len(labels) == 6 else "识别已结束，原配置已恢复；未更改背键名称。"))
            self.studio.footer.configure(text=self.status.get())
        def fail(error):
            popup.destroy()
            self.cancel_event = None
            self._failed(error)
        self.studio.background(lambda: asyncio.run(identify_slots(self.snapshot["address"],
                              cancel=self.cancel_event, on_status=events.put, input_slot=int(self.studio.slot.get()))),
                               finish, "正在识别背键…", on_error=fail, critical=True)

    def cancel_identification(self):
        if self.cancel_event is not None:
            self.cancel_event.set()
