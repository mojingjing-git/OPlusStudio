"""Qt desktop workspace. Hardware transactions remain in the tested backend."""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
import threading

from PySide6.QtCore import Qt, QThread, Signal, QTimer, QSettings, QSize
from PySide6.QtGui import QColor, QFont, QFontDatabase, QKeySequence, QShortcut, QPainter, QPen
from PySide6.QtWidgets import (QApplication, QMainWindow, QWidget, QFrame, QLabel,
    QPushButton, QVBoxLayout, QHBoxLayout, QGridLayout, QStackedWidget, QScrollArea,
    QButtonGroup, QComboBox, QSpinBox, QTableWidget, QHeaderView, QFileDialog,
    QMessageBox, QLineEdit, QDialog, QDialogButtonBox, QProgressBar, QSlider)

from . import __version__, board, rear
from .workspace import RearWorkspace
from .windows_input import XInput
from .vendor import keylinker as codec


def friendly_output(snapshot, slot, change=None):
    data = rear.encode_change(snapshot,change) if change else bytes.fromhex(rear.payload_hex(snapshot,slot))
    if data == b'\x00':return '未配置'
    program=codec.parse_macro_payload(data)
    spec=rear.layout(snapshot)
    names={'DPAD_UP':'上','DPAD_DOWN':'下','DPAD_LEFT':'左','DPAD_RIGHT':'右'}
    def keys(step):return ' + '.join(names.get(k,k) for k in codec.describe_mask(step.mask,spec)) or '松开'
    if len(program.steps)==1 and not program.steps[0].duration_ms and not program.loop_interval_ms:
        return '按住 '+keys(program.steps[0])
    steps=' → '.join(f'{keys(s)} {s.duration_ms} ms' for s in program.steps)
    return '定时宏：'+steps+(' · 循环' if program.loop_interval_ms else '')


def label(text, role='', wrap=False):
    item = QLabel(text)
    item.setProperty('role', role)
    item.setWordWrap(wrap)
    return item


def button(text, action, role=''):
    item = QPushButton(text)
    item.setProperty('role', role)
    item.setCursor(Qt.CursorShape.PointingHandCursor)
    item.clicked.connect(action)
    return item


def column(parent=None, margin=0, spacing=12):
    layout = QVBoxLayout(parent)
    layout.setContentsMargins(margin, margin, margin, margin)
    layout.setSpacing(spacing)
    return layout


def panel():
    widget = QFrame()
    widget.setProperty('role', 'panel')
    return widget


class Worker(QThread):
    result = Signal(object)
    error = Signal(str)
    progress = Signal(str)

    def __init__(self, work):
        super().__init__()
        self.work = work

    def run(self):
        try:
            self.result.emit(self.work())
        except Exception as exc:
            self.error.emit(str(exc))


class CalibrationDialog(QDialog):
    def __init__(self, cancel, parent):
        super().__init__(parent)
        self.cancel = cancel

    def reject(self):
        self.cancel.set()

    def closeEvent(self, event):
        self.cancel.set()
        event.ignore()


class StickView(QWidget):
    def __init__(self):
        super().__init__()
        self.values = (0, 0, 0, 0)
        self.setMinimumHeight(180)

    def paintEvent(self, event):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        r = min(66, self.height()/2-22, self.width()/6)
        for i, title in enumerate(('左摇杆', '右摇杆')):
            cx, cy = self.width()*(.28 if i == 0 else .72), self.height()/2-10
            p.setPen(QPen(QColor('#8190a8'), 1))
            p.setBrush(QColor('#e7edf8'))
            p.drawEllipse(int(cx-r), int(cy-r), int(r*2), int(r*2))
            p.drawLine(int(cx-r), int(cy), int(cx+r), int(cy))
            p.drawLine(int(cx), int(cy-r), int(cx), int(cy+r))
            x,y = self.values[i*2:i*2+2]
            p.setBrush(QColor('#315cd5'))
            p.setPen(Qt.PenStyle.NoPen)
            p.drawEllipse(int(cx+x*r/32768-6), int(cy-y*r/32768-6), 12, 12)
            p.setPen(QColor('#627086'))
            p.drawText(int(cx-r), int(cy+r+7), int(r*2), 22, Qt.AlignmentFlag.AlignCenter, title)


