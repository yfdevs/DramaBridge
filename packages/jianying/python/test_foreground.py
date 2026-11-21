"""Verify exact-window activation and fail closed on a locked desktop."""
import ast
from pathlib import Path
from types import SimpleNamespace
import unittest
from ctypes import wintypes, POINTER

source=ast.parse(Path(__file__).with_name("desktop.py").read_text(encoding="utf-8"))
editor=next(node for node in source.body if isinstance(node,ast.ClassDef) and node.name=="Editor")
method=next(node for node in editor.body if isinstance(node,ast.FunctionDef) and node.name=="foreground")
class Call:
    def __init__(self,fn): self.fn=fn
    def __call__(self,*args): return self.fn(*args)
class ForegroundTests(unittest.TestCase):
    def run_activation(self,current,locked=False):
        actions=[]
        window=[current]
        def activate(handle): actions.append(handle.value);window[0]=handle.value
        user=SimpleNamespace(GetForegroundWindow=Call(lambda:window[0]),GetWindowThreadProcessId=Call(lambda *args:7),
            IsIconic=lambda handle:False,BringWindowToTop=lambda handle:None,SetForegroundWindow=activate)
        def unlocked():
            if locked: raise RuntimeError("桌面已锁定")
        draft=SimpleNamespace(hwnd=100,pid=7,require_unlocked_desktop=unlocked)
        namespace={"ctypes":SimpleNamespace(WinDLL=lambda *args,**kwargs:user, POINTER=POINTER),"wintypes":wintypes,"time":SimpleNamespace(sleep=lambda seconds:None)}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[method],type_ignores=[])),"foreground","exec"),namespace)
        namespace["foreground"](draft)
        return actions
    def test_other_window_in_same_process_is_not_accepted(self):
        self.assertEqual(self.run_activation(200),[100])
    def test_correct_window_requires_no_activation(self):
        self.assertEqual(self.run_activation(100),[])
    def test_locked_desktop_blocks_input_before_activation(self):
        with self.assertRaisesRegex(RuntimeError,"锁定"): self.run_activation(200,locked=True)
if __name__=="__main__": unittest.main()
