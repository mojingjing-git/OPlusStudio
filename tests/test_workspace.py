import copy
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

from oplus import board, rear
from oplus.workspace import RearWorkspace
from test_rear import fixture


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        p=patch.object(board,'data_dir',return_value=Path(self.temp.name))
        p.start();self.addCleanup(p.stop)
        self.workspace=RearWorkspace()
        self.workspace.load(fixture())

    def test_edits_form_drafts_without_hardware_and_reverting_removes_them(self):
        w=self.workspace
        with patch.object(board,'BoardSession',side_effect=AssertionError('No hardware')):
            self.assertTrue(w.edit(0,{'kind':'hold','keys':[1,5]}))
            self.assertEqual(w.expected[0],rear.payload_hex(w.snapshot,0))
            self.assertTrue(w.edit(0,{'kind':'hold','keys':[1]}))
            self.assertFalse(w.pending)

    def test_invalid_form_survives_selection_and_blocks_write(self):
        w=self.workspace
        w.edit(1,{'kind':'macro','sequence':'A:37/0','loop_ms':0})
        w.edit(2,{'kind':'hold','keys':[1,5]})
        self.assertIn(1,w.errors)
        self.assertEqual(w.form(1)['sequence'],'A:37/0')
        w.edit(1,{'kind':'macro','sequence':'A:35/0','loop_ms':0})
        self.assertFalse(w.errors)
        self.assertEqual(set(w.pending),{1,2})

    def test_refresh_detects_conflict_but_different_device_clears_drafts(self):
        w=self.workspace
        w.edit(0,{'kind':'hold','keys':[5]})
        fresh=copy.deepcopy(w.snapshot)
        fresh['raw']['macro_0']=fresh['raw']['macro_1']
        w.load(fresh)
        self.assertEqual(w.conflicts(),[0])
        fresh['address']='OTHER'
        w.load(fresh)
        self.assertFalse(w.pending or w.forms or w.expected)

    def test_imported_record_has_editable_form_and_trigger_is_preserved(self):
        w=self.workspace
        change={'kind':'macro','sequence':'A:35/15,B:40/0','loop_ms':100,'trigger':1}
        payload=rear.encode_change(w.snapshot,change)
        w.edit(1,{'kind':'record','payload':payload.hex()})
        form=w.form(1)
        self.assertEqual(form['kind'],'macro')
        self.assertEqual(form['trigger'],1)
        self.assertEqual(rear.encode_change(w.snapshot,form),payload)
