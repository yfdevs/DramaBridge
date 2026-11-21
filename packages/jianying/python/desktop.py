"""DramaBridge's Windows executor for the traditional Jianying editor.

Local JSON-lines worker; no cloud APIs, code injection or private token handling.
"""
from __future__ import annotations
import argparse
import ctypes
from ctypes import wintypes
import json
import os
import re
from pathlib import Path
import sys
import time
import math
from functools import wraps
from comtypes import COMError
from urllib.parse import unquote

class TrackCountMismatch(RuntimeError):
    def __init__(self, expected, actual):
        self.expected, self.actual = expected, actual
        super().__init__(f"轨道片段核对失败：预期 {expected} 段，读取到 {actual} 段")


def emit(kind, **values):
    print(json.dumps({"kind": kind, **values}, ensure_ascii=False), flush=True)

def retry_read(function):
    """Only retry UIA reads, never replay a paste, drag, split, or other edit."""
    @wraps(function)
    def execute(*args,**kwargs):
        for attempt in range(8):
            try:
                return function(*args,**kwargs)
            except COMError:
                if attempt==7:
                    raise
                time.sleep(0.15)
    return execute

def process_path(pid):
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.restype = wintypes.HANDLE
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        return ""
    try:
        size = wintypes.DWORD(32768)
        text = ctypes.create_unicode_buffer(size.value)
        kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
        return text.value if kernel.QueryFullProcessImageNameW(handle, 0, text, ctypes.byref(size)) else ""
    finally:
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle(handle)

