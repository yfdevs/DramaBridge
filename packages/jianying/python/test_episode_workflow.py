"""Exercise four independent draft lifecycles with shared material inputs."""
import ast
from pathlib import Path
from types import SimpleNamespace as NS
import unittest
from unittest.mock import patch

source=ast.parse(Path(__file__).with_name("desktop.py").read_text(encoding="utf-8"))
editor=next(n for n in source.body if isinstance(n,ast.ClassDef) and n.name=="Editor")
method=next(n for n in editor.body if isinstance(n,ast.FunctionDef) and n.name=="run")
class Drafts:
    def __init__(self): self.created=0; self.imports=[]; self.sources=[]; self.window=NS(NativeWindowHandle=1)
    def new_project(self): self.created+=1
    def import_files(self,files): self.imports.append(list(files))
    def verify_import(self,files): return {"verifiedMaterials":len(files)}
    def add_original(self,source): self.sources.append(source)
    def timecode(self,name): return 3000
    def detach(self,filename): self.detached=filename
    def split_timeline(self,filename,cuts,duration):
        if filename!=self.detached: raise RuntimeError("wrong episode")
        return {"videoClips":2,"audioClips":1}
    def split_audio(self,*args): pass
    def enlarge_timeline(self): pass
    def compact_track_height(self): pass
    def copy_video_layers(self,request): return 10,3
    def recognize_subtitles(self): return 20
    def video_below_subtitles(self): pass
    def repeat_audio(self,request): return 24,4
    def add_effects(self,duration): return 2,[]
    def reveal_tracks(self): pass
    def show_materials(self): pass
    def foreground(self): pass
    def capture_screenshots(self,request):
        return [str(Path(request["screenshotDirectory"])/f"{i}.png") for i in range(4)],[{"faceDetected":True}]*4
class EpisodeWorkflowTests(unittest.TestCase):
    def test_all_four_sources_get_independent_processing_and_shuffled_imports(self):
        scope={"Path":Path,"time":NS(sleep=lambda _:None),"ctypes":NS(WinDLL=lambda _:NS(ShowWindow=lambda *args:None)),"wintypes":NS(HWND=lambda value:value),"emit":lambda *args,**kwargs:None}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[method],type_ignores=[])),"run","exec"),scope)
        desktop=Drafts()
        fragments=[f"fragment-{i}.mp4" for i in range(8)]
        turns=[0]
        def shuffle(items):
            turns[0]+=1
            items[:]=items[turns[0]:]+items[:turns[0]]
        with patch("random.SystemRandom",return_value=NS(shuffle=shuffle)):
            results=[scope["run"](desktop,{"source":f"episode-{episode}.mp4","fragments":fragments,"duration":100,"cutSeconds":[40],"base":[{}],"audio":[{"start":0}],"screenshotDirectory":f"screenshots/episode-{episode}"}) for episode in range(1,5)]
        self.assertEqual(desktop.created,4)
        self.assertEqual(desktop.sources,[f"episode-{i}.mp4" for i in range(1,5)])
        self.assertEqual(sum(len(result["screenshots"]) for result in results),16)
        for episode,result in enumerate(results,1):
            self.assertEqual(set(result["importOrder"]),set(fragments+[f"episode-{episode}.mp4"]))
            self.assertNotEqual(result["importOrder"],[f"episode-{episode}.mp4"]+fragments)
            self.assertTrue(all(f"episode-{episode}" in file for file in result["screenshots"]))
        self.assertEqual(fragments,[f"fragment-{i}.mp4" for i in range(8)])
if __name__=="__main__": unittest.main()
