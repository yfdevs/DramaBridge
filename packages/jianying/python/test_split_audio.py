import ast
from pathlib import Path
from types import SimpleNamespace as NS
import unittest

source=ast.parse(Path(__file__).with_name("desktop.py").read_text(encoding="utf-8"))
editor=next(n for n in source.body if isinstance(n,ast.ClassDef) and n.name=="Editor")
method=next(n for n in editor.body if isinstance(n,ast.FunctionDef) and n.name=="split_audio")
def clip(name,left=0,right=100): return NS(Name=name,BoundingRectangle=NS(left=left,right=right))

class Timeline:
    def __init__(self,wrong=False): self.reads=0; self.wrong=wrong; self.seek_inputs=[]; self.waits=[]
    def foreground(self): pass
    def tracks(self): self.reads+=1; return [clip("MTLSAudioP:a"),clip("MTLSVideoP:v")]
    def seek(self,seconds,duration,tracks=None): self.seek_inputs.append(tracks)
    def click_clip(self,selected,wait_time): self.waits.append(wait_time)
    def split_button(self): return NS(Click=lambda **kwargs:None)
    def wait_track_count(self,prefix,expected):
        return [clip("MTLSAudioP:a",i*100/expected,(i+1)*100/expected) for i in range(expected)]+[clip("MTLSVideoP:wrong" if self.wrong else "MTLSVideoP:v")]

class SplitAudioTests(unittest.TestCase):
    def run_split(self,timeline):
        scope={"emit":lambda *args,**kwargs:None}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[method],type_ignores=[])),"split_audio","exec"),scope)
        scope["split_audio"](timeline,[25,75],100)
    def test_reuses_verified_tracks_instead_of_scanning_each_cut(self):
        timeline=Timeline()
        self.run_split(timeline)
        self.assertEqual(timeline.reads,1)
        self.assertEqual([len(items) for items in timeline.seek_inputs],[2,3])
        self.assertEqual(timeline.waits,[0.05,0.05])
    def test_unrelated_video_change_stops_processing(self):
        with self.assertRaisesRegex(RuntimeError,"其他轨道"): self.run_split(Timeline(wrong=True))

if __name__=="__main__": unittest.main()
