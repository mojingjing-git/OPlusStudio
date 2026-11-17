import copy
import json
from pathlib import Path
import tempfile
import unittest

from oplus import profiles as p


class ProfileTests(unittest.TestCase):
    def test_profile_roundtrip_and_macro_timing(self):
        profile = copy.deepcopy(p.DEFAULT)
        profile["mappings"] = {"A": "Space"}
        profile["macros"] = {"Y": p.macro_from_text("Q:100/60, MouseLeft:80/0")}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "nested" / "my.json"
            p.save(path, profile)
            self.assertEqual(p.load(path), profile)
            self.assertFalse(path.with_suffix(".json.tmp").exists())

    def test_invalid_or_reserved_macro_keys(self):
        for text in ("F8", "", "Space:0", "Q:hello", "Q:50/-1", "Q:10001", "NotAKey"):
            with self.assertRaises(ValueError, msg=text):
                p.macro_from_text(text)

    def test_malformed_imports_rejected(self):
        for patch in ({"version": 2}, {"mappings": []}, {"mouse_speed": float("nan")},
                      {"mouse_enabled": "false"}, {"mouse_deadzone": -1},
                      {"macros": {"Y": [{"key": "Q", "hold_ms": True, "after_ms": 0}]}},
                      {"mappings": {"M1": "A"}}, {"mappings": {"A": "F8"}}):
            profile = copy.deepcopy(p.DEFAULT)
            profile.update(patch)
            with self.assertRaises(ValueError, msg=repr(patch)):
                p.validate(profile)

    def test_cannot_assign_key_and_macro_to_same_trigger(self):
        profile = copy.deepcopy(p.DEFAULT)
        profile["mappings"] = {"A": "Q"}
        profile["macros"] = {"A": p.macro_from_text("E")}
        with self.assertRaises(ValueError):
            p.validate(profile)


if __name__ == "__main__":
    unittest.main()