class Studio(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle(f'O+ Studio {__version__}')
        self.settings = QSettings('OPlusStudio', 'Desktop')
        self.model = RearWorkspace()
        self.selected, self.loading, self.busy = 0, False, False
        self.undo_changes, self.undo_expected = {}, {}
        self.job = None
        self.cancel = None
        self.closing = False
        self.valid_read = False
        self.pad = XInput()
        self.resize(1280, 840)
        self.setMinimumSize(920, 620)
        self._build()
        self.set_theme(self.settings.value('theme', 'light'))
        self.timer = QTimer(self)
        self.timer.timeout.connect(self.poll)
        self.timer.start(50)
        QShortcut(QKeySequence.StandardKey.Save, self, activated=self.save)
        QShortcut(QKeySequence('Ctrl+R'), self, activated=self.connect_device)
        self.sync()

    def _build(self):
        root = QWidget()
        self.setCentralWidget(root)
        shell = QHBoxLayout(root)
        shell.setContentsMargins(0,0,0,0)
        shell.setSpacing(0)
        sidebar = QFrame()
        sidebar.setObjectName('Sidebar')
        sidebar.setFixedWidth(174)
        side = column(sidebar, 20, 8)
        side.addWidget(label('O+ Studio', 'brand'))
        side.addWidget(label('致动手柄工作台', 'sideMuted'))
        side.addSpacing(30)
        self.nav = QButtonGroup(self)
        self.nav.setExclusive(True)
        for i, text in enumerate(('背键设置', '手柄设置', '实时测试', '工具与帮助')):
            b = button(text, lambda checked=False, i=i:self.navigate(i), 'nav')
            b.setCheckable(True)
            b.setAccessibleName(text)
            self.nav.addButton(b,i)
            side.addWidget(b)
        self.nav.button(0).setChecked(True)
        side.addStretch()
        side.addWidget(label('设置保存在手柄', 'sideMuted'))
        side.addWidget(label('关闭软件后仍可使用', 'sideMuted'))
        side.addSpacing(16)
        side.addWidget(button('切换明暗主题', self.toggle_theme, 'nav'))
        side.addWidget(label(f'版本 {__version__}', 'sideMuted'))
        shell.addWidget(sidebar)
        content = QWidget()
        body = column(content, 24, 16)
        head = QHBoxLayout()
        titles = column(spacing=3)
        self.page_title = label('背键设置', 'title')
        self.page_note = label('选择一个背键，设置它要输出的手柄按键。', 'muted', True)
        titles.addWidget(self.page_title)
        titles.addWidget(self.page_note)
        head.addLayout(titles, 1)
        self.connect_button = button('连接并读取', self.connect_device, 'primary')
        self.connect_button.setToolTip('连接蓝牙配置通道并读取当前设置 · Ctrl+R')
        head.addWidget(self.connect_button)
        body.addLayout(head)
        device = panel()
        dev = QHBoxLayout(device)
        dev.setContentsMargins(16,12,16,12)
        dev.addWidget(label('致动 O+', 'device'))
        self.device_info = label('请将手柄开机，退出手机 KeyLinker。', 'muted', True)
        dev.addWidget(self.device_info, 1)
        self.game_status = label('游戏输入：检测中', 'badge')
        self.config_status = label('配置：未读取', 'badge')
        dev.addWidget(self.game_status)
        dev.addWidget(self.config_status)
        body.addWidget(device)
        self.message = label('USB / 接收器用于游戏输入；点击“连接并读取”连接蓝牙配置通道。', 'notice', True)
        body.addWidget(self.message)
        self.progress = QProgressBar()
        self.progress.setRange(0,0)
        self.progress.setFixedHeight(3)
        self.progress.setTextVisible(False)
        self.progress.hide()
        body.addWidget(self.progress)
        self.pages = QStackedWidget()
        self._rear_page()
        self._settings_page()
        self._live_page()
        self._tools_page()
        body.addWidget(self.pages,1)
        footer = QHBoxLayout()
        self.save_state = label('连接后开始编辑', 'muted', True)
        footer.addWidget(self.save_state,1)
        self.discard_button = button('放弃改动', self.discard)
        self.undo_button = button('撤销上次保存', self.undo)
        self.save_button = button('保存到手柄', self.save, 'primary')
        self.save_button.setToolTip('写入后自动读回核对 · Ctrl+S')
        for b in (self.discard_button,self.undo_button,self.save_button):footer.addWidget(b)
        body.addLayout(footer)
        shell.addWidget(content,1)

    def scroll_page(self):
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.Shape.NoFrame)
        widget = QWidget()
        scroll.setWidget(widget)
        self.pages.addWidget(scroll)
        return widget

    def _rear_page(self):
        page = self.scroll_page()
        self.rear_layout = QBox = QHBoxLayout(page)
        QBox.setContentsMargins(0,0,0,0)
        QBox.setSpacing(18)
        overview = QWidget()
        ov = column(overview)
        row = QHBoxLayout()
        row.addWidget(label('六个背键', 'section'),1)
        self.label_tools = button('名称与校正', self.edit_labels)
        row.addWidget(self.label_tools)
        ov.addLayout(row)
        self.source = label('读取后自动匹配已验证的型号。', 'muted', True)
        ov.addWidget(self.source)
        self.cards = []
        self.cards_grid = QGridLayout()
        self.cards_grid.setSpacing(12)
        for slot in range(6):
            card = button(f'{rear.PHYSICAL_NAMES[slot]}\n尚未读取', lambda checked=False,s=slot:self.select_slot(s), 'slot')
            card.setCheckable(True)
            card.setMinimumHeight(116)
            card.setSizePolicy(card.sizePolicy().Policy.Expanding, card.sizePolicy().Policy.Expanding)
            self.cards_grid.addWidget(card,slot//2,slot%2)
            self.cards.append(card)
        ov.addLayout(self.cards_grid)
        ov.addStretch()
        ov.addWidget(label('改动会暂存在当前窗口，点击底部“保存到手柄”才会生效。', 'muted', True))
        self.inspector = panel()
        edit = column(self.inspector,20,12)
        self.edit_title = label('M1 的输出', 'section')
        edit.addWidget(self.edit_title)
        self.current = label('先连接并读取手柄。', 'muted', True)
        edit.addWidget(self.current)
        modes = QHBoxLayout()
        self.mode = QButtonGroup(self)
        for i,text in enumerate(('按住映射','定时宏')):
            b = button(text, lambda checked=False,i=i:self.mode_changed(i), 'mode')
            b.setCheckable(True)
            self.mode.addButton(b,i)
            modes.addWidget(b)
        edit.addLayout(modes)
        self.editor_stack = QStackedWidget()
        hold = QWidget()
        hg = QGridLayout(hold)
        hg.setContentsMargins(0,0,0,0)
        self.keys = {}
        key_names = [(1,'A'),(2,'B'),(3,'X'),(4,'Y'),(5,'LB'),(6,'RB'),(7,'LT'),(8,'RT'),(11,'LS'),(12,'RS'),(93,'Back'),(94,'Start'),(14,'↑ 上'),(13,'↓ 下'),(16,'← 左'),(15,'→ 右')]
        for i,(code,name) in enumerate(key_names):
            b = button(name, self.edited, 'key')
            b.setCheckable(True)
            b.setAccessibleName(f'输出 {name}')
            hg.addWidget(b,i//4,i%4)
            self.keys[code] = b
        hg.addWidget(label('可同时选择多个按键。按住背键时保持输出，松开后释放。','muted',True),4,0,1,4)
        self.editor_stack.addWidget(hold)
        macro = QWidget()
        ml = column(macro)
        self.steps = QTableWidget(0,3)
        self.steps.setHorizontalHeaderLabels(('输出按键','按住 ms','间隔 ms'))
        self.steps.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        self.steps.verticalHeader().setVisible(True)
        self.steps.verticalHeader().setFixedWidth(28)
        self.steps.setMinimumHeight(120)
        self.steps.setMaximumHeight(160)
        self.steps.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        ml.addWidget(self.steps)
        mr = QHBoxLayout()
        mr.addWidget(button('添加步骤', self.add_step))
        mr.addWidget(button('删除步骤', self.delete_step))
        mr.addWidget(button('上移', lambda:self.move_step(-1)))
        mr.addWidget(button('下移', lambda:self.move_step(1)))
        ml.addLayout(mr)
        looprow = QHBoxLayout()
        looprow.addWidget(label('循环间隔 ms'))
        self.loop = QSpinBox()
        self.loop.setRange(0,20000)
        self.loop.setSingleStep(5)
        self.loop.setButtonSymbols(QSpinBox.ButtonSymbols.PlusMinus)
        self.loop.valueChanged.connect(self.edited)
        looprow.addWidget(self.loop)
        looprow.addWidget(label('0 为执行一次','muted'))
        ml.addLayout(looprow)
        ml.addWidget(label('每行按顺序执行。输出可写 A+B 等组合键，时间以 5 ms 为单位。','muted',True))
        self.editor_stack.addWidget(macro)
        edit.addWidget(self.editor_stack)
        self.preview = label('选择输出按键', 'preview', True)
        edit.addWidget(self.preview)
        self.field_error = label('', 'error', True)
        edit.addWidget(self.field_error)
        edit.addStretch()
        QBox.addWidget(overview,1)
        QBox.addWidget(self.inspector,1)
        self.overview = overview

    def _settings_page(self):
        page = self.scroll_page()
        layout = column(page)
        self.settings_content = QWidget()
        layout.addWidget(self.settings_content)
        form = column(self.settings_content)
        motors = panel()
        self.motor_panel = motors
        mv = column(motors,20)
        mv.addWidget(label('震动强度','section'))
        self.motors = []
        for i in range(4):
            row = QHBoxLayout()
            row.addWidget(label(f'马达 {i+1}'))
            slider = QSlider(Qt.Orientation.Horizontal)
            slider.setRange(0,100)
            number = label('0%')
            slider.valueChanged.connect(lambda v,l=number:l.setText(f'{v}%'))
            row.addWidget(slider,1)
            row.addWidget(number)
            mv.addLayout(row)
            self.motors.append(slider)
        mv.addWidget(button('保存震动强度', lambda:self.apply_setting('motors',{'levels':[s.value() for s in self.motors]})))
        form.addWidget(motors)
        remap = panel()
        self.remap_panel = remap
        rl = column(remap,20)
        rl.addWidget(label('标准按键映射','section'))
        r = QHBoxLayout()
        self.remap_from,self.remap_to = QComboBox(),QComboBox()
        r.addWidget(self.remap_from,1)
        r.addWidget(label('输出为'))
        r.addWidget(self.remap_to,1)
        rl.addLayout(r)
        self.remap_from.currentIndexChanged.connect(self.load_remap_target)
        rl.addWidget(button('保存标准键映射',lambda:self.apply_setting('remapping',{'source':self.remap_from.currentData(),'target':self.remap_to.currentData()})))
        form.addWidget(remap)
        lights = panel()
        self.light_panel = lights
        ll = column(lights,20)
        ll.addWidget(label('灯光颜色','section'))
        self.light_inputs = {}
        for zone in (0,1,3):
            row = QHBoxLayout()
            row.addWidget(label(f'灯区 {zone+1}'))
            rgb = QLineEdit('#ffffff')
            rgb.setMaxLength(7)
            rgb.setAccessibleName(f'灯区 {zone+1} 颜色')
            row.addWidget(rgb,1)
            row.addWidget(button('选颜色',lambda checked=False,z=zone:self.pick_color(z)))
            row.addWidget(button('保存颜色',lambda checked=False,z=zone:self.apply_setting('lighting',{'zone':z,'rgb':self.light_inputs[z].text()})))
            ll.addLayout(row)
            self.light_inputs[zone] = rgb
        ll.addWidget(label('颜色记录写入后会读回核对；不同灯效模式下，显示效果可能不同。','muted',True))
        form.addWidget(lights)
        layout.addStretch()

    def _live_page(self):
        page = self.scroll_page()
        layout = column(page)
        box = panel()
        v = column(box,24)
        row = QHBoxLayout()
        row.addWidget(label('手柄输入','section'),1)
        self.input_slot = QComboBox()
        for i in range(4):self.input_slot.addItem(f'手柄 {i+1}',i)
        row.addWidget(self.input_slot)
        v.addLayout(row)
        self.sticks = StickView()
        v.addWidget(self.sticks)
        self.live_keys = label('等待手柄输入…','preview',True)
        v.addWidget(self.live_keys)
        self.triggers = label('LT  0%       RT  0%','muted')
        v.addWidget(self.triggers)
        v.addWidget(label('此处显示游戏收到的输出。背键映射为 A 时，按背键也会显示 A。','muted',True))
        layout.addWidget(box)
        layout.addStretch()

    def _tools_page(self):
        page = self.scroll_page()
        layout = column(page)
        for title, note, actions in (
            ('配置文件','导出当前手柄配置；导入后先预览改动，再保存。', [('导出背键配置',self.export_profile),('导入背键配置',self.import_profile)]),
            ('连接与恢复','手机 KeyLinker 需要退出。电脑蓝牙必须开启，游戏连接可继续使用 USB 或接收器。',[('打开自动备份',lambda:self.open_folder(board.data_dir()/'backups'))]),
            ('高级工具','诊断、只读曲线参数和第一阶段之外的电脑端映射仍可在经典工具中使用。',[('打开经典工具',self.open_classic)])):
            box = panel()
            v = column(box,20)
            v.addWidget(label(title,'section'))
            v.addWidget(label(note,'muted',True))
            row = QHBoxLayout()
            for name,fn in actions:row.addWidget(button(name,fn))
            row.addStretch()
            v.addLayout(row)
            layout.addWidget(box)
        box = panel()
        v = column(box,20)
        v.addWidget(label('手动指定配置地址','section'))
        self.address = QLineEdit(board.saved_address())
        self.address.setPlaceholderText('留空时自动发现 O+')
        self.address.setAccessibleName('蓝牙配置地址')
        v.addWidget(self.address)
        v.addWidget(label('通常无需填写。这里只影响配置连接，不改变游戏连接方式。','muted',True))
        layout.addWidget(box)
        layout.addStretch()

    def navigate(self,index):
        self.pages.setCurrentIndex(index)
        self.nav.button(index).setChecked(True)
        self.page_title.setText(('背键设置','手柄设置','实时测试','工具与帮助')[index])
        self.page_note.setText(('选择一个背键，设置它要输出的手柄按键。','震动、标准改键与灯光分别保存。','查看游戏收到的按键、摇杆和扳机输入。','导入导出、自动备份与高级工具。')[index])

    def resizeEvent(self,event):
        super().resizeEvent(event)
        if hasattr(self,'rear_layout'):
            from PySide6.QtWidgets import QBoxLayout
            narrow = self.width() < 1160
            self.rear_layout.setDirection(QBoxLayout.Direction.TopToBottom if narrow else QBoxLayout.Direction.LeftToRight)

    def set_theme(self, theme):
        self.theme = theme
        dark = theme == 'dark'
        bg, surface, text, muted, border, hover = (('#171d27','#222b38','#edf1f8','#b3bfd2','#3a475c','#303e54') if dark else ('#eef1f5','#ffffff','#202938','#59677d','#d8dfe9','#edf2fc'))
        self.setStyleSheet(f'''
            QWidget {{ color:{text}; font-size:14px; }}
            QMainWindow, QScrollArea, QStackedWidget {{ background:{bg}; }}
            QScrollArea > QWidget > QWidget {{ background:{bg}; }}
            QLabel {{ background:transparent; }}
            #Sidebar {{ background:#202b3b; }}
            QLabel[role="brand"] {{ color:white; font-size:23px; font-weight:700; }}
            QLabel[role="sideMuted"] {{ color:#bfcbdf; font-size:12px; }}
            QLabel[role="title"] {{ font-size:27px; font-weight:700; }}
            QLabel[role="section"], QLabel[role="device"] {{ font-size:18px; font-weight:600; }}
            QLabel[role="muted"] {{ color:{muted}; font-size:13px; }}
            QLabel[role="badge"] {{ color:{muted}; border:1px solid {border}; border-radius:7px; padding:6px 9px; font-size:12px; }}
            QLabel[role="notice"] {{ color:{muted}; padding:2px 0; }}
            QLabel[role="preview"] {{ background:{hover}; border-radius:8px; padding:14px; font-size:16px; }}
            QLabel[role="error"] {{ color:{'#ffa8ab' if dark else '#aa2532'}; }}
            QFrame[role="panel"] {{ background:{surface}; border:1px solid {border}; border-radius:12px; }}
            QPushButton {{ background:{surface}; border:1px solid {border}; border-radius:7px; padding:9px 13px; min-height:20px; }}
            QPushButton:hover {{ background:{hover}; border-color:#7897e2; }}
            QPushButton:focus {{ border:2px solid #5278dc; }}
            QPushButton:disabled {{ color:{muted}; background:{bg}; border-color:{border}; }}
            QPushButton[role="primary"] {{ background:#315cd5; border-color:#315cd5; color:white; font-weight:600; }}
            QPushButton[role="primary"]:hover {{ background:#244bb9; }}
            QPushButton[role="primary"]:disabled {{ background:{border}; color:{muted}; border-color:{border}; }}
            QPushButton[role="nav"] {{ text-align:left; background:transparent; color:#d5deed; border:0; padding:12px 10px; }}
            QPushButton[role="nav"]:hover {{ background:#303e53; }}
            QPushButton[role="nav"]:checked {{ background:#394f78; color:white; font-weight:600; }}
            QPushButton[role="slot"] {{ text-align:left; padding:18px; font-size:16px; border-radius:10px; }}
            QPushButton[role="slot"]:checked {{ border:2px solid #5278dc; background:{hover}; }}
            QPushButton[role="key"]:checked, QPushButton[role="mode"]:checked {{ background:#315cd5; color:white; border-color:#315cd5; }}
            QLineEdit, QComboBox, QSpinBox {{ background:{surface}; border:1px solid {border}; border-radius:5px; padding:7px; min-height:22px; selection-background-color:#315cd5; }}
            QComboBox QAbstractItemView {{ background:{surface}; selection-background-color:#315cd5; selection-color:white; }}
            QTableWidget {{ background:{surface}; border:1px solid {border}; gridline-color:{border}; selection-background-color:{hover}; }}
            QHeaderView::section {{ background:{hover}; color:{muted}; padding:8px; border:0; }}
            QTableCornerButton::section {{ background:{hover}; border:0; }}
            QScrollBar:vertical {{ background:{bg}; width:10px; margin:0; }}
            QScrollBar::handle:vertical {{ background:{border}; min-height:24px; border-radius:5px; }}
            QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{ height:0; }}
            QProgressBar {{ background:{border}; border:0; }} QProgressBar::chunk {{ background:#315cd5; }}
        ''')
        self.settings.setValue('theme',theme)

    def toggle_theme(self):
        self.set_theme('dark' if self.theme == 'light' else 'light')

    def report(self,text,error=False):
        self.message.setText(text)
        self.message.setProperty('role','error' if error else 'notice')
        self.message.style().unpolish(self.message)
        self.message.style().polish(self.message)

    def start_job(self, work, done, message):
        if self.busy:return
        self.busy = True
        self.report(message)
        self.progress.show()
        worker = Worker(work)
        self.job = worker
        def completed(result):
            try:done(result)
            except (ValueError,KeyError,TypeError,OSError) as exc:self.failed(str(exc))
        worker.result.connect(completed)
        worker.error.connect(self.failed)
        worker.finished.connect(self.job_finished)
        worker.start()
        self.sync()

    def job_finished(self):
        self.busy = False
        self.progress.hide()
        if self.job:
            self.job.deleteLater()
            self.job = None
        self.sync()
        if self.closing:self.close()

    def failed(self,message):
        self.valid_read = False
        self.config_status.setText('配置：请重新读取')
        self.report(message+' 重新读取后可继续编辑，草稿仍保留。',True)
        self.sync()

    def connect_device(self):
        if self.busy:return
        addr = self.address.text().strip()
        self.start_job(lambda:asyncio.run(board.read_settings(addr) if addr else board.discover_settings()),self.loaded,'正在连接配置通道并读取设置…')

    def loaded(self,snapshot):
        old_address = (self.model.snapshot or {}).get('address')
        try:self.model.load(snapshot)
        except (ValueError,KeyError,TypeError) as exc:
            self.failed(str(exc));return
        self.valid_read = True
        if old_address != snapshot['address']:
            self.undo_changes,self.undo_expected={},{}
        self.address.setText(snapshot['address'])
        self.config_status.setText('配置：已读取')
        self.connect_button.setText('重新读取')
        self.device_info.setText('固件 '+snapshot['identity']['version_display']+'  /  六个背键')
        self.source.setText(self.model.label_source)
        self.load_editor()
        decoded = snapshot['decoded']
        raw = bytes.fromhex(snapshot['raw'].get('motors',{}).get('hex',''))
        levels = [round(v/255*100) for v in raw[:4]]
        self.motor_panel.setEnabled(len(raw)==8)
        for slider,v in zip(self.motors,levels):slider.setValue(round(v))
        self.remap_from.blockSignals(True)
        self.remap_from.clear();self.remap_to.clear()
        for code in decoded['remap_keys']:
            name = board.KEY_LABELS.get(code,str(code))
            self.remap_from.addItem(name,code);self.remap_to.addItem(name,code)
        self.remap_from.blockSignals(False)
        self.load_remap_target()
        self.remap_panel.setEnabled('remapping' in snapshot['raw'])
        lights = bytes.fromhex(snapshot['raw'].get('lighting',{}).get('hex',''))
        self.light_panel.setEnabled(len(lights)==24)
        for z,field in self.light_inputs.items():field.setText('#'+lights[z*6:z*6+3].hex())
        self.report('读取成功。选择背键即可编辑，保存时会自动备份并读回核对。')
        self.sync()

    def select_slot(self,slot):
        self.selected = slot
        if self.model.snapshot:self.load_editor()
        self.sync()
        if self.width()<1160:
            self.pages.widget(0).verticalScrollBar().setValue(self.inspector.y())

    def load_editor(self):
        self.loading = True
        data = self.model.form(self.selected)
        self.trigger = data.get('trigger',0)
        kind = 0 if data['kind'] == 'hold' else 1
        self.mode.button(kind).setChecked(True)
        self.editor_stack.setCurrentIndex(kind)
        for code,b in self.keys.items():b.setChecked(code in data.get('keys',[]))
        self.steps.setRowCount(0)
        for group in data.get('sequence','').split(','):
            if not group.strip():continue
            keys,_,timing = group.strip().partition(':')
            hold,_,gap = timing.partition('/')
            self.append_row(keys,int(hold or 100),int(gap or 0))
        self.loop.setValue(data.get('loop_ms',0))
        self.loading = False
        self.edit_title.setText(self.model.labels.get(self.selected,f'槽 {self.selected+1}')+' 的输出')
        self.current.setText('手柄当前：'+friendly_output(self.model.snapshot,self.selected))
        self.update_preview()

    def mode_changed(self,index):
        self.editor_stack.setCurrentIndex(index)
        if index == 1 and not self.steps.rowCount():self.add_step()
        elif index == 0 and not any(b.isChecked() for b in self.keys.values()):self.keys[1].setChecked(True)
        self.edited()

    def append_row(self,keys='A',hold=100,gap=60):
        i = self.steps.rowCount()
        self.steps.insertRow(i)
        key = QComboBox()
        key.setEditable(True)
        key.addItems(['A','B','X','Y','LB','RB','LT','RT','A+B','LB+RB','上','下','左','右'])
        key.setCurrentText(keys.replace('DPAD_UP','上').replace('DPAD_DOWN','下').replace('DPAD_LEFT','左').replace('DPAD_RIGHT','右'))
        key.setAccessibleName(f'步骤 {i+1} 输出按键')
        key.currentTextChanged.connect(self.edited)
        self.steps.setCellWidget(i,0,key)
        for col,value in ((1,hold),(2,gap)):
            spin = QSpinBox();spin.setRange(0 if col==2 else 5,10000);spin.setSingleStep(5);spin.setValue(value)
            spin.setButtonSymbols(QSpinBox.ButtonSymbols.PlusMinus)
            spin.setAccessibleName(f'步骤 {i+1} '+('按住时间' if col==1 else '间隔时间'))
            spin.valueChanged.connect(self.edited)
            self.steps.setCellWidget(i,col,spin)
        self.steps.setRowHeight(i,46)

    def add_step(self):
        self.append_row()
        self.edited()

    def delete_step(self):
        i = self.steps.currentRow()
        if i >= 0:self.steps.removeRow(i);self.edited()

    def step_values(self):
        names={'上':'DPAD_UP','下':'DPAD_DOWN','左':'DPAD_LEFT','右':'DPAD_RIGHT'}
        return [('+'.join(names.get(k.strip(),k.strip()) for k in self.steps.cellWidget(i,0).currentText().split('+')),self.steps.cellWidget(i,1).value(),self.steps.cellWidget(i,2).value()) for i in range(self.steps.rowCount())]

    def move_step(self,delta):
        i = self.steps.currentRow();j=i+delta
        rows = self.step_values()
        if i<0 or not 0<=j<len(rows):return
        rows[i],rows[j]=rows[j],rows[i]
        self.loading=True;self.steps.setRowCount(0)
        for row in rows:self.append_row(*row)
        self.steps.selectRow(j);self.loading=False;self.edited()

    def edited(self,*_):
        if self.loading or not self.model.snapshot or self.busy:return
        if self.editor_stack.currentIndex()==0:
            change={'kind':'hold','keys':[c for c,b in self.keys.items() if b.isChecked()]}
        else:
            change={'kind':'macro','sequence':', '.join(f'{k}:{h}/{g}' for k,h,g in self.step_values()),'loop_ms':self.loop.value(),'trigger':self.trigger}
        self.model.edit(self.selected,change)
        self.update_preview();self.sync()

    def update_preview(self):
        error = self.model.errors.get(self.selected,'')
        self.field_error.setText(error)
        self.field_error.setVisible(bool(error))
        change = self.model.pending.get(self.selected)
        desc = friendly_output(self.model.snapshot,self.selected,change)
        name = self.model.labels.get(self.selected,f'槽 {self.selected+1}')
        self.preview.setText(f'{name}  →  {desc}' if not error else '请修正上方设置后再保存')

    def sync(self):
        ready = self.valid_read and not self.busy
        self.connect_button.setEnabled(not self.busy)
        self.address.setEnabled(not self.busy)
        self.inspector.setEnabled(ready)
        self.settings_content.setEnabled(ready)
        self.label_tools.setEnabled(ready)
        for i,b in enumerate(self.cards):
            b.setEnabled(ready)
            b.setChecked(i==self.selected)
            name=self.model.labels.get(i,f'槽位 {i+1}')
            desc=friendly_output(self.model.snapshot,i,self.model.pending.get(i)) if self.model.snapshot else '连接后读取当前配置'
            mark=' · 待保存' if i in self.model.pending or i in self.model.errors else ''
            b.setToolTip(desc)
            from PySide6.QtGui import QFontMetrics
            summary=QFontMetrics(b.font()).elidedText(desc,Qt.TextElideMode.ElideRight,max(150,b.width()-42))
            b.setText(name+mark+'\n'+summary)
        dirty = bool(self.model.pending or self.model.errors)
        self.discard_button.setEnabled(ready and dirty)
        self.save_button.setEnabled(ready and bool(self.model.pending) and not self.model.errors and not self.model.conflicts())
        self.undo_button.setEnabled(ready and bool(self.undo_changes))
        if self.model.errors:self.save_state.setText('有未完成的编辑，请修正或放弃改动')
        elif self.model.snapshot and self.model.conflicts():self.save_state.setText('手柄配置已改变，请放弃冲突草稿后重新编辑')
        elif self.model.pending:self.save_state.setText(f'{len(self.model.pending)} 个背键待保存')
        else:self.save_state.setText('所有背键设置已与手柄同步' if self.valid_read else '连接后开始编辑')

    def discard(self):
        self.model.clear();self.load_editor();self.sync()

    def save(self):
        if not self.save_button.isEnabled():return
        changes,expected=dict(self.model.pending),dict(self.model.expected)
        address=self.model.snapshot['address']
        self.start_job(lambda:asyncio.run(rear.apply_changes(address,changes,expected=expected)),self.saved,'正在保存背键设置并读回核对…')

    def saved(self,result):
        self.undo_changes=result.get('undo_changes',{})
        self.undo_expected=result.get('undo_expected',{})
        self.model.clear();self.loaded(result)
        self.report('已保存到手柄，并完成读回核对。原配置已自动备份。')

    def undo(self):
        if not self.undo_button.isEnabled():return
        if self.model.pending or self.model.errors:
            self.report('请先保存或放弃当前改动，再撤销上次保存。',True);return
        address=self.model.snapshot['address']
        self.start_job(lambda:asyncio.run(rear.apply_changes(address,dict(self.undo_changes),expected=dict(self.undo_expected))),self.undone,'正在恢复上次保存前的背键设置…')

    def undone(self,result):
        self.undo_changes,self.undo_expected={},{}
        self.model.clear();self.loaded(result)
        self.report('已恢复上次保存前的背键设置，并完成读回核对。')

    def load_remap_target(self):
        if not self.model.snapshot:return
        code=self.remap_from.currentData()
        remaps=self.model.snapshot['decoded'].get('remapping',{})
        target=remaps.get(str(code),remaps.get(code,0)) or code
        self.remap_to.setCurrentIndex(self.remap_to.findData(target))

    def pick_color(self,zone):
        from PySide6.QtWidgets import QColorDialog
        color=QColorDialog.getColor(QColor(self.light_inputs[zone].text()),self,'选择灯光颜色')
        if color.isValid():self.light_inputs[zone].setText(color.name())

    def apply_setting(self,feature,change):
        if not self.valid_read or self.busy:return
        try:board.desired_payload(self.model.snapshot,feature,change)
        except (ValueError,KeyError,TypeError) as exc:self.report(str(exc),True);return
        self.start_job(lambda:asyncio.run(board.apply_settings(self.model.snapshot['address'],feature,change)),self.setting_saved,'正在保存手柄设置并读回核对…')

    def setting_saved(self,result):
        self.loaded(result)
        self.report('设置已保存，并完成读回核对。背键草稿继续保留。')

    def export_profile(self):
        if not self.valid_read or self.busy:self.report('请先连接并读取手柄。',True);return
        path,_=QFileDialog.getSaveFileName(self,'导出当前背键配置','OPlus-背键配置.json','JSON (*.json)')
        if path:
            try:rear.save_profile(path,self.model.snapshot,self.model.labels);self.report('已导出手柄当前背键配置，不包含未保存的改动。')
            except (OSError,ValueError) as exc:self.report(str(exc),True)

    def import_profile(self):
        if not self.valid_read or self.busy:self.report('请先连接并读取手柄。',True);return
        path,_=QFileDialog.getOpenFileName(self,'导入背键配置或自动备份','','JSON (*.json)')
        if not path:return
        try:
            changes=rear.load_profile(path,self.model.snapshot)
            for slot,change in changes.items():self.model.edit(slot,change)
            self.load_editor();self.sync();self.report(f'已导入 {len(changes)} 项改动。检查后点击“保存到手柄”。')
        except (OSError,ValueError,KeyError,TypeError) as exc:self.report(str(exc),True)

    def edit_labels(self):
        if not self.valid_read or self.busy:return
        dialog=QDialog(self);dialog.setWindowTitle('背键名称与校正')
        v=column(dialog,24)
        v.addWidget(label(self.model.label_source,'muted',True))
        fields=[]
        for slot in range(6):
            row=QHBoxLayout();row.addWidget(label(f'槽位 {slot+1}'))
            f=QLineEdit(self.model.labels.get(slot,''));f.setMaxLength(20);row.addWidget(f);v.addLayout(row);fields.append(f)
        note=label('手动名称仅保存在电脑；引导校正会临时写入标记，结束后恢复原背键配置。','muted',True)
        v.addWidget(note)
        v.addWidget(button('开始引导校正',lambda:(dialog.reject(),self.identify())))
        box=QDialogButtonBox(QDialogButtonBox.StandardButton.Save|QDialogButtonBox.StandardButton.Cancel)
        box.button(QDialogButtonBox.StandardButton.Save).setText('保存名称')
        box.button(QDialogButtonBox.StandardButton.Cancel).setText('取消')
        box.rejected.connect(dialog.reject)
        def save_names():
            try:
                rear.save_labels(self.model.snapshot['address'],{i:f.text() for i,f in enumerate(fields)})
                self.model.labels,self.model.label_source=rear.resolve_labels(self.model.snapshot)
                self.source.setText(self.model.label_source);self.load_editor();self.sync();dialog.accept()
            except (OSError,ValueError) as exc:note.setText(str(exc))
        box.accepted.connect(save_names);v.addWidget(box);dialog.resize(480,500);dialog.exec()

    def identify(self):
        if self.model.pending or self.model.errors:
            self.report('请先保存或放弃背键改动，再开始校正。',True);return
        from .rear_identify import identify_slots
        self.cancel=threading.Event()
        dialog=CalibrationDialog(self.cancel,self);dialog.setWindowTitle('引导校正六个背键');dialog.setWindowModality(Qt.WindowModality.WindowModal)
        v=column(dialog,24);info=label('正在准备，请松开所有按键…','section',True);v.addWidget(info)
        cancel_button=button('取消并恢复原配置',lambda:(self.cancel.set(),info.setText('正在恢复原配置，请稍候…')))
        v.addWidget(cancel_button)
        def done(result):
            dialog.accept()
            if result.get('identified_labels'):
                rear.save_labels(result['address'],result['identified_labels'])
            self.loaded(result)
            self.report('校正完成，原背键配置已恢复。' if result['identification']['completed'] else '校正已结束，原背键配置已恢复。')
        self.start_job(lambda:asyncio.run(identify_slots(self.model.snapshot['address'],cancel=self.cancel,on_status=lambda s:self.job.progress.emit(s),input_slot=self.input_slot.currentData())),done,'正在校正背键，结束后将恢复原配置…')
        self.job.progress.connect(info.setText)
        self.job.error.connect(lambda _:dialog.accept())
        dialog.resize(500,210);dialog.show()
        self.identify_dialog=dialog

    def open_folder(self,path):
        path.mkdir(parents=True,exist_ok=True)
        os.startfile(path)

    def open_classic(self):
        if self.busy:return
        args=[sys.executable,'--classic'] if getattr(sys,'frozen',False) else [sys.executable,'-m','oplus','--classic']
        subprocess.Popen(args,cwd=Path(__file__).resolve().parent.parent,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        self.report('经典工具已打开。请完成一边的配置操作后再使用另一边。')

    def poll(self):
        state=self.pad.read(self.input_slot.currentData())
        self.game_status.setText('游戏输入：已连接' if state else '游戏输入：未连接')
        if self.pages.currentIndex()==2:
            self.live_keys.setText('当前输出：'+(' + '.join(sorted(state.active_inputs())) or '无按键') if state else '尚未发现游戏输入，请连接 USB 或接收器。')
            self.triggers.setText(f'LT  {state.left_trigger/255:.0%}       RT  {state.right_trigger/255:.0%}' if state else 'LT  —       RT  —')
            self.sticks.values=(state.lx,state.ly,state.rx,state.ry) if state else (0,0,0,0)
            self.sticks.update()

    def closeEvent(self,event):
        if self.busy:
            self.closing=True
            if self.cancel:self.cancel.set()
            self.report('正在完成操作或恢复原配置，完成后自动关闭。')
            event.ignore();return
        if self.model.pending or self.model.errors:
            answer=QMessageBox.question(self,'还有未保存的背键改动','放弃未保存的改动并退出？',QMessageBox.StandardButton.Discard|QMessageBox.StandardButton.Cancel,QMessageBox.StandardButton.Cancel)
            if answer!=QMessageBox.StandardButton.Discard:event.ignore();return
        event.accept()


def main():
    QApplication.setHighDpiScaleFactorRoundingPolicy(Qt.HighDpiScaleFactorRoundingPolicy.PassThrough)
    app=QApplication(sys.argv[:1])
    app.setApplicationName('O+ Studio')
    configure_application(app)
    window=Studio()
    screen=app.primaryScreen().availableGeometry()
    window.resize(min(1280,screen.width()-48),min(840,screen.height()-64))
    window.show()
    app.exec()


def configure_application(app):
    app.setStyle('Fusion')
    # Offscreen Qt has no system font enumeration on Windows. Use installed fonts
    # for rendering checks as well as minimal/custom Windows environments.
    if not QFontDatabase.families() and os.name == 'nt':
        for name in ('msyh.ttc','msyhbd.ttc','segoeui.ttf'):
            path=Path(os.environ.get('WINDIR','C:/Windows'))/'Fonts'/name
            if path.exists():QFontDatabase.addApplicationFont(str(path))
    app.setFont(QFont('Microsoft YaHei UI',10))
