# O+ Studio 0.6.0

> 🌐 **在线零安装网页驱动（Edge / Chrome 直连蓝牙）**：**[https://mojingjing-git.github.io/OPlusStudio/](https://mojingjing-git.github.io/OPlusStudio/)**  
> 💻 **Windows 免安装原生桌面版（支持电脑后台键盘宏）**：**[前往 GitHub Releases 下载最新版](https://github.com/mojingjing-git/OPlusStudio/releases/latest)**

致动 O+ 全系及 KeyLinker 第二代兼容手柄的 **Windows 原生桌面版 + 零安装纯前端网页驱动** 同源双形态工具。采用 **Rust + Tauri 2 + React + Web Bluetooth** 架构，零 Python / Qt 依赖，桌面端保持 `asInvoker` 标准用户权限与 `PerMonitorV2` 高分屏自适应，网页端直接部署于 **GitHub Pages** 免安装即开即用。

## 两种使用方式

### 1. Windows 原生桌面版（全功能：蓝牙板载配置 + 电脑后台键鼠宏）
双击根目录 `Start-OPlus.cmd`，或直接运行 `releases/0.6.0/OPlusStudio/OPlusStudio.Native.exe`。
- **蓝牙通道**：读取能力描述符、编辑板载背键、振动、标准改键、RGB 灯区与导出诊断包。
- **USB / 2.4G（XInput）通道**：实时输入检测与**电脑端原生键盘/鼠标宏映射**（无需连接蓝牙即可直接使用，支持 `F8` 全局急停）。

旧版 `releases/0.5.0` 与经典版 `releases/0.4.0`（`Start-OPlus-Classic.cmd`）完整保留。连接设备或开启键盘宏前请先关闭其他版本实例。

### 2. 零安装在线网页驱动（GitHub Pages / Edge & Chrome）
无需安装任何客户端或服务器，在桌面版 **Microsoft Edge / Google Chrome** 中直接打开网页版即可：
- 通过 **Web Bluetooth** 直连致动 O+（自动适配 `"致动O+_..."` 广播名）完成板载背键、顺序宏、振动、标准改键、RGB 灯区读写与 **背键三键暗号一键烧录**；
- 通过 **W3C Gamepad API** 实时检测手柄摇杆/扳机输入并运行实体背键引导识别；
- 通过 **IndexedDB + SHA-256** 在浏览器本地执行完整的冲突检测、备份校验、回读核对、失败逆序回滚与崩溃恢复中心；
- 在线编排好的电脑键鼠宏方案可一键导出 `.json`，无缝导入免安装 Windows 桌面版运行游戏后台宏。

## 快速部署到 GitHub Pages 与 GitHub Releases

仓库已内置自动化工作流（`.github/workflows/deploy-web.yml` 与 `.github/workflows/release-desktop.yml`）：

```powershell
# 1. 初始化并推送到你的 GitHub 仓库
git init -b main
git add .
git commit -m "feat: O+ Studio 0.6.0 desktop & web driver"
git remote add origin https://github.com/<用户名>/<仓库名>.git
git push -u origin main

# 2. 在 GitHub 仓库 Settings -> Pages -> Source 选择 "GitHub Actions"
#    即可自动部署在线网页驱动：https://<用户名>.github.io/<仓库名>/

# 3. （可选）推送版本标签，自动构建并发布 OPlusStudio-Windows-x64.zip 到 GitHub Releases
git tag v0.6.0
git push origin v0.6.0
```

详细步骤请参阅 **[网页驱动与 GitHub Pages 部署指南](docs/web-driver-guide.md)**。

## 0.6.0 核心功能

### 1. 致动 O+ 全系动态通用化与三级兼容分级
- **已实测型号（`Verified`）**：致动 O+（VID `1005` / PID `2001`，固件 `1.37`，mode 6 / gen 2）自动启用验证预设。
- **动态兼容（`Compatible`）**：对 KeyLinker 第二代协议（`effective_generation == 2`）的不同固件与批次，基于 `0xB0` 动态能力描述符按需适配 `1–8` 个背键槽、动态宏按键位掩码（含未知扩展键 `KEY_{code}` 无损往返）、每槽独立步数上限（`D8.bit1` `kind 6`，最高 47 步）、独立改键可选目标表（`D6.bit1` `kind 7`）、按通道无损更新的振动强度以及动态 RGB 灯区。
- **只读诊断模式（`ReadOnly`）**：第一代协议或未知异常描述符设备不断连，支持查看身份信息并一键导出 `oplus-diagnostic-v1` 兼容诊断包，严格拦截任何盲写。
- **跨固件配置分享与事务安全**：支持跨不同 `macro_keys` 布局的背键配置在掩码层无损重编码导入（完整保留 `Hold` 与多步宏）；桌面端与网页端共享逐位等价的冲突检查、快照备份、逐项回读核对、失败逆序回滚与崩溃恢复中心保护。

### 2. 电脑端原生键盘/鼠标宏映射引擎
- **零依赖低延迟后台线程**：基于 Windows 高精度等待定时器（`CreateWaitableTimerExW` `2 ms` 节拍，空闲时 `Condvar` 0% CPU 挂起）与标准用户态 `SendInput`（填充虚拟键码 + `MapVirtualKeyW` 硬件扫描码 + 扩展键标志）。
- **背键 → 电脑键盘宏一键暗号桥接**：内置 8 槽低冲突三键板载暗号预设（如 `M1 = Back + LS + RS`），支持自定义暗号并一键同步到背键草稿写入手柄（桌面端与网页端均可直接烧录）。
- **无串扰组合键匹配与语义引用计数**：已激活组合键在按住期间独占其组成按钮（按住 `M1` 叠加正面方向键绝不误触 `M2`），支持 `20 ms` 真子集防抖与 `<20 ms` 快速轻点补发；多规则共用 `Ctrl/Shift/Alt/Win` 引用计数不提前释放，释放时先普通键后修饰键。
- **多步顺序宏与物理键盘录入**：支持单次执行、按住循环（松手立停）、按下切换循环，支持纯滚轮脉冲步与纯等待步；页面内基于物理键位码（`KeyboardEvent.code`）录入按键，兼容中文输入法；支持导入旧版 `0.4.0` `profile.json`。
- **全方位防卡键与合规边界**：全局保留 `F8` 紧急停止；BLE 读写、录入弹窗、手柄断连与关闭窗口时自动暂停并全量释放按键；遇到管理员窗口（UIPI）或反作弊拦截时立即优雅放弃注入并提示，绝不做任何驱动或进程注入绕过。

[网页驱动部署指南](docs/web-driver-guide.md) · [使用指南](docs/native-user-guide.md) · [0.6.0 验证记录](docs/v0.6-validation.md) · [0.6.0 实施计划](docs/v0.6-plan.md) · [0.6.0 独立复审](docs/v0.6-plan-review.md) · [0.5.0 验证记录](docs/native-validation.md) · [旧版说明](README-0.4.md)

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