class SnapshotControl:
    """Properties are cached only for one fresh UI query, never across edits."""
    def __init__(self, auto, element):
        self.auto = auto
        self.control = auto.Control.CreateControlFromElement(element)
        self.Name = element.CachedName
        self.AutomationId = element.CachedAutomationId
        self.ControlTypeName = auto.ControlTypeNames[element.CachedControlType]
        self.IsOffscreen = element.CachedIsOffscreen
        rect = element.CachedBoundingRectangle
        self.BoundingRectangle = auto.Rect(rect.left, rect.top, rect.right, rect.bottom)

    def __getattr__(self, name):
        return getattr(self.control, name)

    def Click(self, waitTime=0.2, **options):
        rect = self.BoundingRectangle
        self.auto.Click((rect.left+rect.right)//2,(rect.top+rect.bottom)//2,waitTime=waitTime)

    def RightClick(self,waitTime=0.2,**options):
        rect = self.BoundingRectangle
        self.auto.RightClick((rect.left+rect.right)//2,(rect.top+rect.bottom)//2,waitTime=waitTime)

    def DoubleClick(self,waitTime=0.3,**options):
        rect = self.BoundingRectangle
        x,y = (rect.left+rect.right)//2,(rect.top+rect.bottom)//2
        self.auto.Click(x,y,waitTime=0.08)
        self.auto.Click(x,y,waitTime=waitTime)

    def MoveCursorToMyCenter(self,**options):
        rect = self.BoundingRectangle
        self.auto.SetCursorPos((rect.left+rect.right)//2,(rect.top+rect.bottom)//2)

class Editor:
    def __init__(self):
        import uiautomation as auto
        self.auto = auto
        auto.SetGlobalSearchTimeout(1)
        auto.uiautomation.MAX_MOVE_SECOND = 0.08
        self.window = None
        self.pid = None
        self.hwnd = None
        self.split_control = None
        self.client = auto.uiautomation._AutomationClient.instance().IUIAutomation
        self.cache = self.client.CreateCacheRequest()
        for prop in (auto.PropertyId.NameProperty, auto.PropertyId.AutomationIdProperty,
                     auto.PropertyId.ControlTypeProperty, auto.PropertyId.IsOffscreenProperty,
                     auto.PropertyId.BoundingRectangleProperty):
            self.cache.AddProperty(prop)

    @retry_read
    def windows(self):
        result = []
        for control in self.auto.GetRootControl().GetChildren():
            try:
                if Path(process_path(control.ProcessId)).name.lower()=="jianyingpro.exe":
                    result.append(control)
            except Exception:
                continue
        return result

    @retry_read
    def bind(self):
        candidates = self.windows()
        editors = [control for control in candidates if control.AutomationId in ("MainWindow", "HomeWindow")]
        if len(editors) != 1:
            raise RuntimeError(f"需要唯一剪映编辑窗口，当前找到 {len(editors)} 个")
        self.window = editors[0]
        self.pid = self.window.ProcessId
        self.hwnd = self.window.NativeWindowHandle
        return self.window

    def nodes(self, root=None, limit=2500):
        root = root or self.window
        yield root, 0
        for attempt in range(6):
            try:
                elements = root.Element.FindAllBuildCache(4, self.client.CreateTrueCondition(), self.cache)
                break
            except Exception:
                if attempt==5:
                    raise
                time.sleep(0.15)
        for index in range(min(elements.Length, limit-1)):
            try:
                yield SnapshotControl(self.auto, elements.GetElement(index)), 1
            except Exception:
                continue

    def inspect(self):
        self.bind()
        result = []
        for control, depth in self.nodes():
            name, aid = control.Name, control.AutomationId
            if name or aid or control.ControlTypeName in ("ButtonControl", "EditControl"):
                rect = control.BoundingRectangle
                result.append({"depth": depth, "name": name, "id": aid, "type": control.ControlTypeName,
                               "rect": [rect.left, rect.top, rect.right, rect.bottom], "offscreen": control.IsOffscreen})
        return {"pid": self.pid, "window": self.window.Name, "nodes": result}

    @retry_read
    def find(self, predicate, timeout=8, root=None, popups=False):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            roots = [root or self.window]
            if popups:
                roots.extend(control for control in self.auto.GetRootControl().GetChildren()
                             if control.ProcessId == self.pid and control.NativeWindowHandle != self.window.NativeWindowHandle)
            for item in roots:
                for control, _ in self.nodes(item):
                    try:
                        if predicate(control) and not control.IsOffscreen:
                            return control
                    except Exception:
                        pass
            time.sleep(0.15)
        raise RuntimeError("剪映控件等待超时")

    @retry_read
    def named(self, name, **options):
        deadline = time.monotonic()+options.get("timeout", 8)
        condition = self.client.CreatePropertyCondition(self.auto.PropertyId.NameProperty, name)
        while time.monotonic()<deadline:
            roots = [options.get("root") or self.window]
            if options.get("popups"):
                roots += [control for control in self.windows() if control.NativeWindowHandle != self.window.NativeWindowHandle]
            for root in roots:
                try:
                    element = root.Element.FindFirst(4, condition)
                    if element:
                        control = SnapshotControl(self.auto,element.BuildUpdatedCache(self.cache))
                        if not control.IsOffscreen:
                            return control
                except Exception:
                    continue
            time.sleep(0.1)
        raise RuntimeError(f"剪映控件等待超时：{name}")

    @staticmethod
    def require_unlocked_desktop():
        user = ctypes.WinDLL("user32", use_last_error=True)
        user.OpenInputDesktop.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        user.OpenInputDesktop.restype = wintypes.HANDLE
        user.GetUserObjectInformationW.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
        user.CloseDesktop.argtypes = [wintypes.HANDLE]
        desktop = user.OpenInputDesktop(0, False, 1)  # DESKTOP_READOBJECTS; never switch desktops.
        if not desktop:
            raise RuntimeError("无法访问交互桌面，请解锁 Windows 并保持远程桌面连接后重试")
        try:
            name = ctypes.create_unicode_buffer(256)
            needed = wintypes.DWORD()
            if not user.GetUserObjectInformationW(desktop, 2, name, ctypes.sizeof(name), ctypes.byref(needed)):
                raise RuntimeError("无法核对当前交互桌面，已停止以避免无效点击")
            if name.value.lower() != "default":
                raise RuntimeError("当前桌面已锁定或处于安全界面，请解锁 Windows 后重试")
        finally:
            user.CloseDesktop(desktop)

    def foreground(self):
        self.require_unlocked_desktop()
        user = ctypes.WinDLL("user32", use_last_error=True)
        user.GetForegroundWindow.restype = wintypes.HWND
        user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        handle = wintypes.HWND(self.hwnd)
        foreground = user.GetForegroundWindow()
        # Home, editor and auxiliary windows can all belong to the same process.
        # Coordinate input must target this exact window, not merely its process.
        if foreground == self.hwnd and not user.IsIconic(handle):
            return
        if user.IsIconic(handle):
            user.ShowWindow(handle, 9)
        user.BringWindowToTop(handle)
        user.SetForegroundWindow(handle)
        time.sleep(0.1)
        foreground = user.GetForegroundWindow()
        if foreground != self.hwnd:
            kernel = ctypes.WinDLL("kernel32")
            current_thread = kernel.GetCurrentThreadId()
            foreground_thread = user.GetWindowThreadProcessId(foreground, None)
            attached = bool(user.AttachThreadInput(current_thread, foreground_thread, True))
            try:
                user.BringWindowToTop(handle)
                user.SetForegroundWindow(handle)
                time.sleep(0.3)
            finally:
                if attached:
                    user.AttachThreadInput(current_thread, foreground_thread, False)
        if user.GetForegroundWindow() != self.hwnd:
            self.auto.SwitchToThisWindow(self.hwnd)
            time.sleep(0.2)
        if user.GetForegroundWindow() != self.hwnd:
            raise RuntimeError("无法激活目标剪映窗口，已停止以避免误操作其他窗口")

    def invoke(self, control):
        try:
            pattern = control.GetPattern(self.auto.PatternId.InvokePattern)
            if pattern:
                pattern.Invoke()
                return
        except Exception:
            pass
        control.Click(waitTime=0.2)

    @retry_read
    def tracks(self):
        return [control for control, _ in self.nodes() if control.Name.startswith("MTLS")]

    @retry_read
    def window_rect(self):
        return self.window.BoundingRectangle

    def wait_track_count(self, prefix, expected, timeout=12):
        deadline = time.monotonic()+timeout
        actual = 0
        while time.monotonic()<deadline:
            tracks = self.tracks()
            actual = sum(c.Name.startswith(prefix) for c in tracks)
            if actual==expected:
                return tracks
            time.sleep(0.15)
        raise TrackCountMismatch(expected,actual)

    def click_clip(self, control, wait_time=0.15):
        rect = control.BoundingRectangle
        timeline = self.named("MainMultiTimelineLayout").BoundingRectangle
        window = self.window_rect()
        left, right = max(rect.left,timeline.left+175), min(rect.right,window.right-35)
        if right-left<5 or rect.top<timeline.top+35 or rect.bottom>window.bottom-10:
            raise RuntimeError("目标片段不在可操作区域，请保持时间线适应窗口")
        self.auto.Click((left+right)//2,(rect.top+rect.bottom)//2,waitTime=wait_time)

    def detach(self, filename):
        expected = f"MTLSVideoP:{filename}"
        for attempt in range(2):
            self.foreground()
            tracks = self.tracks()
            audios = [c for c in tracks if c.Name.startswith("MTLSAudioP:")]
            videos = [c for c in tracks if c.Name.startswith("MTLSVideoP:")]
            if len(videos)!=1 or videos[0].Name!=expected:
                raise RuntimeError("分离音频前当前集视频状态不符，已停止")
            if len(audios)==1:
                return {"audioTrack":audios[0].Name,"tracks":[c.Name for c in tracks]}
            if audios:
                raise RuntimeError("分离音频时检测到多条音频，停止以避免重复操作")
            emit("progress",message="定位当前集视频轨道" if attempt==0 else "未生成音轨，核对后重新执行分离音频")
            clip = self.named(expected)
            self.click_clip(clip)
            if attempt==0:
                # Verified against the installed Jianying 11.6 context menu.
                emit("progress",message="使用剪映原生快捷键 X 分离音频")
                self.auto.SendKeys("x",charMode=False,waitTime=0.2)
            else:
                clip.RightClick(waitTime=0.2)
                emit("progress",message="快捷键未生成音轨，改用右键分离音频")
                menu = self.named("分离音频",popups=True)
                # Qt exposes InvokePattern but may silently ignore Invoke().
                menu.Click(waitTime=0.3)
            emit("progress",message="验证独立音频轨道")
            deadline = time.monotonic()+8
            while time.monotonic()<deadline:
                tracks = self.tracks()
                audios = [c for c in tracks if c.Name.startswith("MTLSAudioP:")]
                if len(audios)==1:
                    return {"audioTrack":audios[0].Name,"tracks":[c.Name for c in tracks]}
                if len(audios)>1:
                    raise RuntimeError("分离音频生成了多条音频，已停止")
                time.sleep(0.15)
        raise RuntimeError("分离音频未生成独立音轨，可能被鼠标操作或弹窗打断；请停止操作剪映后重试")

    @retry_read
    def timecode(self, name):
        parent = self.named(name)
        for control, _ in self.nodes(parent):
            if re.fullmatch(r"\d{2}:\d{2}:\d{2}:\d{2}", control.Name):
                h, m, s, frame = map(int, control.Name.split(":"))
                return ((h*60+m)*60+s)*30+frame
        raise RuntimeError("无法读取剪映播放时间码")

    def seek(self, seconds, duration, tracks=None):
        clips = [control for control in (self.tracks() if tracks is None else tracks) if control.Name.startswith("MTLSVideoP:")]
        left = min(control.BoundingRectangle.left for control in clips)
        right = max(control.BoundingRectangle.right for control in clips)
        ruler = self.named("TimeLineRulerAdsorb").BoundingRectangle
        x = round(left+(right-left)*seconds/duration)
        window = self.window_rect()
        if not window.left<x<window.right:
            raise RuntimeError("目标时间超出可见时间线，请先适应窗口")
        self.auto.Click(x, (ruler.top+ruler.bottom)//2, waitTime=0.08)
        target = round(seconds*30)
        tolerance = math.ceil(duration/(right-left)*30)+3
        deadline = time.monotonic()+1.5
        while abs(target-self.timecode("currentProgress"))>tolerance and time.monotonic()<deadline:
            time.sleep(0.1)
        for _ in range(3):
            difference = target-self.timecode("currentProgress")
            if difference == 0:
                return
            if abs(difference)>300:
                raise RuntimeError(f"播放定位误差过大：{difference} 帧")
            key = "Right" if difference>0 else "Left"
            self.auto.SendKeys("{"+key+" "+str(abs(difference))+"}", interval=0.001, waitTime=0.03)
            deadline = time.monotonic()+0.7
            while self.timecode("currentProgress")!=target and time.monotonic()<deadline:
                time.sleep(0.05)
        if self.timecode("currentProgress") != target:
            raise RuntimeError("播放头未准确定位，停止以避免错误分割")

    def split_timeline(self, filename, cut_seconds, duration):
        self.foreground()
        self.named("quicklyAdjustZoomFit").Click(waitTime=0.25)
        tracks = self.tracks()
        audio_count = sum("Audio" in control.Name for control in tracks)
        if audio_count != 1:
            raise RuntimeError("分割前必须有一条完整的独立音频轨道")
        for index, seconds in enumerate(cut_seconds):
            self.seek(seconds, duration, tracks=tracks)
            clips = [control for control in tracks if control.Name == f"MTLSVideoP:{filename}"]
            left = min(control.BoundingRectangle.left for control in clips)
            right = max(control.BoundingRectangle.right for control in clips)
            x = left+(right-left)*seconds/duration
            selected = next((control for control in clips if control.BoundingRectangle.left <= x < control.BoundingRectangle.right), None)
            if selected is None:
                raise RuntimeError("切点处未找到当前集视频片段")
            self.click_clip(selected,wait_time=0.05)
            self.split_button().Click(waitTime=0.05)
            tracks = self.wait_track_count(f"MTLSVideoP:{filename}",index+2)
            actual = sum(control.Name == f"MTLSVideoP:{filename}" for control in tracks)
            if actual != index+2 or sum("Audio" in control.Name for control in tracks) != audio_count:
                raise RuntimeError("分割结果与预期不符，已停止")
            if index%10==0 or index==len(cut_seconds)-1:
                emit("progress", message=f"当前集主轨已分割 {index+1}/{len(cut_seconds)} 处")
        return {"videoClips": len(cut_seconds)+1, "audioClips": audio_count, "totalFrames": self.timecode("totalProgress")}

    def split_button(self):
        if self.split_control is not None:
            try:
                if not self.split_control.IsOffscreen:
                    return SnapshotControl(self.auto,self.split_control.Element.BuildUpdatedCache(self.cache))
            except Exception:
                self.split_control = None
        redo = self.find(lambda control: control.AutomationId == "editor.redo")
        rect = redo.BoundingRectangle
        buttons = [control for control, _ in self.nodes() if control.ControlTypeName == "ButtonControl"
                   and not control.Name and abs(control.BoundingRectangle.top-rect.top)<2
                   and control.BoundingRectangle.left > rect.right]
        if not buttons:
            raise RuntimeError("无法定位时间线分割工具")
        chosen = min(buttons, key=lambda control: control.BoundingRectangle.left)
        self.split_control = chosen.control
        return chosen

    def split_audio(self, cut_seconds, duration):
        self.foreground()
        tracks = self.tracks()
        for index, seconds in enumerate(cut_seconds):
            self.seek(seconds, duration, tracks=tracks)
            clips = [control for control in tracks if control.Name.startswith("MTLSAudioP:")]
            left = min(c.BoundingRectangle.left for c in clips)
            right = max(c.BoundingRectangle.right for c in clips)
            x = left+(right-left)*seconds/duration
            selected = next((c for c in clips if c.BoundingRectangle.left<=x<c.BoundingRectangle.right), None)
            if selected is None:
                raise RuntimeError("音频切点处没有找到片段")
            self.click_clip(selected,wait_time=0.05)
            self.split_button().Click(waitTime=0.05)
            updated = self.wait_track_count("MTLSAudioP:",index+2)
            # Only the selected audio may change; video, subtitle and effect clips stay intact.
            before = sorted(c.Name for c in tracks if not c.Name.startswith("MTLSAudioP:"))
            after = sorted(c.Name for c in updated if not c.Name.startswith("MTLSAudioP:"))
            if before!=after:
                raise RuntimeError("音频分割影响了其他轨道，已停止")
            tracks = updated
            actual = sum(c.Name.startswith("MTLSAudioP:") for c in tracks)
            if actual != index+2:
                raise RuntimeError("音频分割数量不符，停止以避免误切其他轨道")
            if index%10==0 or index==len(cut_seconds)-1:
                emit("progress", message=f"音频已分割 {index+1}/{len(cut_seconds)} 处")

    def distribute(self, prefix, plan):
        """Move clips vertically, keeping their timeline positions and durations."""
        self.foreground()
        self.disable_main_magnet()
        kind = "视频" if "Video" in prefix else "音频"
        initial = sorted([c for c in self.tracks() if c.Name.startswith(prefix)], key=lambda c:c.BoundingRectangle.left)
        if len(initial)!=len(plan):
            raise RuntimeError(f"{kind}排布计划与片段数量不一致")
        bounds = [(c.BoundingRectangle.left,c.BoundingRectangle.right) for c in initial]
        for index, item in enumerate(plan):
            row = item["track"]
            if row==0:
                continue
            clips = sorted([c for c in self.tracks() if c.Name.startswith(prefix)], key=lambda c:c.BoundingRectangle.left)
            selected = clips[index]
            rect = selected.BoundingRectangle
            base = clips[0].BoundingRectangle
            previous = next((i for i in range(index) if plan[i]["track"]==row), None)
            if previous is not None:
                target = clips[previous].BoundingRectangle
                target_y = (target.top+target.bottom)//2
            elif "Video" in prefix:
                target_y = min(c.BoundingRectangle.top for c in clips)-25
            else:
                target_y = max(c.BoundingRectangle.bottom for c in clips)+25
            if target_y < self.named("MainMultiTimelineLayout").BoundingRectangle.top+50 or target_y>self.window_rect().bottom-45:
                raise RuntimeError("时间线空间不足以显示三条轨道，请增大时间线区域")
            x = (rect.left+rect.right)//2
            self.drag(x,(rect.top+rect.bottom)//2,x,target_y)
            moved = sorted([c for c in self.tracks() if c.Name.startswith(prefix)], key=lambda c:c.BoundingRectangle.left)
            if len(moved)!=len(bounds) or any(abs(c.BoundingRectangle.left-l)>2 or abs(c.BoundingRectangle.right-r)>2 for c,(l,r) in zip(moved,bounds)):
                raise RuntimeError(f"{kind}跨轨移动改变了时间位置，已停止")
            actual = moved[index].BoundingRectangle
            if actual.top==rect.top:
                raise RuntimeError(f"{kind}片段未移动到指定轨道")
            if index%10==0:
                emit("progress",message=f"正在分散{kind}轨道 {index+1}/{len(plan)}")
        clips = [c for c in self.tracks() if c.Name.startswith(prefix)]
        rows = len(set(c.BoundingRectangle.top for c in clips))
        if rows!=min(3,len(plan)):
            raise RuntimeError(f"{kind}未形成预期的三条轨道")
        return rows

    def warn(self, message):
        if not hasattr(self,"workflow_warnings"):
            self.workflow_warnings = []
        self.workflow_warnings.append(message)
        emit("progress",message=message)

    def copy_at(self, control, seconds, duration, prefix, tracks=None):
        # Clipboard copy and seeking do not alter clip identities or geometry.
        tracks = self.tracks() if tracks is None else tracks
        before = [c for c in tracks if c.Name.startswith(prefix)]
        identities = {tuple(c.Element.GetRuntimeId()) for c in before}
        self.click_clip(control,wait_time=0.05)
        self.auto.SendKeys("{Ctrl}c",charMode=False,waitTime=0.05)
        self.seek(seconds,duration,tracks=tracks)
        self.auto.SendKeys("{Ctrl}v",charMode=False,waitTime=0.05)
        tracks = self.wait_track_count(prefix,len(before)+1)
        candidates = [c for c in tracks if c.Name.startswith(prefix)
                      and tuple(c.Element.GetRuntimeId()) not in identities]
        if len(candidates)!=1:
            raise RuntimeError("无法唯一核对新复制的视频或音频块")
        return candidates[0]

    def trim_copy(self, control, seconds, pixels_per_second):
        original = control.BoundingRectangle
        desired = min(original.width(),max(8,round(seconds*pixels_per_second)))
        if original.width()>desired+2:
            self.drag(original.right-1,(original.top+original.bottom)//2,
                      original.left+desired,(original.top+original.bottom)//2)
            time.sleep(0.08)
        if abs(control.BoundingRectangle.width()-desired)>3:
            raise RuntimeError("复制块未按计划裁短，已停止以避免留下等长片段")

    def copy_video_layers(self, request):
        self.disable_main_magnet()
        self.disable_snap()
        anchors = {}
        for index, item in enumerate(request["overlays"]):
            tracks = self.tracks()
            videos = [c for c in tracks if c.Name.startswith("MTLSVideoP:")]
            base_y = max(c.BoundingRectangle.top for c in videos)
            base = sorted([c for c in videos if c.BoundingRectangle.top==base_y],key=lambda c:c.BoundingRectangle.left)
            if len(base)!=len(request["base"]):
                raise RuntimeError("主视频轨道发生变化，停止复制")
            source_index = item["sourceIndex"]
            try:
                copied = self.copy_at(base[source_index],request["base"][source_index]["start"],request["duration"],"MTLSVideoP:",tracks=tracks)
            except TrackCountMismatch as error:
                self.warn(f"复制视频块数量有偏差（预期 {error.expected}，实际 {error.actual}），保留现有视频块并继续后续处理")
                break
            live = copied.control
            left = min(c.BoundingRectangle.left for c in base)
            right = max(c.BoundingRectangle.right for c in base)
            pixels_per_second = (right-left)/request["duration"]
            self.trim_copy(live, item["duration"], pixels_per_second)
            rect = live.BoundingRectangle
            if item["track"] not in anchors:
                other_y = [control.BoundingRectangle.top for control in anchors.values()]
                if other_y and any(abs(rect.top-y)<3 for y in other_y):
                    target_y = min(c.BoundingRectangle.top for c in self.tracks() if c.Name.startswith("MTLSVideoP:"))-24
                else:
                    target_y = (rect.top+rect.bottom)//2
                anchors[item["track"]] = live
            else:
                target = anchors[item["track"]].BoundingRectangle
                target_y = (target.top+target.bottom)//2
            target_x = round(left+item["seconds"]*pixels_per_second+rect.width()/2)
            self.drag((rect.left+rect.right)//2,(rect.top+rect.bottom)//2,target_x,target_y)
            time.sleep(0.08)
            after = live.BoundingRectangle
            if abs(after.width()-rect.width())>3:
                raise RuntimeError("复制视频块移动时发生意外裁切，已停止")
            emit("progress",message=f"已添加上方复制视频块 {index+1}/{len(request['overlays'])}")
        videos = [c for c in self.tracks() if c.Name.startswith("MTLSVideoP:")]
        self.normalize_video_rows()
        videos = [c for c in self.tracks() if c.Name.startswith("MTLSVideoP:")]
        rows = len(set(c.BoundingRectangle.top for c in videos))
        if rows!=3:
            self.warn(f"视频轨道实际为 {rows} 轨，保留现有排布继续处理")
        return len(videos),rows

    def video_below_subtitles(self):
        """Keep both overlay rows between the subtitle row and the base video."""
        self.fit_timeline()
        anchor = None
        for _ in range(64):
            tracks = self.tracks()
            subtitles = [c.BoundingRectangle for c in tracks if c.Name.startswith("MTLSTextP:")]
            if not subtitles:
                raise RuntimeError("无法定位字幕轨道，停止以避免视频块盖到字幕上方")
            subtitle_top = min(r.top for r in subtitles)
            subtitle_bottom = max(r.bottom for r in subtitles)
            above = [c for c in tracks if c.Name.startswith("MTLSVideoP:") and c.BoundingRectangle.top<subtitle_top]
            if not above:
                return
            clip = above[0]
            rect = clip.BoundingRectangle
            if anchor is None:
                target_y = subtitle_bottom+2
            else:
                target = anchor.BoundingRectangle
                target_y = (target.top+target.bottom)//2
            self.drag((rect.left+rect.right)//2,(rect.top+rect.bottom)//2,(rect.left+rect.right)//2,target_y)
            if anchor is None:
                anchor = clip.control
            time.sleep(0.08)
        raise RuntimeError("视频块移动到字幕下方未完成")

    def normalize_video_rows(self):
        for _ in range(24):
            videos = [c for c in self.tracks() if c.Name.startswith("MTLSVideoP:")]
            base_y = max(c.BoundingRectangle.top for c in videos)
            groups = {}
            for clip in videos:
                if clip.BoundingRectangle.top!=base_y:
                    groups.setdefault(clip.BoundingRectangle.top,[]).append(clip)
            if len(groups)<=2:
                return
            keep = sorted(groups,key=lambda y:len(groups[y]),reverse=True)[:2]
            extra_y = next(y for y in groups if y not in keep)
            clip = groups[extra_y][0]
            rect = clip.BoundingRectangle
            target_y = next((y for y in keep if all(rect.right<=c.BoundingRectangle.left or rect.left>=c.BoundingRectangle.right for c in groups[y])),None)
            if target_y is None:
                raise RuntimeError("上方复制块发生拥挤，无法整理到两条视频轨")
            target = groups[target_y][0].BoundingRectangle
            self.drag((rect.left+rect.right)//2,(rect.top+rect.bottom)//2,
                      (rect.left+rect.right)//2,(target.top+target.bottom)//2)
            time.sleep(0.08)
        raise RuntimeError("上方视频轨道整理未完成")

    def repeat_audio(self, request):
        self.disable_snap()
        original_clips = sorted([c for c in self.tracks() if c.Name.startswith("MTLSAudioP:")],key=lambda c:c.BoundingRectangle.left)
        if len(original_clips)!=len(request["audio"]):
            raise RuntimeError("原始分离音频轨道数量不符合计划")
        original_ids = [tuple(c.Element.GetRuntimeId()) for c in original_clips]
        pixels_per_second = None
        if any("duration" in item for item in request["audioCopies"]):
            pixels_per_second = (max(c.BoundingRectangle.right for c in original_clips)-min(c.BoundingRectangle.left for c in original_clips))/request["duration"]
        for index,item in enumerate(request["audioCopies"]):
            tracks = self.tracks()
            audios = [c for c in tracks if c.Name.startswith("MTLSAudioP:")]
            originals = {tuple(clip.Element.GetRuntimeId()):clip for clip in audios if tuple(clip.Element.GetRuntimeId()) in original_ids}
            if len(originals)!=len(original_ids):
                raise RuntimeError("原始分离音频轨道不完整，停止复制")
            try:
                copied = self.copy_at(originals[original_ids[item["sourceIndex"]]],item["seconds"],request["duration"],"MTLSAudioP:",tracks=tracks)
                if "duration" in item:
                    self.trim_copy(copied.control, item["duration"], pixels_per_second)

            except TrackCountMismatch as error:
                self.warn(f"重复音频数量有偏差（预期 {error.expected}，实际 {error.actual}），保留现有音频并继续特效和截图")
                break
            emit("progress",message=f"已添加交错重复音频 {index+1}/{len(request['audioCopies'])}")
        audios = [c for c in self.tracks() if c.Name.startswith("MTLSAudioP:")]
        return len(audios),len(set(c.BoundingRectangle.top for c in audios))

    def drag(self, x1, y1, x2, y2):
        self.auto.SetCursorPos(x1,y1)
        time.sleep(0.04)
        self.auto.PressMouse(x1,y1,waitTime=0.06)
        try:
            # Keep a continuous mouse path so Qt enters drag mode, without a
            # fixed 20-step delay for every short crop and vertical move.
            steps = max(8,min(16,math.ceil(max(abs(x2-x1),abs(y2-y1))/80)))
            for step in range(1,steps+1):
                self.auto.SetCursorPos(round(x1+(x2-x1)*step/steps),round(y1+(y2-y1)*step/steps))
                time.sleep(0.01)
        finally:
            self.auto.ReleaseMouse(waitTime=0.12)

    def disable_main_magnet(self):
        from PIL import ImageGrab
        control = self.named("mainTrackAdsorb")
        rect = control.BoundingRectangle
        def active():
            image = ImageGrab.grab(bbox=(rect.left, rect.top, rect.right, rect.bottom)).convert("RGB")
            return sum(g > 110 and b > 110 and r < g*0.65 for r,g,b in image.getdata()) > 4
        if active():
            control.Click(waitTime=0.15)
        if active():
            raise RuntimeError("无法关闭主轨磁吸，停止以避免跨轨移动改变片段时间")

    def compact_track_height(self):
        self.foreground()
        for _ in range(2):
            self.auto.SendKeys("{Ctrl}{Alt}-",charMode=False,waitTime=0.2)

    def disable_snap(self):
        from PIL import ImageGrab
        control = self.named("adsorb")
        rect = control.BoundingRectangle
        pixels = ImageGrab.grab(bbox=(rect.left,rect.top,rect.right,rect.bottom)).convert("RGB")
        if sum(g>110 and b>110 and r<g*0.65 for r,g,b in pixels.getdata())>4:
            control.Click(waitTime=0.15)

    def fit_timeline(self):
        self.named("quicklyAdjustZoomFit").Click(waitTime=0.3)
        deadline = time.monotonic()+3
        while time.monotonic()<deadline:
            videos = [c.BoundingRectangle for c in self.tracks() if c.Name.startswith("MTLSVideoP:")]
            window = self.window_rect()
            timeline = self.named("MainMultiTimelineLayout").BoundingRectangle
            if videos and min(r.left for r in videos)>=timeline.left+150 and max(r.right for r in videos)<=window.right-25:
                time.sleep(0.15)
                return
            time.sleep(0.1)
        raise RuntimeError("时间线未能适应窗口，停止以避免点击屏幕外区域")

    def enlarge_timeline(self):
        self.foreground()
        # Keep layout changes out of the content drag area; zoom is applied for screenshots.
        self.window.Maximize(waitTime=0.2)
        self.named("quicklyAdjustZoomFit").Click(waitTime=0.15)

    def visible_subtitle_count(self):
        from PIL import ImageGrab
        videos = [c for c in self.tracks() if c.Name.startswith("MTLSVideoP:")]
        if not videos:
            return 0
        rect = videos[0].BoundingRectangle
        image = ImageGrab.grab(bbox=(rect.left,rect.top-35,self.window_rect().right-40,rect.top)).convert("RGB")
        maximum = 0
        for y in range(image.height):
            count = 0; previous = False
            for x in range(image.width):
                r,g,b = image.getpixel((x,y))
                orange = r>110 and 35<g<150 and b<120 and r>g*1.25
                if orange and not previous:
                    count += 1
                previous = orange
            maximum = max(maximum,count)
        return maximum

    def recognize_subtitles(self):
        self.foreground()
        self.named("root_字幕").Click(waitTime=0.1)
        self.named("识别字幕").Click(waitTime=0.1)
        self.named("automationnewLanguageComboBox").Click(waitTime=0.1)
        self.named("中文（包含粤语）", popups=True).Click(waitTime=0.1)
        self.named("automationstartBtn").Click(waitTime=0.25)
        deadline = time.monotonic()+600
        while time.monotonic()<deadline:
            try:
                controls = list(self.nodes())
            except Exception:
                time.sleep(0.3)
                continue
            progress = [c.Name for c,_ in controls if c.Name.startswith("loadingText:")]
            if progress:
                emit("progress",message=progress[0])
                time.sleep(2)
                continue
            subtitles = [c.Name for c,_ in controls if c.Name.startswith("MTLS") and ("Text" in c.Name or "Subtitle" in c.Name)]
            if subtitles:
                self.show_materials()
                return len(subtitles)
            visible = self.visible_subtitle_count()
            if visible > 0:
                self.show_materials()
                return visible
            blockers = [c.Name for c,_ in controls if any(word in c.Name for word in ("识别失败", "重新识别", "立即开通", "扫码登录"))]
            if blockers:
                raise RuntimeError("字幕识别未完成："+"；".join(blockers))
            time.sleep(1)
        raise RuntimeError("字幕识别等待超时，草稿已保留")

    def capture_screenshots(self, request, samples=None):
        from faces import face_timestamps
        count = request.get("screenshotCount", 4)
        if not isinstance(count,int) or not 1<=count<=24:
            raise RuntimeError("截图数量必须为 1–24")
        samples = samples or face_timestamps(request["source"], request["duration"], count,
                                             lambda message: emit("progress",message=message))
        if len(samples)!=count:
            raise RuntimeError("截图时间点数量与任务要求不一致")
        output = Path(request["screenshotDirectory"]) if request.get("screenshotDirectory") else Path(request.get("output",Path(request["screenshot"]).parent))/"截图"
        output.mkdir(parents=True,exist_ok=True)
        from PIL import ImageGrab, ImageChops, ImageStat
        screenshots = []
        records = []
        preview_signatures = []
        import random
        self.foreground()
        zoom_control = self.named("zoomIn")
        for index, sample in enumerate(samples):
            self.foreground()
            if not self.window.IsMaximize():
                self.window.Maximize(waitTime=0.3)
            seconds = sample["seconds"]
            preview_face = False
            screen_image = None
            unique = False
            for attempt in range(8):
                candidate = sample["seconds"]
                if attempt:
                    low,high = (sample.get("rangeStart",0.5),sample.get("rangeEnd",request["duration"]-0.5)) if attempt<5 else (0.5,request["duration"]-0.5)
                    candidate = round(random.SystemRandom().uniform(low,high)*30)/30
                if any(abs(candidate-record["seconds"])<1 for record in records):
                    continue
                seconds = candidate
                unique = False
                screen_image = None
                self.fit_timeline()
                self.seek(seconds,request["duration"])
                for _ in range(request.get("zoomSteps",2)):
                    zoom_control.Click(waitTime=0.1)
                time.sleep(0.3)
                preview_face = self.preview_has_face()
                if not preview_face:
                    # Give a slow decoder one extra refresh before seeking elsewhere.
                    time.sleep(0.2)
                    preview_face = self.preview_has_face()
                if self.timecode("currentProgress")!=round(seconds*30):
                    continue
                window = self.window_rect()
                screen_image = ImageGrab.grab(bbox=(window.left,window.top,window.right,window.bottom))
                preview_rect = self.preview_bounds()
                preview = screen_image.crop((preview_rect[0]-window.left,preview_rect[1]-window.top,
                                             preview_rect[2]-window.left,preview_rect[3]-window.top))
                signature = preview.convert("L").resize((32,32))
                unique = all(ImageStat.Stat(ImageChops.difference(signature,previous)).mean[0]>4
                             for previous in preview_signatures)
                if preview_face and unique:
                    break
            if screen_image is None or not unique:
                raise RuntimeError("截图预览画面未刷新或重复，已停止，避免保存相同截图")
            self.foreground()
            file = output/f"剪映处理截图-{index+1:02d}.png"
            screen_image.save(str(file))
            if not file.is_file() or file.stat().st_size<1000:
                raise RuntimeError("剪映截图保存失败")
            preview_signatures.append(signature)
            screenshots.append(str(file))
            records.append({**sample,"sourceCandidateSeconds":sample["seconds"],"sourceFaceDetected":sample["faceDetected"],"seconds":seconds,"faceDetected":preview_face,"verifiedFrame":round(seconds*30),"captureMethod":"live-screen","file":str(file)})
            emit("progress",message=f"已保存截图 {index+1}/{count}"+("（预览画面检出人脸）" if preview_face else "（预览未检出人脸）"))
        (output/"截图记录.json").write_text(json.dumps(records,ensure_ascii=False,indent=2),encoding="utf8")
        return screenshots, records

    def preview_bounds(self):
        progress = self.named("currentProgress").BoundingRectangle
        play = self.named("PlayerPlayBtn").BoundingRectangle
        window = self.window_rect()
        left = max(window.left,progress.left-12)
        right = min(window.right,play.left+play.right-left)
        top,bottom = window.top+70,progress.top-12
        if right<=left or bottom<=top:
            raise RuntimeError("无法定位播放器画面区域")
        return left,top,right,bottom

    def preview_has_face(self):
        import cv2
        import numpy as np
        from PIL import ImageGrab
        gray = cv2.cvtColor(np.asarray(ImageGrab.grab(bbox=self.preview_bounds())),cv2.COLOR_RGB2GRAY)
        if not hasattr(self,"face_detectors"):
            self.face_detectors = [cv2.CascadeClassifier(cv2.data.haarcascades+name) for name in ("haarcascade_frontalface_default.xml","haarcascade_profileface.xml")]
        return any(len(detector.detectMultiScale(gray,scaleFactor=1.1,minNeighbors=5,minSize=(14,14)))>0 for detector in self.face_detectors)

    def show_materials(self):
        self.named("root_素材").Click(waitTime=0.15)
        search = self.find(lambda c:c.ControlTypeName=="EditControl" and not c.Name)
        value = search.GetPattern(self.auto.PatternId.ValuePattern).Value
        if value:
            rect = search.BoundingRectangle
            self.auto.Click(rect.right+10,(rect.top+rect.bottom)//2,waitTime=0.25)

    def add_effects(self, duration):
        import random
        self.reveal_tracks(reserve_top=90)
        self.named("root_特效").Click(waitTime=0.4)
        candidates = list(dict.fromkeys(c.Name for c,_ in self.nodes()
                          if c.Name.startswith("EffectItemView:") and not c.IsOffscreen
                          and c.BoundingRectangle.width()>10 and c.BoundingRectangle.height()>10))
        random.SystemRandom().shuffle(candidates)
        names = candidates[:3]
        if not names:
            self.show_materials()
            return 0,["默认特效面板没有可见资源，已跳过"]
        count = 0
        warnings = []
        initial_count = sum(c.Name.startswith("MTLSEffectP:") for c in self.tracks())
        for name in names:
            try:
                tile = self.named(name,timeout=3)
                rect = tile.BoundingRectangle
                tile.DoubleClick(waitTime=0.3)
                # Preview/download first; dragging is the explicit apply operation.
                time.sleep(0.6)
                videos = [c.BoundingRectangle for c in self.tracks() if c.Name.startswith("MTLSVideoP:")]
                left,right = min(r.left for r in videos),max(r.right for r in videos)
                seconds = random.SystemRandom().uniform(min(4,duration/5),max(min(4,duration/5),duration-5))
                x = round(left+(right-left)*seconds/duration)
                y = min(c.BoundingRectangle.top for c in self.tracks())-18
                if y<self.named("MainMultiTimelineLayout").BoundingRectangle.top+45:
                    raise RuntimeError("顶部空间不足以添加特效")
                before = sum(c.Name.startswith("MTLSEffectP:") for c in self.tracks())
                self.drag((rect.left+rect.right)//2,(rect.top+rect.bottom)//2,x,y)
                self.wait_track_count("MTLSEffectP:",before+1,timeout=20)
                count += 1
                emit("progress",message=f"已在顶部添加默认列表随机特效：{name.removeprefix("EffectItemView:")}")
            except Exception as error:
                warnings.append(f"特效 {name} 未添加：{error}")
                self.auto.SendKeys("{ESC}",waitTime=0.1)
        self.show_materials()
        return count,warnings

    def reveal_tracks(self,reserve_top=0):
        for _ in range(10):
            audios = [c for c in self.tracks() if c.Name.startswith("MTLSAudioP:")]
            if not audios:
                break
            height = audios[0].BoundingRectangle.height()
            if 34<=height<=40:
                break
            key = "=" if height<34 else "-"
            self.auto.SendKeys("{Ctrl}{Alt}"+key,charMode=False,waitTime=0.2)
        for _ in range(10):
            timeline = self.named("MainMultiTimelineLayout").BoundingRectangle
            window = self.window_rect()
            rects = [c.BoundingRectangle for c in self.tracks() if c.Name.startswith(("MTLSVideoP:","MTLSAudioP:","MTLSEffectP:","MTLSTextP:"))]
            if not rects:
                return
            top,bottom = min(r.top for r in rects),max(r.bottom for r in rects)
            self.auto.SetCursorPos(timeline.left+90,(timeline.top+timeline.bottom)//2)
            if bottom>window.bottom-12:
                self.auto.WheelDown(wheelTimes=1,waitTime=0.2)
            elif top<timeline.top+55+reserve_top:
                self.auto.WheelUp(wheelTimes=1,waitTime=0.2)
            else:
                return

    @retry_read
    def main_menu(self):
        candidates = [control for control in self.window.GetChildren() if control.ControlTypeName == "ButtonControl" and not control.Name]
        return min(candidates, key=lambda control: control.BoundingRectangle.left)

    def file_action(self, name):
        self.main_menu().Click(waitTime=0.15)
        self.named("文件", popups=True).MoveCursorToMyCenter()
        time.sleep(0.25)
        self.find(lambda control: control.Name == name and control.ControlTypeName == "MenuItemControl", popups=True).Click(waitTime=0.3)

    def new_project(self):
        self.bind()
        self.foreground()
        # Reuse an already empty editor; do not open another confirmation dialog.
        def empty_editor():
            return (self.window.AutomationId=="MainWindow" and not self.tracks()
                    and self.timecode("totalProgress")<=1)
        try:
            if empty_editor():
                return
        except Exception:
            pass
        pending = [c for c,_ in self.nodes() if "是否确认新建草稿" in c.Name]
        if pending:
            self.named("automationconfirmBtn",popups=True).Click(waitTime=0.2)
        elif self.window.AutomationId=="MainWindow":
            self.file_action("新建草稿")
        else:
            self.named("HomePageStartProjectName").Click(waitTime=0.2)
        deadline = time.monotonic()+30
        confirmed = bool(pending)
        last_error = "尚未进入空白编辑器"
        while time.monotonic()<deadline:
            try:
                self.bind()
                pending = [c for c,_ in self.nodes() if "是否确认新建草稿" in c.Name]
                if pending and not confirmed:
                    self.named("automationconfirmBtn",popups=True).Click(waitTime=0.2)
                    confirmed = True
                    continue
                if empty_editor():
                    self.foreground()
                    return
                last_error = f"窗口 {self.window.AutomationId}，轨道数 {len(self.tracks())}"
            except Exception as error:
                last_error = str(error)
            time.sleep(0.15)
        raise RuntimeError(f"未能创建空白剪映草稿：{last_error}；已停止以保护已有项目")

    def set_text(self, control, value):
        pattern = control.GetPattern(self.auto.PatternId.ValuePattern)
        if pattern:
            pattern.SetValue(value)
            return
        control.Click(waitTime=0.1)
        self.auto.SendKeys("{Ctrl}a", waitTime=0.1)
        self.auto.SendKeys(value, charMode=True, interval=0.001, waitTime=0.15)

    def import_files(self, files):
        for offset in range(0,len(files),20):
            batch = files[offset:offset+20]
            for file in batch:
                if not Path(file).is_file():
                    raise RuntimeError(f"导入素材不存在：{file}")
            self.foreground()
            self.find(lambda control: control.Name.startswith("barImportViewBtn_")).Click(waitTime=0.5)
            field = self.find(lambda control: control.ControlTypeName=="EditControl" and control.AutomationId=="1148", popups=True)
            value = " ".join('"'+str(Path(file).resolve())+'"' for file in batch)
            if len(value)>28000:
                raise RuntimeError("导入路径过长，请缩短视频目录路径")
            self.set_text(field,value)
            self.find(lambda control: control.ControlTypeName=="ButtonControl" and control.AutomationId=="1",popups=True).Click(waitTime=0.4)
            # Wait for the native dialog to disappear; never send another request while it is open.
            deadline=time.monotonic()+45
            while time.monotonic()<deadline:
                dialogs=[control for window in self.windows() for control,_ in self.nodes(window)
                         if control.ControlTypeName=="EditControl" and control.AutomationId=="1148"]
                if not dialogs:
                    break
                time.sleep(0.25)
            else:
                raise RuntimeError("剪映导入对话框未关闭，可能有素材读取错误")
            emit("progress",message=f"已导入素材 {min(offset+20,len(files))}/{len(files)}")

    def material_page(self):
        return [c for c,_ in self.nodes() if c.ControlTypeName=="ButtonControl"
                and c.Name.startswith("material.library.item.") and not c.IsOffscreen]

    def scroll_materials(self, direction):
        page = self.material_page()
        if not page:
            raise RuntimeError("素材列表尚未显示可滚动的素材")
        header = self.find(lambda c:c.Name.startswith("barImportViewBtn_")).BoundingRectangle
        bottom = self.named("MainMultiTimelineLayout").BoundingRectangle.top-10
        left = min(c.BoundingRectangle.left for c in page)
        right = max(c.BoundingRectangle.right for c in page)
        top = header.bottom+25
        if bottom<=top:
            raise RuntimeError("素材列表可见空间不足，请恢复素材面板")
        self.auto.SetCursorPos((left+right)//2,(top+bottom)//2)
        wheel = self.auto.WheelUp if direction<0 else self.auto.WheelDown
        wheel(wheelTimes=1,waitTime=0.08)

    def material_top(self):
        previous = None
        for _ in range(160):
            page = self.material_page()
            signature = tuple((c.Name,c.BoundingRectangle.top) for c in page)
            if signature==previous:
                return
            previous = signature
            self.scroll_materials(-1)
        raise RuntimeError("无法返回素材列表顶部")

    def material_names(self, expected=None):
        from materials import material_filenames
        expected = set(expected or [])
        names = {c.Name for c in self.material_page()}
        if expected and expected.issubset(set(material_filenames(names))):
            return list(names)
        self.material_top()
        previous = None
        for _ in range(160):
            page = self.material_page()
            names.update(c.Name for c in page)
            if expected and expected.issubset(set(material_filenames(names))):
                return list(names)
            signature = tuple((c.Name,c.BoundingRectangle.top) for c in page)
            if signature==previous:
                return list(names)
            previous = signature
            self.scroll_materials(1)
        raise RuntimeError("素材列表过长，未能完成无搜索核对")

    def verify_import(self, files):
        from materials import verify_materials
        expected = [Path(file).name for file in files]
        return verify_materials(expected,lambda:self.material_names(expected),
                                lambda message:emit("progress",message=message),timeout=0)

    def locate_material(self, filename):
        self.show_materials()
        header = self.find(lambda c:c.Name.startswith("barImportViewBtn_")).BoundingRectangle
        bottom = self.named("MainMultiTimelineLayout").BoundingRectangle.top-10
        previous = None
        from_top = False
        for _ in range(160):
            page = self.material_page()
            matches = [c for c in page if unquote(c.Name).endswith("."+filename+".apply")]
            if len(matches)>1:
                raise RuntimeError("当前集素材存在同名重复记录")
            if matches:
                tile = matches[0]
                rect = tile.BoundingRectangle
                if rect.top>=header.bottom+20 and rect.bottom<=bottom:
                    return tile
            elif not from_top:
                self.material_top()
                previous = None
                from_top = True
                continue
            signature = tuple((c.Name,c.BoundingRectangle.top) for c in page)
            if signature==previous:
                break
            previous = signature
            self.scroll_materials(1)
        raise RuntimeError(f"未能在素材列表中完整定位当前集：{filename}；未执行文字搜索")

    def add_original(self, source):
        filename = Path(source).name
        tile = self.locate_material(filename)
        emit("progress",message="已按文件名定位当前集，直接加入主轨（不搜索）")
        if self.tracks():
            raise RuntimeError("当前集入轨前时间线不是空白，已停止")
        # Import leaves all tiles selected. A plain click replaces that selection;
        # hovering alone would make the add button insert every selected asset.
        tile.Click(waitTime=0.2)
        tile.MoveCursorToMyCenter()
        time.sleep(0.15)
        # Selection/hover can rebuild Qt's delegate; refresh the tile and button.
        tile = self.named(tile.Name,timeout=3)
        tile.MoveCursorToMyCenter()
        button = self.named("ResourceInfoViewImportBtn",root=tile,timeout=3)
        rect = button.BoundingRectangle
        bottom = self.named("MainMultiTimelineLayout").BoundingRectangle.top
        if rect.bottom>bottom or rect.width()<=0 or rect.height()<=0:
            raise RuntimeError("当前集加入按钮被遮挡，已停止，未点击其他素材")
        button.Click(waitTime=0.08)
        expected = "MTLSVideoP:"+filename
        tracks = self.wait_track_count("MTLSVideoP:",1,timeout=8)
        if len(tracks)!=1 or tracks[0].Name!=expected:
            raise RuntimeError("当前集入轨结果不符，读取到："+"、".join(c.Name for c in tracks)+"；已停止")

    def run(self, request):
        self.workflow_warnings = []
        source=request["source"]
        files=request["fragments"]
        if not files or len(set(files))!=len(files):
            raise RuntimeError("素材清单无效")
        emit("progress",stage="project",message="正在新建剪映草稿")
        self.new_project()
        ctypes.WinDLL("user32").ShowWindow(wintypes.HWND(self.window.NativeWindowHandle), 3)
        time.sleep(0.5)
        import random
        import_order = [source]+files
        random.SystemRandom().shuffle(import_order)
        if request.get("output"):
            (Path(request["output"])/"导入顺序.json").write_text(json.dumps(import_order,ensure_ascii=False,indent=2),encoding="utf8")
        emit("progress",stage="import",message="正在按随机顺序导入四集共享素材与当前集原片")
        self.import_files(import_order)
        import_verification = self.verify_import(import_order)
        emit("progress",stage="timeline",message="正在将当前集完整视频加入主轨道")
        self.add_original(source)
        total=self.timecode("totalProgress")
        if abs(total-round(request["duration"]*30))>1:
            raise RuntimeError("剪映项目时长与当前集不符，请确认项目采用 30 fps")
        emit("progress",stage="audio",message="正在使用剪映分离声音")
        self.detach(Path(source).name)
        emit("progress",stage="split",message="正在给当前集主视频添加少量随机切口")
        result=self.split_timeline(Path(source).name,request["cutSeconds"],request["duration"])
        if not request.get("base") or not request.get("audio"):
            raise RuntimeError("缺少当前集工作台计划，请重新启动任务")
        self.split_audio([item["start"] for item in request["audio"][1:]],request["duration"])
        self.enlarge_timeline()
        self.compact_track_height()
        emit("progress",stage="tracks",message="正在复制长短不一的视频块，错开放到上方两轨")
        result["videoClips"],video_tracks = self.copy_video_layers(request)
        emit("progress",stage="subtitles",message="正在识别中文字幕并生成独立字幕轨道")
        subtitle_count = self.recognize_subtitles()
        self.video_below_subtitles()
        emit("progress",stage="tracks",message="正在重复分离后的音频，随机重叠到多条音轨")
        result["audioClips"],audio_tracks = self.repeat_audio(request)
        emit("progress",stage="effects",message="正在顶部随机添加特效")
        effects_added,effect_warnings = self.add_effects(request["duration"])
        self.reveal_tracks()
        if self.timecode("totalProgress")!=total:
            raise RuntimeError("分割改变了主轨道总时长，已停止")
        # Clear search so that the final screenshot includes the imported material panel.
        self.show_materials()
        self.foreground()
        emit("progress",stage="screenshot",message="正在保存剪映处理截图")
        screenshots, records = self.capture_screenshots(request)
        warnings = effect_warnings+self.workflow_warnings
        if any(not record["faceDetected"] for record in records):
            warnings.append("部分时间段未检出人脸，已保留随机画面截图")
        return {**result,"importedMaterials":len(files)+1,"screenshot":screenshots[0],"screenshots":screenshots,
                "videoTracks":video_tracks,"audioTracks":audio_tracks,"subtitleSegmentsVisible":subtitle_count,"effectsAdded":effects_added,"warnings":warnings,
                "importVerification":import_verification,"importOrder":import_order}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--inspect", action="store_true")
    parser.add_argument("--request")
    args = parser.parse_args()
    try:
        editor = Editor()
        if args.inspect:
            emit("inspection", value=editor.inspect())
        elif args.request:
            request = json.loads(Path(args.request).read_text(encoding="utf-8-sig"))
            editor.bind()
            if request["action"] == "detach":
                emit("result", value=editor.detach(request["filename"]))
            elif request["action"] == "probe-timecode":
                editor.foreground()
                editor.named("currentProgress").DoubleClick(waitTime=0.3)
                editor.window.CaptureToImage(request["screenshot"])
            elif request["action"] == "run":
                emit("result",value=editor.run(request))
            elif request["action"] == "split":
                result = editor.split_timeline(request["filename"], request["cutSeconds"], request["duration"])
                if request.get("screenshot"):
                    editor.window.CaptureToImage(request["screenshot"])
                emit("result", value=result)
            elif request["action"] == "probe-split":
                editor.foreground()
                editor.auto.SendKeys("{ESC}", waitTime=0.2)
                editor.split_button().MoveCursorToMyCenter()
                time.sleep(1)
                editor.window.CaptureToImage(request["screenshot"])
                emit("result", value={"hovered": True})
            elif request["action"] == "probe-main-menu":
                editor.foreground()
                editor.main_menu().Click(waitTime=0.3)
                emit("result", value={"menuNames":[control.Name for window in editor.windows() for control,_ in editor.nodes(window) if control.ControlTypeName=="MenuItemControl"]})
                editor.window.CaptureToImage(request["screenshot"])
            elif request["action"] == "probe-file-menu":
                editor.foreground()
                editor.auto.SendKeys("{ESC}",waitTime=0.1)
                editor.main_menu().Click(waitTime=0.15)
                editor.named("文件",popups=True).MoveCursorToMyCenter()
                time.sleep(0.4)
                emit("result", value={"menuNames":[control.Name for window in editor.windows() for control,_ in editor.nodes(window) if control.ControlTypeName=="MenuItemControl"]})
                editor.window.CaptureToImage(request["screenshot"])
            else:
                raise RuntimeError("不支持的执行器操作")
    except Exception as error:
        import traceback
        if "editor" in locals() and editor.window is not None:
            try:
                emit("diagnostic", names=[control.Name for control, _ in editor.nodes() if any(word in control.Name for word in ("音频", "MTLS", "菜单"))])
                editor.window.CaptureToImage(str(Path(args.request).with_suffix(".failure.png")))
            except Exception:
                pass
        emit("error", message=str(error),traceback=traceback.format_exc())
        return 1
    return 0

if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())



