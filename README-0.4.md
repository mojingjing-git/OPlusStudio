# O+ Studio

致动 O+ 的 Windows 社区工具，当前版本 0.4.0。已经实现 XInput 输入测试、电脑端键鼠映射 / 宏，以及通过 BLE 读取和写入板载设置。

已在这只 **VID 1005 / PID 2001、固件 1.37、mode 6 / generation 2** 的旧款 O+ 实机验证：四路马达强度、标准按键映射、六个背键宏槽及 RGB 配置记录可以写入并读回。每项实验均已恢复原配置。其他固件或模式会被拒绝写入。

**当前设置下，实测背面 M1 在有线 DInput 中输出十字键“下”，没有出现独立按钮编号。独立背键键鼠映射尚未实现。** 摇杆 / 扳机参数暂时只读，RGB 写入是否立即驱动实体灯效仍需用户观察。

## 启动

双击 `Start-OPlus.cmd`，优先启动 `releases/0.4.0/OPlusStudio/OPlusStudio.exe`。新版默认打开“背键设置”工作台；旧版和源码作为后备保留。

也可以直接运行 `releases/0.4.0/OPlusStudio/OPlusStudio.exe`。移动程序时请保留整个 `OPlusStudio` 文件夹，包括 `_internal`；无需安装额外内核驱动。

源码运行需要 Windows 10 / 11、Python 3.10+（本机使用 3.13）：

```powershell
python -m oplus
```

普通输入功能只用标准库。BLE 诊断另外需要电脑本身具有可用 BLE 蓝牙适配器，以及：

```powershell
python -m pip install -r requirements.txt
```

## 第一阶段：修改手柄背键

0.4.0 使用 Qt 6 桌面工作台，支持 Windows 每显示器 DPI 缩放、明暗主题和窄窗口重排。侧栏分为背键设置、手柄设置、实时测试、工具与帮助；底部保存栏始终可见。

1. 手柄开机，退出手机 KeyLinker，点击右上角“连接并读取”。顶部单独显示游戏输入与配置状态；USB / 接收器用于游戏，蓝牙用于读取设置。
2. 在六键总览中选 M1、M2、LM、RM、LK 或 RK。匹配已实测 O+ 1.37 的身份与能力时自动填入名称，本机保存的个人校正优先。新买同款无需重复识别。
3. “按住映射”直接选择一个或多个输出键；“定时宏”按行设置输出、按住时间和间隔，可增删、排序。组合键写 A+B，时间以 5 ms 为单位；循环间隔 0 表示只执行一次。
4. 编辑自动暂存在当前窗口，卡片及底部显示待保存数量；选择其他背键会保留草稿。错误显示在当前编辑区，修正后才能保存。
5. 点击“保存到手柄”（Ctrl+S）。程序先检查冲突，再自动备份，只写改动的槽并逐个读回核对。失败时尝试恢复全部已写槽。
6. “撤销上次保存”可恢复本次启动最近一次背键保存；“放弃改动”只清除当前草稿。重新读取用 Ctrl+R。
7. “工具与帮助”提供背键配置导入导出和自动备份入口。导入仅生成草稿，确认后才写入；导出的是当前手柄记录。
8. 六键总览的“名称与校正”可手动记住名称，也可重新引导校正。引导会临时给六槽写入标记并恢复，不是常规使用的必要步骤。

已实测的型号预设：M1 / M2 / LM / RM / LK / RK 对应槽 1 / 2 / 3 / 4 / 5 / 6。未知固件、不同宏按键表或不同槽能力不套用。手动校正仍要求唯一在线 XInput 手柄、非空宏槽及默认标准改键。

所有板载写入仍仅开放 VID 1005 / PID 2001、固件 1.37、mode 6 / generation 2。42 个按住 / 松开记录上限及空槽写入限制继续保留。备份在 `%LOCALAPPDATA%\OPlusStudio\backups`。摇杆 / 扳机曲线目前仍只读，可通过“工具与帮助 → 打开经典工具”查看。

手柄设置页分别保存震动强度、标准改键和灯光，背键草稿继续保留。第二阶段的独立键鼠能力尚未完成；经典电脑映射不代表背键已经独立上报。

详细调研、证据边界和布局取舍见 [桌面体验调研](docs/ui-research-2026-11.md)。

## 第二阶段与已有电脑端功能

背键独立输出电脑键盘 / 鼠标留待第二阶段。第一阶段的“保持映射”及板载宏使用手柄键，不会自动增加独立背键输入。已有的普通 XInput 键鼠映射 / 电脑宏保留在对应页，默认关闭；F8 停止输出。板载保存或识别恢复期间不能重新启用电脑输出。

电脑端配置在 `%LOCALAPPDATA%\OPlusStudio\profile.json`。源码运行的报告在项目 `reports`，打包程序的报告在 `%LOCALAPPDATA%\OPlusStudio\reports`，更新程序不会覆盖它们。

## 有线模式与背键实测

