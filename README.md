# O+ Studio 0.7.1

> 🌐 **在线零安装网页驱动（Edge / Chrome 直连蓝牙）**：**[https://mojingjing-git.github.io/OPlusStudio/](https://mojingjing-git.github.io/OPlusStudio/)**  
> 💻 **Windows 免安装原生桌面版（支持电脑后台键盘宏）**：**[前往 GitHub Releases 下载最新版](https://github.com/mojingjing-git/OPlusStudio/releases/latest)**

致动 O+ 全系及 KeyLinker 第二代兼容手柄的 **Windows 原生桌面版 + 零安装纯前端网页驱动** 同源双形态工具。采用 **Rust + Tauri 2 + React + Web Bluetooth** 架构，零 Python / Qt 依赖，桌面端保持 `asInvoker` 标准用户权限与 `PerMonitorV2` 高分屏自适应，网页端直接部署于 **GitHub Pages** 免安装即开即用。

## 两种使用方式

### 1. Windows 原生桌面版（全功能：蓝牙板载配置 + 电脑后台键鼠宏）
双击根目录 `Start-OPlus.cmd`，或直接运行 `releases/0.7.1/OPlusStudio/OPlusStudio.Native.exe`。
- **蓝牙通道**：读取能力描述符、编辑板载背键、**左右摇杆内外死区 / 响应曲线 / X·Y 轴反向 / 左右互换**、**左右扳机起始与末端死区 / 四档行程预设 / 响应曲线**、振动强度、标准改键、RGB 灯区与导出诊断包。
- **USB / 2.4G（XInput）通道**：实时输入检测（含曲线画布草稿软件估算光点与多手柄槽位切换）与**电脑端原生键盘/鼠标宏映射**（无需连接蓝牙即可直接使用，支持 `F8` 全局急停，方案库上限提升至 `8 MiB`）。

历史版本 `releases/0.7.0`、`releases/0.6.0`、`releases/0.5.0` 与经典版 `releases/0.4.0`（`Start-OPlus-Classic.cmd`）完整保留。连接设备或开启键盘宏前请先关闭其他版本实例。

### 2. 零安装在线网页驱动（GitHub Pages / Edge & Chrome）
无需安装任何客户端或服务器，在桌面版 **Microsoft Edge / Google Chrome** 中直接打开网页版即可：
- 通过 **Web Bluetooth** 直连致动 O+（自动适配 `"致动O+_..."` 广播名）完成板载背键、顺序宏、**高级摇杆与扳机死区/曲线/行程档位（`0x31` / `0x32`）**、振动、标准改键、RGB 灯区读写与 **背键三键暗号一键烧录**；
- 通过 **W3C Gamepad API** 实时检测手柄摇杆/扳机输入（在曲线画布实时渲染硬件投影光点）并运行实体背键引导识别；
- 通过 **IndexedDB + SHA-256** 在浏览器本地执行完整的冲突检测、备份校验、回读核对、失败逆序回滚与崩溃恢复中心；
- 在线编排好的电脑键鼠宏方案可一键导出 `.json`，无缝导入免安装 Windows 桌面版运行游戏后台宏。

## 快速部署到 GitHub Pages 与 GitHub Releases

仓库已内置自动化工作流（`.github/workflows/deploy-web.yml` 与 `.github/workflows/release-desktop.yml`）：

```powershell
# 1. 初始化并推送到你的 GitHub 仓库
git init -b main
git add .
git commit -m "feat: O+ Studio 0.7.0 desktop & web driver"
git remote add origin https://github.com/<用户名>/<仓库名>.git
git push -u origin main

# 2. 在 GitHub 仓库 Settings -> Pages -> Source 选择 "GitHub Actions"
#    即可自动部署在线网页驱动：https://<用户名>.github.io/<仓库名>/

# 3. （可选）推送版本标签，自动校验版本号并构建发布 OPlusStudio-Windows-x64.zip 到 GitHub Releases
git tag v0.7.1
git push origin v0.7.1
```

详细步骤请参阅 **[网页驱动与 GitHub Pages 部署指南](docs/web-driver-guide.md)**。

## 0.7.1 核心功能与安全加固

### 1. 板载高级摇杆与扳机工作台（`0x31 WRITE_STICK` / `0x32 WRITE_TRIGGER`）
- **交互式液态玻璃响应曲线画布**：基于 Fritsch-Carlson 单调三次样条插值（平滑通过 `(0,0)`、`P1`、`P2`、`(255,255)` 且零震荡过冲），支持鼠标/触控拖拽双高光控制点 `P1`、`P2` 与精确数值微调；USB / 2.4G 在线时实时投射翠绿硬件输入光点。
- **官方预设与扳机四档行程**：内置 `线性默认`、`快速灵敏`、`缓和延迟`、`平滑渐进`、`精细微调` 五大曲线预设，以及扳机专属 `零死区全行程`（`0–200`）、`微死区灵巧`（`4–166`）、`中行程均衡`（`20–160`）、`短触发速射`（`30–140`）四档快捷行程。
- **精细通道保护与标志位守卫**：严格按 `0xB0` 能力位（`bit 1` 左侧、`bit 0` 右侧）开放通道；支持单侧独立暂存与一键镜像到对侧，未触碰通道、摇杆高位未知标志（`0xF8`）及扳机全部标志字节 `100%` 原样保留。

### 2. 致动 O+ 全系动态通用化与三级兼容分级
- **已实测型号（`Verified`）**：致动 O+（VID `1005` / PID `2001`，固件 `1.37`，mode 6 / gen 2）自动启用验证预设。
- **动态兼容（`Compatible`）**：对 KeyLinker 第二代协议（`effective_generation == 2`）的不同固件与批次，基于 `0xB0` 动态能力描述符按需适配 `1–8` 个背键槽、动态宏按键位掩码（含未知扩展键 `KEY_{code}` 无损往返）、每槽独立步数上限（`D8.bit1` `kind 6`，最高 47 步）、独立改键可选目标表（`D6.bit1` `kind 7`）、摇杆/扳机曲线、振动强度及动态 RGB 灯区。
- **只读诊断模式（`ReadOnly`）**：第一代协议或未知异常描述符设备不断连，支持查看身份信息并一键导出 `oplus-diagnostic-v1` 兼容诊断包，严格拦截任何盲写。

### 3. 电脑端原生键盘/鼠标宏映射引擎
- **零依赖低延迟后台线程**：基于 Windows 高精度等待定时器（`CreateWaitableTimerExW` `2 ms` 节拍，空闲时 `Condvar` 0% CPU 挂起）与标准用户态 `SendInput`。
- **背键 → 电脑键盘宏一键暗号桥接**：内置 8 槽低冲突三键板载暗号预设（如 `M1 = Back + LS + RS`），桌面端与网页端均可一键同步并烧录至手柄。
- **无串扰组合键匹配、物理键盘录入与 `F8` 全局急停**：支持单次执行、按住循环、按下切换循环、纯滚轮脉冲步与旧版 `0.4.0` `profile.json` 导入；遇到 UIPI 或反作弊拦截时优雅放弃注入并提示。

[0.7.1 验证记录](docs/v0.7.1-validation.md) · [0.7.0 验证记录](docs/v0.7-validation.md) · [网页驱动部署指南](docs/web-driver-guide.md) · [使用指南](docs/native-user-guide.md) · [0.6.0 验证记录](docs/v0.6-validation.md) · [0.5.0 验证记录](docs/native-validation.md) · [旧版说明](README-0.4.md)

## 源码构建与自动化测试

就绪稳定版 Rust MSVC、Visual Studio C++ Build Tools、Node.js（v22.6+ / v24）与 WebView2 后，一键运行 Web + Rust 全量测试并构建双端产物：

```powershell
powershell -File native/build.ps1
```

单独运行纯前端网页驱动黄金向量与事务测试套件：

```powershell
npm --prefix native/ui run test:web
```

单独运行 Rust 全工作区无硬件测试：

```powershell
cargo test --locked --manifest-path native/Cargo.toml --workspace --target-dir build/rust-target
```

桌面版应用数据目录为 `%LOCALAPPDATA%\OPlusStudio`（板载快照位于 `backups`，事务日志位于 `journals`，电脑键盘宏方案位于 `keymap-profiles.json`）；网页驱动数据存储在当前浏览器域名隔离的 `IndexedDB`（`OPlusStudioWebDB`）中。

协议参考 [x20ctl](https://github.com/AmjadAAYD/x20ctl)，采用 GPL-3.0-or-later 许可；详见 [NOTICE](NOTICE.md) 与 [LICENSE](LICENSE)。
