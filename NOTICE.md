# O+ Studio third-party notices

This application is distributed under GPL-3.0-or-later; see LICENSE.
It is an unofficial community tool and is not affiliated with ZD or KeyLinker.

KeyLinker framing, CRC, scrambling constants, record continuation, and the
captured identity test vector in oplus/protocol.py, oplus/ble.py and
tests/test_protocol.py are adapted from / informed by:

- x20ctl, Copyright Amjad AAYD and contributors, GPL-3.0-or-later.
- Source: https://github.com/AmjadAAYD/x20ctl
- Revision: fce9627ea47af1532ee37c52d087983aa89d2d39
- Relevant files: x20ctl/protocol.py, x20ctl/client.py, tests/test_protocol.py.
- The pure protocol.py codec is also included in full at
  oplus/vendor/keylinker.py. It performs no hardware I/O. All actual device
  operations are restricted by O+ Studio's own model-specific transport.
- O+ Studio changes: identification-only transport allowlist, strict frame
  and checksum validation, native Windows diagnostics and local input tools.

The x20ctl project's tests on EasySMX models alone do not establish ZD O+
compatibility. O+ Studio separately captured and tested 1005:2001, firmware
1.37, mode 6, generation 2. Motor, remap, RGB record and macro writes were
verified by changing a value, reading it back and restoring the original.
These tests do not establish every physical LED effect or independent rear inputs.

The native Rust implementation in native/crates/oplus-core and oplus-device
also adapts this framing, scrambling, capability and macro format, with the
same x20ctl source attribution and GPL-3.0-or-later license. Model-specific
transaction journaling, IPC boundaries and desktop UI are O+ Studio additions.

Native desktop dependencies include Tauri 2 / Wry / Tao (MIT or Apache-2.0),
btleplug (MIT or Apache-2.0), Tokio (MIT), Serde (MIT or Apache-2.0), rfd (MIT),
React (MIT), and Lucide icons (ISC). Exact dependency versions are recorded
in native/Cargo.lock and native/ui/package-lock.json. The native package uses
the user's installed Microsoft WebView2 runtime rather than bundling Qt/Python.

Optional BLE backend: Bleak (MIT), https://github.com/hbldh/bleak.
Desktop UI: PySide6 / Qt 6.12 (LGPL-3.0 / GPL-3.0 / commercial licensing).
This GPL application uses the LGPL distribution, with dynamically loaded Qt DLLs
in the onedir package. Keep its included license notices and replacement DLL support.
Source and license information: https://code.qt.io/pyside/pyside-setup/
and https://doc.qt.io/qt-6/licenses.html . Classic UI remains Tcl/Tk.
BLE Windows bindings: PyWinRT (MIT), https://github.com/pywinrt/pywinrt.
Runtime: CPython and Tcl/Tk, included with their upstream license files in
the packaged distribution. Build tool: PyInstaller (GPL with bootloader exception).

Complete editable application source is in the oplus/ directory alongside
the delivered distribution; retain LICENSE, this notice and source when sharing.
