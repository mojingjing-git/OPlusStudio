use oplus_core::Result;
use std::{
    fs::{File, OpenOptions},
    path::Path,
};

pub fn ensure_no_legacy() -> Result<()> {
    if legacy_running() {
        return Err("请先关闭旧版 O+ Studio，再连接或开启新版映射".into());
    }
    Ok(())
}

pub struct Lease {
    _file: File,
}
impl Lease {
    pub fn acquire(root: &Path) -> Result<Self> {
        ensure_no_legacy()?;
        std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
        let f = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(root.join("native-device.lock"))
            .map_err(|e| e.to_string())?;
        fs2::FileExt::try_lock_exclusive(&f)
            .map_err(|_| "另一项 O+ 操作正在使用设备，请稍后再试".to_string())?;
        Ok(Self { _file: f })
    }
}

pub struct KeymapLease {
    _file: File,
}
impl KeymapLease {
    pub fn acquire(root: &Path) -> Result<Self> {
        ensure_no_legacy()?;
        std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
        let f = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(root.join("native-keymap.lock"))
            .map_err(|e| e.to_string())?;
        fs2::FileExt::try_lock_exclusive(&f)
            .map_err(|_| "检测到另一个 O+ Studio 实例已开启键盘宏引擎，请勿双开同时注入".to_string())?;
        Ok(Self { _file: f })
    }
}

#[cfg(windows)]
fn legacy_running() -> bool {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        System::Diagnostics::ToolHelp::*,
    };
    unsafe {
        let h = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if h == INVALID_HANDLE_VALUE {
            return false;
        }
        let mut e: PROCESSENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of_val(&e) as u32;
        let mut found = false;
        if Process32FirstW(h, &mut e) != 0 {
            loop {
                let n = e.szExeFile.iter().position(|c| *c == 0).unwrap_or(260);
                let name = String::from_utf16_lossy(&e.szExeFile[..n]);
                if name.eq_ignore_ascii_case("OPlusStudio.exe") {
                    found = true;
                    break;
                }
                if Process32NextW(h, &mut e) == 0 {
                    break;
                }
            }
        }
        CloseHandle(h);
        found
    }
}
#[cfg(not(windows))]
fn legacy_running() -> bool {
    false
}
