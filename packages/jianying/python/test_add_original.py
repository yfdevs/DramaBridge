"""Prevent bulk material selection from adding every clip to the timeline."""
import ast
from pathlib import Path
from types import SimpleNamespace
import unittest
from urllib.parse import unquote

source=ast.parse(Path(__file__).with_name("desktop.py").read_text(encoding="utf-8"))
editor=next(n for n in source.body if isinstance(n,ast.ClassDef) and n.name=="Editor")
method=next(n for n in editor.body if isinstance(n,ast.FunctionDef) and n.name=="add_original")

class Library:
    def __init__(self):
        self.selected=["first.mp4","fragment.mp4"]
        self.clips=[]
        self.searched=False
        def select(**kwargs): self.selected=["first.mp4"]
        self.tile=SimpleNamespace(Name="material.library.item.id.first.mp4.apply",ControlTypeName="ButtonControl",IsOffscreen=False,BoundingRectangle=SimpleNamespace(top=10,bottom=20,width=lambda:20,height=lambda:10),Click=select,MoveCursorToMyCenter=lambda:None)
    def locate_material(self,filename): return self.tile
    def wait_track_count(self,*args,**kwargs): return self.clips
    def show_materials(self): pass
    def nodes(self): return [(self.tile,0)]
    def tracks(self): return self.clips
    def search_material(self,name): self.searched=True; return self.tile
    def named(self,name,**kwargs):
        if name==self.tile.Name: return self.tile
        if name=="MainMultiTimelineLayout": return SimpleNamespace(BoundingRectangle=SimpleNamespace(top=100))
        if name=="ResourceInfoViewImportBtn":
            def add(**kwargs): self.clips.extend(SimpleNamespace(Name="MTLSVideoP:"+name) for name in self.selected)
            return SimpleNamespace(Click=add,BoundingRectangle=self.tile.BoundingRectangle)
        return next(c for c in self.clips if c.Name==name)

class AddOriginalTests(unittest.TestCase):
    def run_add(self,library):
        scope={"Path":Path,"unquote":unquote,"time":SimpleNamespace(sleep=lambda _:None),"emit":lambda *args,**kwargs:None}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[method],type_ignores=[])),"add_original","exec"),scope)
        scope["add_original"](library,"first.mp4")
    def test_bulk_selection_is_replaced_before_add(self):
        library=Library()
        self.run_add(library)
        self.assertEqual([c.Name for c in library.clips],["MTLSVideoP:first.mp4"])
        self.assertFalse(library.searched)
    def test_existing_timeline_is_not_modified(self):
        library=Library()
        library.clips=[SimpleNamespace(Name="MTLSVideoP:existing.mp4")]
        with self.assertRaisesRegex(RuntimeError,"不是空白"): self.run_add(library)
        self.assertEqual(len(library.clips),1)

if __name__=="__main__": unittest.main()
