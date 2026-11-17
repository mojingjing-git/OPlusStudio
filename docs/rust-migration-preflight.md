# Rust 迁移环境预检

日期：2026-11-17。此阶段仅检查构建环境和现有资料，未连接或改动手柄。

| 项目 | 检查结果 |
|---|---|
| Rust / Cargo | 1.96.0，stable-x86_64-pc-windows-msvc |
| MSVC | C++ Build Tools 已安装，`F:/APP-DATA/VSBuildTools/VS` |
| Node | 24.14.0 |
| WebView2 | 157.0.4341.46 已安装 |
| Tauri | 使用 2.x 稳定版；检索到 core 2.12.6、CLI 2.12.5，不采用 3.0 alpha |
| BLE crate | btleplug 0.13.5，官方声明支持 Windows 10 |
| 原生对照 | `releases/0.4.0`、Python 源码及现有 105 项测试保留 |
| 基线记录 | `reports/phase1-before-improvements.json`、`reports/desktop-0.4.0-final-restored.json`，均为 11871 字节 |
| 注册表与依赖配置 | 仅查询版本；没有修改系统或用户全局 Rust 配置 |

Cargo 用户配置将 crates.io 替换为 ustc；已确认指定稳定版的信息查询和下载可用，锁文件仍需固定实际解析版本。后续构建如出现镜像故障，应局部处理，不覆盖用户全局配置。

固定依赖的独立环境工程已执行 `cargo fetch` 与 `cargo check`，编译通过（1 分 17 秒）。日志为 `reports/rust-toolchain-check.log`；工程位于 `build/rust-preflight`，仅检查依赖，不含产品协议或设备代码。原生目标缓存位于 `build/rust-target`，可供后续构建复用。

参考：
- [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
- [Tauri commands](https://v2.tauri.app/develop/calling-rust/)
- [btleplug API](https://docs.rs/btleplug/latest/btleplug/)
