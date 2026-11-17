# Build with: .venv\Scripts\python.exe -m PyInstaller OPlusStudio.spec --noconfirm
from PyInstaller.utils.hooks import collect_submodules, copy_metadata
from importlib.metadata import distributions
from pathlib import Path
import sys
import os

# Resolve DLLs against this Python/Windows environment, not unrelated tools on
# the agent's PATH (e.g. Poppler's ICU has incompatible versioned exports).
system_root = Path(os.environ.get('SystemRoot', 'C:/Windows'))
os.environ['PATH'] = os.pathsep.join(str(p) for p in (
    Path(sys.executable).parent, Path(sys.base_prefix), Path(sys.base_prefix)/'DLLs',
    system_root/'System32', system_root,
))

runtime_licenses = []
for package in distributions():
    name = package.metadata.get('Name', '')
    if name.casefold() in ('bleak', 'typing_extensions') or name.casefold().startswith(('winrt-', 'pyside6', 'shiboken6')):
        runtime_licenses += copy_metadata(name)
python_license = Path(sys.base_prefix) / 'LICENSE.txt'
if python_license.exists():
    runtime_licenses.append((str(python_license), 'licenses/python'))

analysis = Analysis(
    ['run.py'], pathex=[], binaries=[],
    datas=[('LICENSE', '.'), ('NOTICE.md', '.'), ('README.md', '.'), ('licenses/qt', 'licenses/qt')] + runtime_licenses,
    hiddenimports=collect_submodules('bleak', filter=lambda name: 'corebluetooth' not in name and 'bluezdbus' not in name) + collect_submodules('winrt'),
    hookspath=[], hooksconfig={}, runtime_hooks=[], excludes=[], noarchive=False,
)
archive = PYZ(analysis.pure)
executable = EXE(archive, analysis.scripts, [], exclude_binaries=True,
                 name='OPlusStudio', debug=False, bootloader_ignore_signals=False,
                  manifest='OPlusStudio.manifest',
                 strip=False, upx=False, console=False,
                 disable_windowed_traceback=False)
distribution = COLLECT(executable, analysis.binaries, analysis.datas,
                       strip=False, upx=False, name='OPlusStudio')
