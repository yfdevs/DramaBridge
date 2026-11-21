import ast
from pathlib import Path
from types import SimpleNamespace as NS
import unittest
from urllib.parse import unquote

source=ast.parse(Path(__file__).with_name("desktop.py").read_text(encoding="utf-8"))
editor=next(n for n in source.body if isinstance(n,ast.ClassDef) and n.name=="Editor")
method=next(n for n in editor.body if isinstance(n,ast.FunctionDef) and n.name=="locate_material")
def tile(name,top,bottom): return NS(Name="material.library.item.id."+name+".apply",BoundingRectangle=NS(top=top,bottom=bottom))
class Library:
    def __init__(self,partial=False,missing=False):
        self.scrolled=0; self.tops=0
        self.partial=partial; self.missing=missing
    def show_materials(self): pass
    def find(self,*args,**kwargs): return NS(BoundingRectangle=NS(bottom=100))
    def named(self,*args,**kwargs): return NS(BoundingRectangle=NS(top=400))
    def material_top(self): self.tops+=1
    def material_page(self):
        if self.missing: return [tile("other.mp4",150,230)]
        return [tile("random-fragment.mp4",130,210),tile("source.mp4",350,430) if self.partial and not self.scrolled else tile("source.mp4",220,300)]
    def scroll_materials(self,direction): self.scrolled+=1
    def search_material(self,*args): raise AssertionError("search must never run")
class MaterialNavigationTests(unittest.TestCase):
    def locate(self,library):
        scope={"unquote":unquote}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[method],type_ignores=[])),"locate","exec"),scope)
        return scope["locate_material"](library,"source.mp4")
    def test_partial_thumbnail_is_scrolled_fully_into_view(self):
        library=Library(partial=True)
        self.assertEqual(self.locate(library).BoundingRectangle.bottom,300)
        self.assertEqual(library.scrolled,1)
    def test_visible_random_position_needs_no_scroll_or_search(self):
        library=Library()
        self.assertTrue(self.locate(library).Name.endswith("source.mp4.apply"))
        self.assertEqual((library.scrolled,library.tops),(0,0))
    def test_missing_material_stops_without_search(self):
        with self.assertRaisesRegex(RuntimeError,"未执行文字搜索"): self.locate(Library(missing=True))
if __name__=="__main__": unittest.main()
