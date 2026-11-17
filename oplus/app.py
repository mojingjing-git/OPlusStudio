"""Native Windows desktop companion with verified O+ board configuration."""
from __future__ import annotations

import asyncio
from collections import deque
from dataclasses import asdict
from datetime import datetime
import json
import os
from pathlib import Path
import queue
import sys
import threading
import time
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from . import __version__, ble, profiles
from .diagnostics import collect_report
from .engine import MappingEngine
from .board_ui import BoardPanel
from .windows_input import BUTTONS, WindowsOutput, XInput, available_keys

BG, PANEL, CARD = "#10151d", "#171f2b", "#202c3b"
TEXT, MUTED, ACCENT, GREEN = "#edf2f7", "#a5b5c8", "#73bfff", "#7de0b3"


def report_dir() -> Path:
    if getattr(sys, "frozen", False):
        # Keep user evidence outside the build output, which PyInstaller replaces.
        return Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "OPlusStudio" / "reports"
    return Path(__file__).resolve().parent.parent / "reports"


def write_report(name: str, value: dict) -> Path:
    report_dir().mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    path = report_dir() / f"{name}-{stamp}.json"
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


class Studio(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title(f"O+ Studio · 致动手柄工具 {__version__}")
        self.geometry("1120x820")
        self.minsize(1000, 760)
        self.configure(background=BG)
        self.protocol("WM_DELETE_WINDOW", self.close)
        self.xinput = XInput()
        self.output = WindowsOutput()
        self.engine = MappingEngine(self.output)
        self.events = queue.Queue()
        self.busy = False
        self.background_critical = False
        self.pending_close = False
        self.closed = False
        self.last_signal = None
        self.log_lines = deque(maxlen=70)
        self.capture = None
        self.rumble_deadline = 0
        self.rumble_slot = None
        self.report = None
        self.ble_devices = []
        self.slot = tk.StringVar(value="0")
        self.profile = json.loads(json.dumps(profiles.DEFAULT))
        self._style()
        self.tab_canvases = []
        self._build()
        self.bind_all("<MouseWheel>", self.scroll_tab, add="+")
        try:
            if profiles.profile_path().exists():
                self.profile = profiles.load(profiles.profile_path())
        except (OSError, ValueError, TypeError) as exc:
            self.log(f"本地配置未载入：{exc}")
        self.refresh_profile()
        self.after(20, self.poll)
        self.after(400, self.diagnose)

    def _style(self):
        style = ttk.Style(self)
        style.theme_use("clam")
        style.configure(".", background=PANEL, foreground=TEXT, fieldbackground=CARD,
                        bordercolor=CARD, lightcolor=CARD, darkcolor=CARD,
                        font=("Microsoft YaHei UI", 10))
        style.configure("TFrame", background=BG)
        style.configure("Panel.TFrame", background=PANEL)
        style.configure("TLabel", background=BG, foreground=TEXT)
        style.configure("Muted.TLabel", foreground=MUTED)
        style.configure("Title.TLabel", font=("Microsoft YaHei UI", 22, "bold"))
        style.configure("Section.TLabel", font=("Microsoft YaHei UI", 14, "bold"))
        style.configure("TButton", background=CARD, padding=(13, 9), borderwidth=0)
        style.map("TButton", background=[("active", "#30475d"), ("disabled", PANEL)],
                  foreground=[("disabled", "#718093")])
        style.configure("Accent.TButton", background="#285c85", foreground="white")
        style.map("Accent.TButton", background=[("active", "#357bb0")])
        style.configure("TNotebook", background=BG, borderwidth=0)
        style.configure("TNotebook.Tab", background=PANEL, padding=(20, 12), foreground=MUTED)
        style.map("TNotebook.Tab", background=[("selected", CARD)], foreground=[("selected", ACCENT)])
        style.configure("Treeview", background=PANEL, fieldbackground=PANEL, rowheight=34,
                        borderwidth=0, foreground=TEXT)
        style.configure("Treeview.Heading", background=CARD, foreground=MUTED, padding=9)
        style.map("Treeview", background=[("selected", "#285c85")])
        style.configure("TCombobox", padding=6, arrowsize=15, foreground=TEXT)
        style.map("TCombobox", fieldbackground=[("readonly", CARD)], selectbackground=[("readonly", CARD)])
        style.configure("TCheckbutton", background=BG, padding=4)
        style.configure("Horizontal.TScale", background=BG, troughcolor=CARD)
        self.option_add("*TCombobox*Listbox.background", CARD)
        self.option_add("*TCombobox*Listbox.foreground", TEXT)
        self.option_add("*TCombobox*Listbox.selectBackground", "#285c85")

    def _build(self):
        outer = ttk.Frame(self, padding=(28, 22))
        outer.pack(fill="both", expand=True)
        header = ttk.Frame(outer)
        header.pack(fill="x", pady=(0, 18))
        brand = ttk.Frame(header)
        brand.pack(side="left")
        ttk.Label(brand, text="O+ Studio", style="Title.TLabel").pack(anchor="w")
        ttk.Label(brand, text="致动 O+  /  Windows 社区工具", style="Muted.TLabel").pack(anchor="w", pady=(3, 0))
        controls = ttk.Frame(header)
        controls.pack(side="right")
        ttk.Label(controls, text="手柄槽位", style="Muted.TLabel").grid(row=0, column=0, padx=8)
        box = ttk.Combobox(controls, textvariable=self.slot, values=["0", "1", "2", "3"], width=4, state="readonly")
        box.grid(row=0, column=1)
        box.bind("<<ComboboxSelected>>", lambda _event: self.slot_changed())
        self.enable_button = ttk.Button(controls, text="启用键鼠 / 宏", style="Accent.TButton", command=self.toggle)
        self.enable_button.grid(row=0, column=2, padx=(16, 0))
        ttk.Label(controls, text="F8 随时停止  ·  启动时默认关闭", style="Muted.TLabel").grid(row=1, column=0, columnspan=3, sticky="e", pady=(6, 0))
        self.connection = ttk.Label(outer, text="正在读取 XInput…", foreground=GREEN)
        self.connection.pack(anchor="w", pady=(0, 12))
        self.footer = ttk.Label(outer, text="就绪。配置只保存在电脑上。", style="Muted.TLabel", wraplength=1000)
        self.footer.pack(side="bottom", anchor="w", fill="x", pady=(12, 0))
        self.notebook = ttk.Notebook(outer)
        self.notebook.pack(fill="both", expand=True)
        self.live_tab = self.tab("实时测试")
        self.keys_tab = self.tab("键鼠映射")
        self.macros_tab = self.tab("电脑端宏")
        self.device_tab = self.tab("设备与协议")
        self._live()
        self._keys()
        self._macros()
        self._device()
        self.board_panel = BoardPanel(self, self.tab("板载配置"))
        self.notebook.select(4)

    def tab(self, text):
        container = ttk.Frame(self.notebook)
        self.notebook.add(container, text=text)
        canvas = tk.Canvas(container, background=BG, highlightthickness=0)
        scroll = ttk.Scrollbar(container, orient="vertical", command=canvas.yview)
        canvas.configure(yscrollcommand=scroll.set)
        scroll.pack(side="right", fill="y")
        canvas.pack(side="left", fill="both", expand=True)
        frame = ttk.Frame(canvas, padding=20)
        window = canvas.create_window((0, 0), window=frame, anchor="nw")
        def resize(_event=None):
            canvas.itemconfigure(window, width=max(1, canvas.winfo_width()),
                                 height=max(frame.winfo_reqheight(), canvas.winfo_height()))
            canvas.configure(scrollregion=canvas.bbox("all"))
        frame.bind("<Configure>", resize)
        canvas.bind("<Configure>", resize)
        self.tab_canvases.append(canvas)
        return frame

    def scroll_tab(self, event):
        if event.widget.winfo_toplevel() is self and event.widget.winfo_class() not in ("Text", "Treeview", "TCombobox"):
            index = self.notebook.index(self.notebook.select())
            self.tab_canvases[index].yview_scroll(-int(event.delta / 120), "units")

    def heading(self, parent, title, note):
        ttk.Label(parent, text=title, style="Section.TLabel").pack(anchor="w")
        ttk.Label(parent, text=note, style="Muted.TLabel", wraplength=950).pack(anchor="w", pady=(6, 14))

    def _live(self):
        self.heading(self.live_tab, "输入监视器", "按动实体按键，观察 Windows 实际收到的信号。背键是否独立上报，需要实机测试确认。")
        row = ttk.Frame(self.live_tab)
        row.pack(fill="x")
        self.button_labels = {}
        for index, name in enumerate(list(BUTTONS) + ["LT", "RT"]):
            label = tk.Label(row, text=name, background=CARD, foreground=MUTED,
                             padx=5, pady=8, font=("Segoe UI", 10, "bold"))
            label.grid(row=index // 8, column=index % 8, padx=3, pady=3, sticky="ew")
            row.columnconfigure(index % 8, weight=1)
            self.button_labels[name] = label
        self.stick_canvas = tk.Canvas(self.live_tab, height=150, background=BG, highlightthickness=0)
        self.stick_canvas.pack(fill="x", pady=10)
        self.analog = ttk.Label(self.live_tab, text="LX 0   LY 0   RX 0   RY 0   LT 0   RT 0", style="Muted.TLabel")
        self.analog.pack(anchor="w")
        self.signal = ttk.Label(self.live_tab, text="原始按钮 0x0000  ·  数据包 0", style="Muted.TLabel")
        self.signal.pack(anchor="w", pady=(4, 10))
        testrow = ttk.Frame(self.live_tab)
        testrow.pack(fill="x", pady=(0, 10))
        ttk.Label(testrow, text="背键取证").pack(side="left", padx=(0, 8))
        self.rear_name = tk.StringVar(value="M1")
        ttk.Combobox(testrow, textvariable=self.rear_name, values=["LK", "RK", "M1", "M2", "LM", "RM"],
                     state="readonly", width=5).pack(side="left")
        self.capture_button = ttk.Button(testrow, text="记录 8 秒", command=self.start_capture)
        self.capture_button.pack(side="left", padx=8)
        ttk.Label(testrow, text="开始后仅按所选背键；结果保存到 reports", style="Muted.TLabel").pack(side="left")
        self.live_log = tk.Text(self.live_tab, height=3, background=PANEL, foreground=MUTED,
                                relief="flat", padx=12, pady=8, state="disabled", font=("Consolas", 10))
        self.live_log.pack(fill="both", expand=True)
        rumble = ttk.Frame(self.live_tab)
        rumble.pack(fill="x", pady=(12, 0))
        ttk.Label(rumble, text="震动测试").pack(side="left", padx=(0, 12))
        self.motor_left = tk.DoubleVar(value=25)
        self.motor_right = tk.DoubleVar(value=25)
        for text, variable in [("左", self.motor_left), ("右", self.motor_right)]:
            ttk.Label(rumble, text=text, style="Muted.TLabel").pack(side="left")
            ttk.Scale(rumble, variable=variable, from_=0, to=100, length=130).pack(side="left", padx=8)
        ttk.Button(rumble, text="测试 300 ms", command=self.rumble).pack(side="left", padx=10)
        ttk.Label(rumble, text="即时输出，不保存手柄强度", style="Muted.TLabel").pack(side="left")

    def tree(self, parent, columns, heights=8):
        area = ttk.Frame(parent)
        area.pack(fill="both", expand=True)
        tree = ttk.Treeview(area, columns=[key for key, _ in columns], show="headings", height=heights)
        for key, title in columns:
            tree.heading(key, text=title)
            tree.column(key, width=150 if key == "input" else 450, minwidth=90)
        scroll = ttk.Scrollbar(area, orient="vertical", command=tree.yview)
        tree.configure(yscrollcommand=scroll.set)
        tree.pack(side="left", fill="both", expand=True)
        scroll.pack(side="right", fill="y")
        return tree

    def _keys(self):
        self.heading(self.keys_tab, "把手柄输入映射成键鼠", "软件运行且启用时生效。原始手柄输入仍会传给游戏；尚未发现可独立选择的 O+ 背键。")
        self.key_tree = self.tree(self.keys_tab, [("input", "手柄输入"), ("output", "键盘 / 鼠标输出")])
        self.key_tree.bind("<<TreeviewSelect>>", self.select_key)
        form = ttk.Frame(self.keys_tab)
        form.pack(fill="x", pady=16)
        self.key_trigger, self.key_target = tk.StringVar(value="A"), tk.StringVar(value="Space")
        ttk.Label(form, text="输入").pack(side="left", padx=(0, 6))
        ttk.Combobox(form, textvariable=self.key_trigger, values=profiles.INPUTS, state="readonly", width=9).pack(side="left")
        ttk.Label(form, text="输出").pack(side="left", padx=(18, 6))
        targets = [key for key in available_keys() if key != "F8"]
        ttk.Combobox(form, textvariable=self.key_target, values=targets, state="readonly", width=14).pack(side="left")
        ttk.Button(form, text="添加 / 更新", command=self.add_key).pack(side="left", padx=10)
        ttk.Button(form, text="删除所选", command=self.delete_key).pack(side="left")
        mouse_row = ttk.Frame(self.keys_tab)
        mouse_row.pack(fill="x", pady=(0, 12))
        self.mouse_enabled = tk.BooleanVar(value=False)
        self.mouse_speed = tk.DoubleVar(value=12)
        ttk.Checkbutton(mouse_row, text="右摇杆控制鼠标", variable=self.mouse_enabled, command=self.mouse_changed).pack(side="left")
        ttk.Label(mouse_row, text="速度", style="Muted.TLabel").pack(side="left", padx=(20, 8))
        speed = ttk.Scale(mouse_row, variable=self.mouse_speed, from_=1, to=40, length=170)
        speed.pack(side="left")
        speed.bind("<ButtonRelease-1>", lambda _event: self.mouse_changed())
        ttk.Label(mouse_row, text="左摇杆可通过 LX± / LY± 映射 WASD", style="Muted.TLabel").pack(side="left", padx=16)
        self.profile_buttons(self.keys_tab)

    def _macros(self):
        self.heading(self.macros_tab, "电脑端按键序列", "按下触发键执行一次；松开不重复。F8、断开手柄或关闭映射会中断宏并释放按键。")
        self.macro_tree = self.tree(self.macros_tab, [("input", "触发输入"), ("output", "按键序列与时间")], 7)
        self.macro_tree.bind("<<TreeviewSelect>>", self.select_macro)
        form = ttk.Frame(self.macros_tab)
        form.pack(fill="x", pady=(14, 8))
        ttk.Label(form, text="触发输入").pack(side="left", padx=(0, 8))
        self.macro_trigger = tk.StringVar(value="Y")
        ttk.Combobox(form, textvariable=self.macro_trigger, values=profiles.INPUTS, state="readonly", width=10).pack(side="left")
        ttk.Button(form, text="添加 / 更新宏", command=self.add_macro).pack(side="left", padx=12)
        ttk.Button(form, text="删除所选", command=self.delete_macro).pack(side="left")
        ttk.Label(self.macros_tab, text="格式：按键:按住毫秒/间隔毫秒，逗号分隔。示例：Q:100/60, E:80/60, MouseLeft:80/0", style="Muted.TLabel").pack(anchor="w", pady=8)
        self.macro_text = tk.Text(self.macros_tab, height=3, background=CARD, foreground=TEXT,
                                 insertbackground=ACCENT, relief="flat", padx=10, pady=10,
                                 font=("Consolas", 11), undo=True)
        self.macro_text.insert("1.0", "Q:100/60, E:80/60")
        self.macro_text.pack(fill="x", pady=(0, 16))
        ttk.Label(self.macros_tab, text="这里的宏保存在电脑上。板载背键宏需要先验证手柄配置协议。", style="Muted.TLabel").pack(anchor="w")

    def _device(self):
        self.heading(self.device_tab, "设备能力与 KeyLinker 协议", "游戏输入与配置可能走不同通道。此版本读取硬件接口、扫描 BLE 并查询身份与能力，不写入板载配置。")
        controls = ttk.Frame(self.device_tab)
        controls.pack(fill="x", pady=(0, 12))
        self.diagnostic_button = ttk.Button(controls, text="刷新硬件诊断", command=self.diagnose)
        self.diagnostic_button.pack(side="left")
        self.scan_button = ttk.Button(controls, text="扫描附近蓝牙", command=self.scan_ble)
        self.scan_button.pack(side="left", padx=10)
        ttk.Button(controls, text="导出当前诊断", command=self.export_report).pack(side="left")
        self.ble_tree = self.tree(self.device_tab, [("input", "蓝牙设备"), ("output", "地址 / 配置服务")], 3)
        ble_controls = ttk.Frame(self.device_tab)
        ble_controls.pack(fill="x", pady=10)
        self.identify_button = ttk.Button(ble_controls, text="读取所选设备身份 / 能力", command=self.identify_ble)
        self.identify_button.pack(side="left")
        ttk.Label(ble_controls, text="先在手机退出 KeyLinker，保持手柄唤醒", style="Muted.TLabel").pack(side="left", padx=14)
        self.device_text = tk.Text(self.device_tab, height=11, background=PANEL, foreground=MUTED,
                                   relief="flat", padx=14, pady=12, wrap="word", state="disabled")
        self.device_text.pack(fill="both", expand=True)
        ttk.Label(self.device_tab, text="板载背键映射 / 宏 / 灯光 / 死区：等待 O+ 协议实测。接收器与 USB 直连需分别检查。", style="Muted.TLabel", wraplength=950).pack(anchor="w", pady=(12, 0))

    def profile_buttons(self, parent):
        row = ttk.Frame(parent)
        row.pack(fill="x")
        ttk.Button(row, text="保存本地配置", command=self.save_profile).pack(side="left")
        ttk.Button(row, text="导出 JSON", command=self.export_profile).pack(side="left", padx=10)
        ttk.Button(row, text="导入 JSON", command=self.import_profile).pack(side="left")

    def stop(self, reason="已停止键鼠 / 宏"):
        self.engine.stop()
        self.enable_button.configure(text="启用键鼠 / 宏")
        self.footer.configure(text=reason)

    def configure_engine(self):
        self.engine.configure(self.profile["mappings"], self.profile["macros"],
                              mouse_enabled=self.profile["mouse_enabled"],
                              mouse_speed=self.profile["mouse_speed"],
                              mouse_deadzone=self.profile["mouse_deadzone"])

    def toggle(self):
        if self.engine.enabled:
            self.stop()
            return
        if self.busy and self.background_critical:
            self.footer.configure(text="请等待背键保存或识别恢复完成，再启用电脑端映射。")
            return
        if self.capture:
            self.footer.configure(text="背键记录期间请保持映射关闭。")
            return
        if self.xinput.read(int(self.slot.get())) is None:
            messagebox.showinfo("手柄未连接", "当前槽位没有在线手柄。请唤醒手柄或更换槽位。", parent=self)
            return
        if not (self.profile["mappings"] or self.profile["macros"] or self.profile["mouse_enabled"]):
            self.notebook.select(self.keys_tab)
            self.footer.configure(text="先添加映射、宏或打开右摇杆鼠标。")
            return
        self.configure_engine()
        self.engine.enabled = True
        self.enable_button.configure(text="停止键鼠 / 宏  (F8)")
        self.footer.configure(text="键鼠 / 宏已启用，先松开全部按键并回正摇杆；按 F8 停止。")

    def slot_changed(self):
        self.stop("已切换槽位，映射已停止")
        self.stop_rumble()
        self.last_signal = None
        if self.capture:
            self.finish_capture("切换槽位，提前结束")

    def refresh_profile(self):
        self.stop("配置已载入；键鼠 / 宏保持关闭")
        for tree, values in [(self.key_tree, self.profile["mappings"]), (self.macro_tree, self.profile["macros"])]:
            tree.delete(*tree.get_children())
            for key, value in values.items():
                tree.insert("", "end", iid=key, values=(key, value if isinstance(value, str) else profiles.macro_to_text(value)))
        self.mouse_enabled.set(self.profile["mouse_enabled"])
        self.mouse_speed.set(self.profile["mouse_speed"])
        self.configure_engine()

    def changed(self):
        self.refresh_profile()
        self.save_profile()

    def add_key(self):
        trigger = self.key_trigger.get()
        self.profile["mappings"][trigger] = self.key_target.get()
        self.profile["macros"].pop(trigger, None)
        self.changed()

    def select_key(self, _event=None):
        selected = self.key_tree.selection()
        if selected:
            self.key_trigger.set(selected[0])
            self.key_target.set(self.profile["mappings"][selected[0]])

    def delete_key(self):
        for trigger in self.key_tree.selection():
            self.profile["mappings"].pop(trigger, None)
        self.changed()

    def mouse_changed(self):
        self.profile["mouse_enabled"] = self.mouse_enabled.get()
        self.profile["mouse_speed"] = round(self.mouse_speed.get(), 1)
        self.changed()

    def add_macro(self):
        try:
            steps = profiles.macro_from_text(self.macro_text.get("1.0", "end").strip())
        except ValueError as exc:
            messagebox.showerror("宏格式错误", str(exc), parent=self)
            return
        trigger = self.macro_trigger.get()
        self.profile["macros"][trigger] = steps
        self.profile["mappings"].pop(trigger, None)
        self.changed()

    def select_macro(self, _event=None):
        selected = self.macro_tree.selection()
        if selected:
            self.macro_trigger.set(selected[0])
            self.macro_text.delete("1.0", "end")
            self.macro_text.insert("1.0", profiles.macro_to_text(self.profile["macros"][selected[0]]))

    def delete_macro(self):
        for trigger in self.macro_tree.selection():
            self.profile["macros"].pop(trigger, None)
        self.changed()

    def save_profile(self):
        try:
            profiles.save(profiles.profile_path(), self.profile)
            self.footer.configure(text=f"配置已保存：{profiles.profile_path()}；映射保持关闭")
        except (OSError, ValueError) as exc:
            messagebox.showerror("保存失败", str(exc), parent=self)

    def export_profile(self):
        path = filedialog.asksaveasfilename(parent=self, defaultextension=".json", initialfile="OPlus-profile.json", filetypes=[("JSON", "*.json")])
        if path:
            try:
                profiles.save(Path(path), self.profile)
            except (OSError, ValueError) as exc:
                messagebox.showerror("导出失败", str(exc), parent=self)

    def import_profile(self):
        path = filedialog.askopenfilename(parent=self, filetypes=[("JSON", "*.json")])
        if path:
            try:
                imported = profiles.load(Path(path))
                self.profile = imported
                self.changed()
            except (OSError, ValueError, TypeError) as exc:
                messagebox.showerror("导入失败", str(exc), parent=self)

    def log(self, text):
        self.log_lines.append(f"{datetime.now():%H:%M:%S}  {text}")
        self.live_log.configure(state="normal")
        self.live_log.delete("1.0", "end")
        self.live_log.insert("end", "\n".join(self.log_lines))
        self.live_log.see("end")
        self.live_log.configure(state="disabled")

    def draw_sticks(self, state):
        canvas = self.stick_canvas
        canvas.delete("all")
        width = max(canvas.winfo_width(), 700)
        for center_x, label, x, y in [(width * .27, "左摇杆", state.lx if state else 0, state.ly if state else 0),
                                      (width * .73, "右摇杆", state.rx if state else 0, state.ry if state else 0)]:
            cy, radius = 64, 45
            canvas.create_oval(center_x-radius, cy-radius, center_x+radius, cy+radius, fill=PANEL, outline="#3b4c60", width=2)
            canvas.create_line(center_x-radius, cy, center_x+radius, cy, fill=CARD)
            canvas.create_line(center_x, cy-radius, center_x, cy+radius, fill=CARD)
            px, py = center_x+x/32768*radius, cy-y/32768*radius
            canvas.create_oval(px-7, py-7, px+7, py+7, fill=ACCENT if state else MUTED, outline="")
            canvas.create_text(center_x, 134, text=f"{label}    {x:6d} / {y:6d}", fill=MUTED, font=("Microsoft YaHei UI", 10))

    def start_capture(self):
        if self.capture:
            return
        state = self.xinput.read(int(self.slot.get()))
        if state is None:
            messagebox.showinfo("手柄未连接", "当前槽位没有在线手柄。", parent=self)
            return
        self.stop("正在记录背键，键鼠 / 宏已停止")
        self.capture = {"label": self.rear_name.get(), "slot": int(self.slot.get()),
                        "started": datetime.now().isoformat(), "start_monotonic": time.monotonic(),
                        "baseline": asdict(state), "events": []}
        self.capture_button.configure(state="disabled")
        self.log(f"开始记录 {self.capture['label']}。请松开其他按键，只按这个背键。")

    def finish_capture(self, reason="记录完成"):
        capture, self.capture = self.capture, None
        if not capture:
            return
        capture.pop("start_monotonic", None)
        capture["note"] = "仅为 XInput 原始记录，不能据此证明背键独立。需要与正面按键对照，或查看额外接口。"
        capture["completion"] = reason
        try:
            path = write_report("rear-"+capture["label"], capture)
            self.log(f"{reason}：{capture['label']}，{len(capture['events'])} 条变化；{path.name}")
            self.footer.configure(text=f"背键记录已保存：{path}")
        except OSError as exc:
            self.log(f"记录保存失败：{exc}")
        self.capture_button.configure(state="normal")

    def rumble(self):
        index = int(self.slot.get())
        if self.xinput.read(index) is None:
            self.footer.configure(text="当前槽位手柄未连接，未发送震动。")
            return
        try:
            self.stop_rumble()
            self.xinput.vibrate(index, self.motor_left.get()/100, self.motor_right.get()/100)
            self.rumble_slot = index
            self.rumble_deadline = time.monotonic()+.3
            self.footer.configure(text="正在测试震动，300 ms 后停止")
        except (OSError, RuntimeError, ValueError) as exc:
            self.footer.configure(text=f"震动测试失败：{exc}")

    def stop_rumble(self):
        if self.rumble_slot is not None:
            try:
                self.xinput.vibrate(self.rumble_slot, 0, 0)
            except (OSError, RuntimeError):
                pass
        self.rumble_slot, self.rumble_deadline = None, 0

    def background(self, function, callback, status, *, on_error=None, critical=False):
        if self.busy:
            self.footer.configure(text="请等待当前诊断 / 蓝牙操作完成。")
            return
        self.busy = True
        self.background_critical = critical
        self.board_panel._update_write_buttons()
        self.footer.configure(text=status)
        for button in (self.diagnostic_button, self.scan_button, self.identify_button):
            button.configure(state="disabled")
        def run():
            try:
                result = function()
                self.events.put((callback, result, None, on_error))
            except Exception as exc:
                self.events.put((callback, None, f"{type(exc).__name__}: {exc}", on_error))
        threading.Thread(target=run, daemon=True).start()

    def diagnose(self):
        self.background(collect_report, self.diagnosed, "正在只读检查 PnP 与 HID 接口…")

    def diagnosed(self, report):
        self.report = report
        text = "\n".join(report.get("conclusions", []))
        text += "\n\n" + json.dumps(report, ensure_ascii=False, indent=2)
        self.show_device(text)
        try:
            path = write_report("hardware", report)
            self.footer.configure(text=f"硬件诊断已保存：{path}")
        except OSError as exc:
            self.footer.configure(text=f"硬件诊断完成；自动保存失败：{exc}")

    def scan_ble(self):
        self.background(lambda: asyncio.run(ble.scan()), self.scanned, "正在扫描 KeyLinker 候选设备（约 8 秒）…")

    def scanned(self, devices):
        self.ble_devices = devices
        self.ble_tree.delete(*self.ble_tree.get_children())
        for index, device in enumerate(devices):
            service = "已广播配置服务" if device["confirmed_service"] else "候选，待确认服务" if device["likely"] else "未知协议，仅检查服务"
            self.ble_tree.insert("", "end", iid=str(index), values=(device["name"], f"{device['address']}  /  {service}"))
        self.footer.configure(text=f"发现 {len(devices)} 个附近设备；O+ 广播名待确认，请选中手柄后读取身份。" if devices else "未发现蓝牙广播。检查电脑蓝牙、手柄电源和手机 KeyLinker 是否已断开。")

    def identify_ble(self):
        selection = self.ble_tree.selection()
        if not selection:
            self.footer.configure(text="请先扫描并选中一个蓝牙设备。")
            return
        device = self.ble_devices[int(selection[0])]
        self.background(lambda: asyncio.run(ble.identify(device["address"])), self.identified, "正在连接配置服务并查询身份 / 能力…")

    def identified(self, report):
        self.board_panel.accept_identity(report)
        self.report = report
        self.show_device("已读取配置服务。尚未验证 O+ 板载设置写入。\n\n" + json.dumps(report, ensure_ascii=False, indent=2))
        try:
            path = write_report("keylinker-identity", report)
            self.footer.configure(text=f"身份 / 能力报告已保存：{path}")
        except OSError as exc:
            self.footer.configure(text=f"身份读取完成；保存失败：{exc}")

    def show_device(self, text):
        self.device_text.configure(state="normal")
        self.device_text.delete("1.0", "end")
        self.device_text.insert("end", text)
        self.device_text.configure(state="disabled")

    def export_report(self):
        if self.report is None:
            self.footer.configure(text="尚无诊断结果，请先刷新硬件诊断。")
            return
        path = filedialog.asksaveasfilename(parent=self, defaultextension=".json", initialfile="OPlus-diagnostic.json", filetypes=[("JSON", "*.json")])
        if path:
            try:
                Path(path).write_text(json.dumps(self.report, ensure_ascii=False, indent=2), encoding="utf-8")
                self.footer.configure(text=f"诊断已导出：{path}")
            except OSError as exc:
                messagebox.showerror("导出失败", str(exc), parent=self)

    def poll(self):
        if self.closed:
            return
        try:
            now = time.monotonic()
            state = self.xinput.read(int(self.slot.get()))
            if self.output.panic_pressed():
                self.stop("F8 已停止全部键鼠 / 宏输出")
                self.stop_rumble()
            was_enabled = self.engine.enabled
            if state is None and was_enabled:
                self.stop("手柄断开，键鼠 / 宏已停止。重连后请手动启用。")
            self.engine.tick(state, now)
            if was_enabled and not self.engine.enabled:
                self.stop(f"输出已停止：{self.engine.last_error or '手柄断开'}")
            active = state.active_inputs() if state else set()
            for name, label in self.button_labels.items():
                label.configure(background="#285c85" if name in active else CARD,
                                foreground=TEXT if name in active else MUTED)
            self.connection.configure(text=f"● 槽位 {self.slot.get()} 已连接  ·  XInput 兼容手柄" if state else f"○ 槽位 {self.slot.get()} 未连接  ·  请唤醒手柄或更换槽位", foreground=GREEN if state else MUTED)
            self.draw_sticks(state)
            if state:
                self.analog.configure(text=f"LX {state.lx:6d}   LY {state.ly:6d}   RX {state.rx:6d}   RY {state.ry:6d}   LT {state.left_trigger:3d}   RT {state.right_trigger:3d}")
                self.signal.configure(text=f"原始按钮 0x{state.buttons:04X}  ·  数据包 {state.packet}")
                signature = (state.buttons, state.left_trigger >= 40, state.right_trigger >= 40)
                if signature != self.last_signal:
                    self.log(f"按钮 0x{state.buttons:04X}  {', '.join(sorted(active & (set(BUTTONS) | {'LT', 'RT'}))) or '释放'}")
                    if self.capture:
                        self.capture["events"].append({"time_ms": round((now-self.capture["start_monotonic"])*1000), **asdict(state)})
                    self.last_signal = signature
            else:
                self.analog.configure(text="LX —   LY —   RX —   RY —   LT —   RT —")
                self.signal.configure(text="原始按钮 —  ·  数据包 —")
                self.last_signal = None
                if self.capture:
                    self.finish_capture("手柄断开，提前结束")
            if self.capture:
                remaining = 8-(now-self.capture["start_monotonic"])
                if remaining <= 0:
                    self.finish_capture()
                else:
                    self.footer.configure(text=f"正在记录 {self.capture['label']}，剩余 {remaining:.1f} 秒。只按这个背键。")
            if self.rumble_deadline and now >= self.rumble_deadline:
                self.stop_rumble()
            while True:
                try:
                    callback, result, error, on_error = self.events.get_nowait()
                except queue.Empty:
                    break
                self.busy = False
                self.background_critical = False
                for button in (self.diagnostic_button, self.scan_button, self.identify_button):
                    button.configure(state="normal")
                if error:
                    self.footer.configure(text=error)
                    self.show_device(error)
                    if on_error:
                        on_error(error)
                else:
                    callback(result)
                self.board_panel._update_write_buttons()
        except Exception as exc:
            self.stop(f"已停止输出：{type(exc).__name__}: {exc}")
        if self.pending_close and not self.busy:
            self.close()
            return
        self.after(16, self.poll)

    def close(self):
        self.board_panel.rear_editor.cancel_identification()
        if self.busy and self.background_critical:
            self.pending_close = True
            self.stop("正在完成板载写入或恢复，完成后自动关闭。")
            return
        self.closed = True
        self.stop()
        self.stop_rumble()
        if self.capture:
            self.finish_capture("关闭程序，提前结束")
        self.destroy()


def main():
    if sys.platform != "win32":
        raise SystemExit("O+ Studio 的硬件功能需要 Windows 10 / 11。")
    Studio().mainloop()
