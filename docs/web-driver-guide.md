# O+ Studio 零安装网页驱动与 GitHub Pages 部署指南

O+ Studio 0.7.3 支持**同源双形态发布**：同一套代码库既可构建为免安装 Windows 桌面版（`OPlusStudio.Native.exe`），也可直接托管到 **GitHub Pages** 作为纯前端零安装**网页驱动**运行，板载配置与宏方案保存在用户本地浏览器（`IndexedDB`）与手柄闪存中，并支持国内直连免登录问题反馈。

---

## 一、网页驱动 vs Windows 桌面版能力对比

| 功能模块 | 网页驱动（Edge / Chrome 在线打开） | Windows 桌面版（`OPlusStudio.Native.exe`） |
| :--- | :---: | :---: |
| **蓝牙读取动态能力描述符（Verified / Compatible / ReadOnly）** | 支持（Web Bluetooth） | 支持（Windows BLE） |
| **板载背键映射 / 多步顺序宏 / 跨固件配置转译导入导出** | 支持 | 支持 |
| **板载摇杆死区 · 响应曲线 · 轴反向 · 扳机四档行程与曲线（`0x31`/`0x32`）** | 支持 | 支持 |
| **板载振动通道 / 标准按键改键 / RGB 灯区调节** | 支持 | 支持 |
| **冲突检测 · SHA-256 备份 · 回读核对 · 逆序回滚 · 恢复中心** | 支持（IndexedDB 持久化） | 支持（本地原子文件） |
| **手柄实时输入遥测 & 实体背键引导识别** | 支持（W3C Gamepad API） | 支持（XInput） |
| **电脑键盘宏方案可视化编排 · 物理键盘录入 · 背键暗号同步烧录** | 支持 | 支持 |
| **后台向外部 PC 游戏注入全局键鼠事件（`SendInput` + `F8` 急停）** | 浏览器沙箱限制不支持（一键跳转桌面版） | **原生支持（2 ms 低延迟后台线程）** |

> **浏览器要求**：蓝牙板载读写基于 W3C Web Bluetooth API，请使用桌面版 **Microsoft Edge** 或 **Google Chrome**（HTTPS 或 `localhost`）。Firefox 与 Safari 暂不支持 Web Bluetooth，但仍可在线编辑宏方案与检测手柄输入。

---

## 二、3 分钟推送 GitHub 并开启免费在线网页驱动

### 第 1 步：在 GitHub 创建仓库
登录 GitHub，新建一个仓库（例如 `oplus-studio`，推荐 Public 以便免费开启 GitHub Pages，无需勾选初始化 README / `.gitignore`）。

### 第 2 步：初始化本地 Git 并推送代码
在项目根目录（`f:\Apps\O+`）打开终端，依次执行：

```powershell
git init -b main
git add .
git commit -m "feat: O+ Studio 0.7.0 native desktop & WebBLE driver"
git remote add origin https://github.com/<你的用户名>/<你的仓库名>.git
git push -u origin main
```

> 根目录 `.gitignore` 已预置过滤 `.venv/`、`build/`、`dist/`、`releases/`、`native/ui/node_modules/`、`native/ui/dist/`、`research/` 等大体积缓存与本地产物，确保仓库干净轻量。

### 第 3 步：开启 GitHub Pages（仅需设置一次）
1. 打开你的 GitHub 仓库页面，点击顶部 **Settings** → 左侧菜单 **Pages**。
2. 在 **Build and deployment** 下的 **Source** 下拉框中，选择 **`GitHub Actions`**。
3. 切回顶部 **Actions** 标签页：
   - 工作流 **Deploy Web Driver to GitHub Pages**（`.github/workflows/deploy-web.yml`）会自动运行黄金向量测试、编译静态网页并发布（若首次开启 Pages 前已推送，点击该工作流右侧 **Run workflow** 即可手动触发）。
4. 部署完成后，访问 `https://<你的用户名>.github.io/<你的仓库名>/` 即可直接使用零安装网页驱动！

---

## 三、自动打包发布 Windows 桌面版到 GitHub Releases

当你希望让网页端点击 **“下载 Windows 桌面版运行宏”** 按钮直接跳转到最新版桌面程序时，只需推送一个 `v*` 版本标签：

```powershell
git tag v0.7.3
git push origin v0.7.3
```

GitHub Actions 工作流 **Release Windows Desktop Edition**（`.github/workflows/release-desktop.yml`）会自动在云端 `windows-latest` 环境完成：
1. 校验 Git 标签与 `Cargo.toml`、`tauri.conf.json`、`package.json`、`windows.manifest` 及成品 `.exe` 版本号严格一致；
2. 运行前端 Web 驱动测试套件（768 帧协议向量 + 42 项宏编码向量 + 事务回滚与跨页互斥测试）；
3. 运行 Rust 全工作区单元测试与集成测试；
4. 编译 `OPlusStudio.Native.exe` 并打包 `OPlusStudio-Windows-x64.zip` 自动发布到仓库的 **GitHub Releases**！

网页端会自动根据当前 `*.github.io/<repo>/` 域名（或构建期注入的仓库标识）定位到该仓库的 `releases/latest` 页面。

---

## 四、网页驱动使用小贴士

1. **连接蓝牙手柄**：手柄开机并退出手机 KeyLinker → 点击右上角 **连接并读取** → 选择 **“选择致动 / KeyLinker 手柄（推荐）”** → 在浏览器弹出的蓝牙列表中选中 `致动O+_xxxxxx` 并配对。
2. **会话内免重复弹窗**：同一标签页会话中授权一次后，后续点击 **保存到手柄（`Ctrl+S`）**、**重新读取（`Ctrl+R`）**、**撤销保存** 或 **引导识别** 均会自动直连该手柄，无需反复弹出选择器；如需切换另一只手柄，点击右上角齿轮图标（**选择其他设备**）即可。
3. **唤醒实时输入检测**：通过 USB 或 2.4G 连接手柄后，出于浏览器隐私保护机制，需**按一下手柄任意按键**，网页即可实时识别摇杆、扳机与按键状态。
