"""Exercise the native draft state machine without interacting with the desktop."""
import ast
from pathlib import Path
from types import SimpleNamespace
import unittest

source = ast.parse(Path(__file__).with_name("desktop.py").read_text(encoding="utf-8"))
editor = next(node for node in source.body if isinstance(node, ast.ClassDef) and node.name == "Editor")
method = next(node for node in editor.body if isinstance(node, ast.FunctionDef) and node.name == "new_project")

class Clock:
    def __init__(self): self.now = 0
    def monotonic(self): self.now += 0.1; return self.now
    def sleep(self, seconds): self.now += seconds

class Draft:
    def __init__(self, empty=False, confirm=True):
        self.window = SimpleNamespace(AutomationId="MainWindow")
        self.empty, self.confirm, self.pending = empty, confirm, False
        self.actions = []
    def bind(self): pass
    def foreground(self): pass
    def tracks(self): return [] if self.empty else ["existing"]
    def timecode(self, name): return 1 if self.empty else 300
    def nodes(self): return [(SimpleNamespace(Name="mainText: 是否确认新建草稿？"),0)] if self.pending else []
    def file_action(self, name):
        self.actions.append(name)
        if self.confirm: self.pending = True
        else: self.empty = True
    def named(self, name, **kwargs):
        def click(**kwargs):
            self.actions.append(name)
            self.pending, self.empty = False, True
        return SimpleNamespace(Click=click)

class NewProjectTests(unittest.TestCase):
    def run_draft(self, draft):
        namespace = {"time":Clock()}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[method],type_ignores=[])),"new_project","exec"),namespace)
        namespace["new_project"](draft)
    def test_empty_editor_with_one_frame_display_is_reused(self):
        draft = Draft(empty=True)
        self.run_draft(draft)
        self.assertEqual(draft.actions,[])
    def test_existing_project_confirmation_is_handled(self):
        draft = Draft()
        self.run_draft(draft)
        self.assertEqual(draft.actions,["新建草稿","automationconfirmBtn"])
        self.assertTrue(draft.empty)
    def test_no_confirmation_does_not_wait_for_a_missing_button(self):
        draft = Draft(confirm=False)
        self.run_draft(draft)
        self.assertEqual(draft.actions,["新建草稿"])
    def test_pending_confirmation_is_not_opened_twice(self):
        draft = Draft()
        draft.pending = True
        self.run_draft(draft)
        self.assertEqual(draft.actions,["automationconfirmBtn"])

if __name__ == "__main__": unittest.main()
