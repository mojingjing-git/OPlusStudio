import copy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from PySide6.QtWidgets import QApplication
from PySide6.QtCore import Qt
from oplus import board
from oplus.desktop import Studio, friendly_output, CalibrationDialog
from test_rear import fixture

APP=QApplication.instance() or QApplication([])


class DesktopTests(unittest.TestCase):
    def wait_job(self):
        import time
        deadline=time.monotonic()+3
        while self.window.busy and time.monotonic()<deadline:
            APP.processEvents()
            time.sleep(.01)
        APP.processEvents()
        self.assertFalse(self.window.busy)

    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        p=patch.object(board,'data_dir',return_value=Path(self.temp.name));p.start();self.addCleanup(p.stop)
        self.window=Studio();self.window.timer.stop()
        self.snap=fixture()
        self.window.loaded(self.snap)
        self.addCleanup(self.cleanup_window)

    def cleanup_window(self):
        self.window.model.clear();self.window.busy=False;self.window.close()

    def test_reading_populates_motors_and_new_edit_auto_stages_without_io(self):
        s=self.window
        self.assertTrue(s.valid_read)
        self.assertEqual([x.value() for x in s.motors],[75,75,30,30])
        with patch.object(board,'BoardSession',side_effect=AssertionError('No hardware')):
            s.keys[5].click()
            self.assertIn(0,s.model.pending)
            self.assertTrue(s.save_button.isEnabled())
            self.assertIn('待保存',s.cards[0].text())
            s.select_slot(1);s.select_slot(0)
            self.assertTrue(s.keys[5].isChecked())

    def test_macro_steps_invalid_time_and_trigger_survive_navigation(self):
        s=self.window;s.trigger=1;s.mode_changed(1)
        s.steps.cellWidget(0,1).setValue(37)
        self.assertFalse(s.save_button.isEnabled())
        self.assertIn(0,s.model.errors)
        s.select_slot(1);s.select_slot(0)
        self.assertEqual(s.steps.cellWidget(0,1).value(),37)
        s.steps.cellWidget(0,1).setValue(35)
        self.assertTrue(s.save_button.isEnabled())
        self.assertEqual(s.model.pending[0]['trigger'],1)

    def test_failed_write_requires_reread_and_preserves_draft(self):
        s=self.window;s.keys[5].click();s.failed('test failure')
        self.assertFalse(s.save_button.isEnabled())
        self.assertTrue(s.model.pending)
        s.loaded(self.snap)
        self.assertTrue(s.save_button.isEnabled())

    def test_background_completion_updates_view_and_preserves_undo(self):
        s=self.window;s.keys[5].click()
        result=copy.deepcopy(self.snap)
        result['undo_changes']={0:{'kind':'hold','keys':[1]}}
        result['undo_expected']={0:'test'}
        s.start_job(lambda:result,s.saved,'saving')
        self.assertFalse(s.save_button.isEnabled())
        self.wait_job()
        self.assertFalse(s.model.pending)
        self.assertTrue(s.undo_button.isEnabled())
        self.assertIn('读回核对',s.message.text())

    def test_background_failure_keeps_drafts_and_disables_writes(self):
        s=self.window;s.keys[5].click()
        def fail():raise RuntimeError('simulated disconnect')
        s.start_job(fail,s.saved,'saving')
        self.wait_job()
        self.assertFalse(s.valid_read)
        self.assertTrue(s.model.pending)
        self.assertFalse(s.save_button.isEnabled())
        self.assertIn('simulated disconnect',s.message.text())

    def test_device_switch_clears_undo_and_missing_optional_records_stay_disabled(self):
        s=self.window;s.undo_changes={1:{'kind':'hold','keys':[1]}}
        snap=copy.deepcopy(self.snap);snap['address']='OTHER'
        snap['raw'].pop('motors');snap['raw'].pop('lighting')
        s.loaded(snap)
        self.assertFalse(s.undo_changes)
        self.assertFalse(s.motor_panel.isEnabled())
        self.assertFalse(s.light_panel.isEnabled())
        self.assertTrue(s.inspector.isEnabled())

    def test_compact_layout_keeps_footer_outside_scrolling_editor(self):
        s=self.window;s.resize(960,680);s.show();APP.processEvents()
        from PySide6.QtWidgets import QBoxLayout
        self.assertEqual(s.rear_layout.direction(),QBoxLayout.Direction.TopToBottom)
        p=s.save_button.mapTo(s,s.save_button.rect().bottomRight())
        self.assertLessEqual(p.y(),s.height())
        self.assertLessEqual(p.x(),s.width())
        self.assertTrue(s.save_button.isVisible())
        s.resize(1280,840);APP.processEvents()
        self.assertEqual(s.rear_layout.direction(),QBoxLayout.Direction.LeftToRight)

    def test_chinese_output_and_calibration_close_wait_for_restore(self):
        import threading
        s=self.window
        self.assertEqual(friendly_output(self.snap,0),'按住 A')
        event=threading.Event();dialog=CalibrationDialog(event,s)
        dialog.show();APP.processEvents();dialog.close()
        self.assertTrue(event.is_set())
        self.assertTrue(dialog.isVisible())
        dialog.accept()