本机这只固件 1.37 的 O+ 可同时长按正面 **Start + Back** 切换 XInput / DInput；Back 是正面的选择键，不是背键 M1。等待 Windows 重新识别后松开，重复同一操作可切回。

| 模式 | 实测 USB 标识 | 当前工具支持 |
| --- | --- | --- |
| XInput | `045E:028E` | 实时测试、电脑端键鼠映射 / 宏、即时震动 |
| DInput | `0079:181C` | 开发用只读采样；桌面界面暂不读取此模式的游戏输入 |

DInput 声明 15 个按钮，但数量增加不能证明背键独立。正面 A / 背面 M1 对照采样中，A 输出按钮 1；M1 三次输出 POV `18000`（十字键下），没有额外按钮位。因此，若直接把这个 M1 输出映射为键盘键，十字键下也会触发。该结论只适用于本次设置与采样通道，不外推其他背键或未知固件模式。记录见 `reports/dinput-A-then-M1.json`。

之后在 XInput 模式下完成了同步 BLE 对照：用户确认最后一轮实际按的是 A / M2。A 输出 XInput A、BLE 键码 1；M2 三次输出 XInput B、BLE 键码 2，未观察到 M2 专属键码。记录已更正为 `reports/oplus-live-armed-A-M2.json`；这项更正仅针对最后一轮，不改变前面的 DInput M1 记录。

本次诊断后已确认切回 XInput、槽位 0 在线，记录见 `reports/hardware-after-mode-test.json`。BLE 板载配置和游戏输入是不同通道；不要把 KeyLinker 的 `1005:2001` 与上述兼容 USB 标识混为一谈。

## 当前边界

- 电脑端映射 / 宏需要程序持续运行，不能离线保存在手柄上。
- 原始手柄输入仍会传给游戏，可能和键鼠输出同时生效。此版本没有隐藏物理设备或安装过滤驱动。
- F8 被保留为停止键，不能作为映射 / 宏输出。
- 同一个输入只能绑定一个按键或一个宏。多个输入绑定同一个输出时使用引用计数，避免提前释放。
- 背键如果只被固件转换为 A/B 等常规按键，就不能通过标准 XInput 区分它与正面按键。菜单没有把 M1 等伪装成已识别的独立输入。
- 震动测试是 XInput 的即时马达输出，300 ms 自动归零，不修改板载默认强度。
- Windows SendInput 不能向权限高于本程序的窗口注入输入；部分游戏不接受模拟键鼠。
- USB 直连和 2.4G 接收器可能暴露不同接口，需要分别检查。克隆的 Xbox VID/PID 不能证明厂商或型号。
- KeyLinker BLE 配置与游戏输入可能同时存在，但 O+ 上是否可同时连接必须实测。2.4G 接收器本身不等于通用蓝牙适配器。
- 身份诊断模块只允许 0x90 / 0x91 / 0xB0 查询。板载模块在重新验证精确型号 / 固件后，允许已实测的马达、改键、宏和 RGB 记录写入。没有校准、恢复出厂或固件写入路径。
- RGB 写入保留 data4/data5/light 等未知字段；不把它们猜作灯效模式或亮度。摇杆外参数也与参考型号存在解释差异，因此暂不开放写入。
- `live_probe.py` 是开发用的限时实时流探针，使用固定进入 / 退出命令，最长 15 秒，结束后退出并断开 BLE。它不解码或伪造六个背键输入，也不在程序启动时自动执行。

## 开发和验证

```powershell
python -m unittest discover -s tests -v
python -m oplus --diagnose --out reports/hardware.json
python -m oplus --sample 3 --slot 0 --out reports/input.json
python -m oplus --scan-ble --out reports/ble.json
python -m oplus --identify AA:BB:CC:DD:EE:FF --out reports/keylinker.json
python -m oplus.dinput_probe --label M1 --seconds 30 --out reports/dinput-M1.json
```

诊断与采样不发送键鼠事件，也不改变手柄设置。DInput 采样需要先手动切到 DInput，记录的是原始编号，不预设背键对应关系。映射引擎测试使用模拟输出，不操作真实键鼠。

打包：

```powershell
python -m pip install -r requirements-build.txt
python -m PyInstaller OPlusStudio.spec --noconfirm
```

完整构建环境版本记录在 `requirements-lock.txt`。打包时 BLE 模块随程序分发。

项目结构：`rear.py` 为背键事务与配置文件，`rear_ui.py` 为背键编辑器，`rear_identify.py` 为可恢复的实体键识别；`windows_input.py` 为 Windows API，`engine.py` 为软件输出与宏调度，`diagnostics.py` 为硬件枚举，`protocol.py` / `ble.py` 为身份读取，`board.py` 为型号限定的板载配置与恢复，`board_ui.py` / `app.py` 为桌面界面。

协议研究与后续实机验证步骤见 [docs/research.md](docs/research.md)。项目采用 GPL-3.0-or-later，协议参考代码署名见 [NOTICE.md](NOTICE.md)。
