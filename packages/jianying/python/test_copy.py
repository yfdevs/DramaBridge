import ast
from pathlib import Path
from types import SimpleNamespace as NS
import unittest

source=ast.parse(Path(__file__).with_name("desktop.py").read_text(encoding="utf-8"))
editor=next(n for n in source.body if isinstance(n,ast.ClassDef) and n.name=="Editor")
method=next(n for n in editor.body if isinstance(n,ast.FunctionDef) and n.name=="copy_at")
def clip(identity): return NS(Name="MTLSVideoP:first.mp4",Element=NS(GetRuntimeId=lambda:[identity]))
class Timeline:
    def __init__(self,ambiguous=False):
        self.items=[clip(1)]; self.keys=[]; self.seen=None; self.reads=0; self.ambiguous=ambiguous
        self.auto=NS(SendKeys=lambda key,**kwargs:self.keys.append(key))
    def tracks(self): self.reads+=1; return self.items
    def click_clip(self,*args,**kwargs): pass
    def seek(self,*args,tracks=None): self.seen=tracks
    def wait_track_count(self,prefix,expected): return [clip(2),clip(3)] if self.ambiguous else self.items+[clip(2)]
class CopyTests(unittest.TestCase):
    def copy(self,timeline):
        scope={}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[method],type_ignores=[])),"copy","exec"),scope)
        return scope["copy_at"](timeline,timeline.items[0],10,100,"MTLSVideoP:",tracks=timeline.items)
    def test_reuses_observed_tracks_and_identifies_only_the_new_copy(self):
        timeline=Timeline()
        copied=self.copy(timeline)
        self.assertEqual(copied.Element.GetRuntimeId(),[2])
        self.assertIs(timeline.seen,timeline.items)
        self.assertEqual(timeline.reads,0)
        self.assertEqual(timeline.keys,["{Ctrl}c","{Ctrl}v"])
    def test_ambiguous_copy_fails_without_pasting_again(self):
        timeline=Timeline(ambiguous=True)
        with self.assertRaisesRegex(RuntimeError,"唯一核对"): self.copy(timeline)
        self.assertEqual(timeline.keys.count("{Ctrl}v"),1)
if __name__=="__main__": unittest.main()
