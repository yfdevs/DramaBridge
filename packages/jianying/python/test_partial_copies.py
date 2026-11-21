import ast
from pathlib import Path
from types import SimpleNamespace as NS
import unittest

source=ast.parse(Path(__file__).with_name("desktop.py").read_text(encoding="utf-8"))
error=next(n for n in source.body if isinstance(n,ast.ClassDef) and n.name=="TrackCountMismatch")
editor=next(n for n in source.body if isinstance(n,ast.ClassDef) and n.name=="Editor")
method=next(n for n in editor.body if isinstance(n,ast.FunctionDef) and n.name=="repeat_audio")
scope={"emit":lambda *args,**kwargs:None}
exec(compile(ast.fix_missing_locations(ast.Module(body=[error,method],type_ignores=[])),"copies","exec"),scope)
class Audio:
    def __init__(self): self.copies=0; self.warnings=[]
    def disable_snap(self): pass
    def tracks(self):
        return [NS(Name="MTLSAudioP:a",Element=NS(GetRuntimeId=lambda index=index:[index]),BoundingRectangle=NS(left=index,top=0)) for index in range(23)]
    def copy_at(self,*args,**kwargs):
        self.copies+=1
        raise scope["TrackCountMismatch"](26,23)
    def warn(self,message): self.warnings.append(message)
class PartialCopyTests(unittest.TestCase):
    def test_copy_count_mismatch_keeps_actual_clips_and_continues(self):
        audio=Audio()
        result=scope["repeat_audio"](audio,{"audio":[{}]*23,"audioCopies":[{"sourceIndex":0,"seconds":10}]*5,"duration":100})
        self.assertEqual(result,(23,1))
        self.assertEqual(audio.copies,1)
        self.assertEqual(len(audio.warnings),1)
        self.assertIn("实际 23",audio.warnings[0])
    def test_original_audio_mismatch_is_still_protected(self):
        audio=Audio()
        with self.assertRaisesRegex(RuntimeError,"原始分离音频"):
            scope["repeat_audio"](audio,{"audio":[{}]*24,"audioCopies":[],"duration":100})
        self.assertEqual(audio.copies,0)
if __name__=="__main__": unittest.main()
