import ast
from pathlib import Path
from types import SimpleNamespace
import unittest
from test_new_project import Clock

source=ast.parse(Path(__file__).with_name("desktop.py").read_text(encoding="utf-8"))
editor=next(n for n in source.body if isinstance(n,ast.ClassDef) and n.name=="Editor")
method=next(n for n in editor.body if isinstance(n,ast.FunctionDef) and n.name=="detach")

class Timeline:
    def __init__(self,already=False,success_on=1):
        self.items=[SimpleNamespace(Name="MTLSVideoP:first.mp4")]
        if already: self.items.append(SimpleNamespace(Name="MTLSAudioP:first.mp4"))
        self.invocations=0
        self.success_on=success_on
        self.auto=SimpleNamespace(SendKeys=lambda *args,**kwargs:self.invoke(None))
    def foreground(self): pass
    def tracks(self): return self.items
    def named(self,*args,**kwargs): return SimpleNamespace(RightClick=lambda **kwargs:None,Click=lambda **kwargs:self.invoke(None))
    def click_clip(self,clip): pass
    def invoke(self,menu):
        self.invocations+=1
        if self.invocations==self.success_on: self.items.append(SimpleNamespace(Name="MTLSAudioP:first.mp4"))

class DetachTests(unittest.TestCase):
    def run_detach(self,timeline):
        scope={"time":Clock(),"emit":lambda *args,**kwargs:None}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[method],type_ignores=[])),"detach","exec"),scope)
        return scope["detach"](timeline,"first.mp4")
    def test_existing_audio_is_not_detached_again(self):
        timeline=Timeline(already=True)
        self.run_detach(timeline)
        self.assertEqual(timeline.invocations,0)
    def test_interrupted_action_retries_once_after_state_check(self):
        timeline=Timeline(success_on=2)
        self.run_detach(timeline)
        self.assertEqual(timeline.invocations,2)
        self.assertEqual(len(timeline.items),2)
    def test_repeated_failure_stops_with_specific_error(self):
        timeline=Timeline(success_on=3)
        with self.assertRaisesRegex(RuntimeError,"未生成独立音轨"): self.run_detach(timeline)
        self.assertEqual(timeline.invocations,2)

if __name__=="__main__": unittest.main()
