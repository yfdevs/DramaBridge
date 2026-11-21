import ast
from pathlib import Path
from types import SimpleNamespace as NS
import unittest

module = ast.parse(Path(__file__).with_name("desktop.py").read_text(encoding="utf-8"))
editor = next(node for node in module.body if isinstance(node, ast.ClassDef) and node.name == "Editor")
methods = [node for node in editor.body if isinstance(node, ast.FunctionDef) and node.name in ("trim_copy", "repeat_audio")]
error = next(node for node in module.body if isinstance(node, ast.ClassDef) and node.name == "TrackCountMismatch")
scope = {"time": NS(sleep=lambda _: None), "emit": lambda *args, **kwargs: None}
exec(compile(ast.fix_missing_locations(ast.Module(body=[error]+methods, type_ignores=[])), "trim", "exec"), scope)

class Rect:
    def __init__(self, left, right, top):
        self.left, self.right, self.top, self.bottom = left, right, top, top+20
    def width(self): return self.right-self.left

def clip(identity, name, rect):
    control = NS(Name=name, Element=NS(GetRuntimeId=lambda: [identity]), BoundingRectangle=rect)
    control.control = control
    return control

class Timeline:
    trim_copy = scope["trim_copy"]
    def __init__(self, working=True):
        self.original = clip(1, "MTLSAudioP:source", Rect(100, 1100, 200))
        self.video = clip(2, "MTLSVideoP:source", Rect(100, 1100, 100))
        self.copied = clip(3, "MTLSAudioP:source", Rect(300, 500, 220))
        self.items = [self.original, self.video]
        self.working = working
    def disable_snap(self): pass
    def tracks(self): return self.items
    def copy_at(self, *args, **kwargs):
        self.items.append(self.copied)
        return self.copied
    def drag(self, x1, y1, x2, y2):
        if self.working: self.copied.BoundingRectangle.right=x2

class AudioTrimTests(unittest.TestCase):
    def test_pasted_audio_is_actually_trimmed_without_changing_the_original(self):
        timeline=Timeline()
        result=scope["repeat_audio"](timeline, {"duration":100, "audio":[{}], "audioCopies":[{"sourceIndex":0,"seconds":20,"duration":3}]})
        self.assertEqual(timeline.copied.BoundingRectangle.width(), 30)
        self.assertEqual(timeline.original.BoundingRectangle.width(), 1000)
        self.assertEqual(result, (2,2))
    def test_ignored_trim_is_not_reported_as_success(self):
        timeline=Timeline(working=False)
        with self.assertRaisesRegex(RuntimeError,"未按计划裁短"):
            scope["repeat_audio"](timeline, {"duration":100, "audio":[{}], "audioCopies":[{"sourceIndex":0,"seconds":20,"duration":3}]})

if __name__ == "__main__": unittest.main()
