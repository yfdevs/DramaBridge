import ast
from pathlib import Path
from types import SimpleNamespace as NS
import sys
import tempfile
import unittest
from unittest.mock import patch
from PIL import Image

source=ast.parse(Path(__file__).with_name("desktop.py").read_text(encoding="utf-8"))
editor=next(n for n in source.body if isinstance(n,ast.ClassDef) and n.name=="Editor")
method=next(n for n in editor.body if isinstance(n,ast.FunctionDef) and n.name=="capture_screenshots")
class Desktop:
    def __init__(self): self.seconds=0; self.window=NS(IsMaximize=lambda:True)
    def foreground(self): pass
    def named(self,name): return NS(Click=lambda **kwargs:None)
    def fit_timeline(self): pass
    def seek(self,seconds,duration): self.seconds=seconds
    def timecode(self,name): return round(self.seconds*30)
    def preview_has_face(self): return True
    def preview_bounds(self): return (0,0,100,100)
    def window_rect(self): return NS(left=0,top=0,right=100,bottom=100)
class ScreenshotTests(unittest.TestCase):
    def capture(self,duplicate):
        desktop=Desktop()
        scope={"Path":Path,"json":__import__("json"),"time":NS(sleep=lambda _:None),"emit":lambda *a,**k:None}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[method],type_ignores=[])),"screenshots","exec"),scope)
        samples=[{"seconds":value,"faceDetected":True} for value in [2,30,60,90]]
        texture=Image.effect_noise((100,100),30).convert("RGB")
        with tempfile.TemporaryDirectory() as output, patch.dict(sys.modules,{"faces":NS(face_timestamps=lambda *a:[])}) , patch("PIL.ImageGrab.grab",side_effect=lambda **kwargs:texture.point(lambda value: max(0,min(255,value//6+(80 if duplicate else round(desktop.seconds*2)))))):
            result=scope["capture_screenshots"](desktop,{"output":output,"screenshot":str(Path(output)/"out.png"),"source":"test.mp4","duration":120,"screenshotCount":4,"zoomSteps":0},samples)
            self.assertEqual(len(result[0]),4)
            self.assertEqual([r["verifiedFrame"] for r in result[1]],[60,900,1800,2700])
            self.assertEqual(len({Path(file).read_bytes() for file in result[0]}),4)
    def test_captures_four_distinct_live_frames(self): self.capture(False)
    def test_repeated_live_preview_stops_instead_of_saving_duplicates(self):
        with self.assertRaisesRegex(RuntimeError,"重复"): self.capture(True)
if __name__=="__main__": unittest.main()
