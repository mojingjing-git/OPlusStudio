"""Render recorded data offscreen for DPI/layout regression checks; no device IO."""
import argparse
import json
import os
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT))
parser=argparse.ArgumentParser()
parser.add_argument('--scale',default='1')
parser.add_argument('--width',type=int,default=1280)
parser.add_argument('--height',type=int,default=840)
parser.add_argument('--dark',action='store_true')
args=parser.parse_args()
os.environ['QT_QPA_PLATFORM']='offscreen'
os.environ['QT_SCALE_FACTOR']=args.scale

from PySide6.QtWidgets import QApplication
from PySide6.QtCore import QSettings
from oplus import board
from oplus.desktop import Studio,configure_application

app=QApplication([]);configure_application(app)
snap=json.loads((ROOT/'reports/phase1-final-restored.json').read_text(encoding='utf-8'))
snap['address']='RENDER-NEW-SAME-MODEL'
with tempfile.TemporaryDirectory() as d,patch.object(board,'data_dir',return_value=Path(d)),patch.object(board,'BoardSession',side_effect=AssertionError('Render must not use hardware')),patch('oplus.desktop.QSettings',return_value=QSettings(str(Path(d)/'settings.ini'),QSettings.Format.IniFormat)):
    w=Studio();w.timer.stop();w.loaded(snap);w.set_theme('dark' if args.dark else 'light')
    w.resize(args.width,args.height);w.show();app.processEvents()
    path=ROOT/'reports/ui-0.4.0'/f"workspace-{args.width}-{args.scale}-{'dark' if args.dark else 'light'}.png"
    path.parent.mkdir(parents=True,exist_ok=True)
    capture=w.grab();capture.save(str(path))
    footer=w.save_button.mapTo(w,w.save_button.rect().bottomRight())
    viewport=w.pages.widget(0)
    result={'scale':args.scale,'theme':w.theme,'logical_size':[w.width(),w.height()],
            'pixel_size':[capture.width(),capture.height()],'device_pixel_ratio':capture.devicePixelRatio(),
            'footer_inside':footer.x()<=w.width() and footer.y()<=w.height(),
            'horizontal_scroll_max':viewport.horizontalScrollBar().maximum(),'labels':w.model.labels,'image':str(path)}
    assert result['footer_inside'] and not result['horizontal_scroll_max'],result
    path.with_suffix('.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(result,ensure_ascii=False))
    w.close()
