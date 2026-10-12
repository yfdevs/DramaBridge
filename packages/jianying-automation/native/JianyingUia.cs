using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Runtime.InteropServices;

internal static class JianyingUia
{
    private const int DefaultMaxElements = 500;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            string command = args.Length == 0 ? "probe" : args[0].ToLowerInvariant();
            int maxElements = ReadIntArgument(args, "--max-elements", DefaultMaxElements);

            if (command == "probe" || command == "tree")
            {
                WriteJson(Probe(maxElements, command == "tree"));
                return 0;
            }

            if (command == "launch")
            {
                WriteJson(Launch(
                    ReadArgument(args, "--exe"),
                    ReadArgument(args, "--config"),
                    ReadIntArgument(args, "--hold-ms", 15000),
                    maxElements));
                return 0;
            }

            if (command == "invoke" || command == "click" || command == "set-value" || command == "type-text")
            {
                WriteJson(Operate(
                    ReadArgument(args, "--name"),
                    ReadArgument(args, "--automation-id"),
                    ReadArgument(args, "--class-name"),
                    ReadArgument(args, "--control-type"),
                    maxElements,
                    command,
                    ReadArgument(args, "--value")));
                return 0;
            }

            if (command == "capture-window")
            {
                WriteJson(CaptureWindow(ReadArgument(args, "--output")));
                return 0;
            }

            if (command == "click-point")
            {
                WriteJson(ClickPoint(
                    ReadIntArgument(args, "--x", -1),
                    ReadIntArgument(args, "--y", -1)));
                return 0;
            }

            if (command == "seek-timeline")
            {
                WriteJson(SeekTimeline(
                    ReadLongArgument(args, "--time-us", -1),
                    ReadLongArgument(args, "--duration-us", -1)));
                return 0;
            }

            if (command == "open-first-draft")
            {
                WriteJson(OpenFirstDraft(ReadArgument(args, "--draft-name")));
                return 0;
            }

            if (command == "close-missing-media-window")
            {
                WriteJson(CloseMissingMediaWindow());
                return 0;
            }

            if (command == "close-editor-window")
            {
                WriteJson(CloseEditorWindow());
                return 0;
            }

            if (command == "press-space")
            {
                WriteJson(PressSpace());
                return 0;
            }

            if (command == "press-enter")
            {
                WriteJson(PressEnter());
                return 0;
            }

            if (command == "return-home")
            {
                WriteJson(ReturnHome());
                return 0;
            }

            if (command == "import-media")
            {
                WriteJson(ImportMedia(ReadArguments(args, "--file")));
                return 0;
            }

            if (command == "double-click")
            {
                WriteJson(Operate(
                    ReadArgument(args, "--name"),
                    ReadArgument(args, "--automation-id"),
                    ReadArgument(args, "--class-name"),
                    ReadArgument(args, "--control-type"),
                    maxElements,
                    command,
                    null));
                return 0;
            }

            throw new ArgumentException("Unsupported command: " + command);
        }
        catch (Exception error)
        {
            WriteJson(new Dictionary<string, object>
            {
                { "success", false },
                { "message", error.Message },
                { "errorType", error.GetType().FullName }
            });
            return 1;
        }
    }

    private static Dictionary<string, object> CaptureWindow(string outputPath)
    {
        if (String.IsNullOrWhiteSpace(outputPath))
            throw new ArgumentException("capture-window requires --output");

        List<AutomationElement> roots = FindWindowRoots(Process.GetProcessesByName("JianyingPro"));
        if (roots.Count == 0) throw new InvalidOperationException("未找到剪映主窗口");

        AutomationElement root = LargestWindow(roots);
        IntPtr handle = new IntPtr(SafeInt(delegate { return root.Current.NativeWindowHandle; }));
        if (handle == IntPtr.Zero) throw new InvalidOperationException("无法读取剪映窗口句柄");

        EnsureMaximized(handle);
        NativeRect rect;
        if (!GetWindowRect(handle, out rect)) throw new InvalidOperationException("无法读取剪映窗口范围");
        int width = rect.Right - rect.Left;
        int height = rect.Bottom - rect.Top;
        if (width <= 0 || height <= 0) throw new InvalidOperationException("剪映窗口范围无效");

        string absolutePath = Path.GetFullPath(outputPath);
        string directory = Path.GetDirectoryName(absolutePath);
        if (!String.IsNullOrWhiteSpace(directory)) Directory.CreateDirectory(directory);

        using (Bitmap bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb))
        using (Graphics graphics = Graphics.FromImage(bitmap))
        {
            IntPtr deviceContext = graphics.GetHdc();
            bool captured;
            try { captured = PrintWindow(handle, deviceContext, 2); }
            finally { graphics.ReleaseHdc(deviceContext); }
            if (!captured) throw new InvalidOperationException("剪映窗口离屏截图失败");
            bitmap.Save(absolutePath, ImageFormat.Png);
        }

        return new Dictionary<string, object>
        {
            { "success", true },
            { "message", "剪映窗口截图成功" },
            { "path", absolutePath },
            { "left", rect.Left },
            { "top", rect.Top },
            { "width", width },
            { "height", height }
        };
    }

    private static Dictionary<string, object> ClickPoint(int relativeX, int relativeY)
    {
        List<AutomationElement> roots = FindWindowRoots(Process.GetProcessesByName("JianyingPro"));
        if (roots.Count == 0) throw new InvalidOperationException("未找到剪映主窗口");

        AutomationElement root = LargestWindow(roots);
        IntPtr handle = new IntPtr(SafeInt(delegate { return root.Current.NativeWindowHandle; }));
        if (handle != IntPtr.Zero && IsIconic(handle))
        {
            ShowWindow(handle, 9);
            Thread.Sleep(300);
        }
        NativeRect rect;
        if (handle == IntPtr.Zero || !GetWindowRect(handle, out rect))
            throw new InvalidOperationException("无法读取剪映窗口范围");

        int width = rect.Right - rect.Left;
        int height = rect.Bottom - rect.Top;
        if (relativeX < 0 || relativeY < 0 || relativeX >= width || relativeY >= height)
            throw new ArgumentOutOfRangeException("point", "点击位置不在剪映窗口内");

        ClickWindowAtScreenPoint(handle, rect.Left + relativeX, rect.Top + relativeY, 1);
        Thread.Sleep(250);

        return new Dictionary<string, object>
        {
            { "success", true },
            { "message", "剪映窗口坐标点击成功" },
            { "x", relativeX },
            { "y", relativeY }
        };
    }

    private static Dictionary<string, object> PressSpace()
    {
        List<AutomationElement> roots = FindWindowRoots(Process.GetProcessesByName("JianyingPro"));
        if (roots.Count == 0) throw new InvalidOperationException("未找到剪映主窗口");
        AutomationElement root = LargestWindow(roots);
        IntPtr handle = new IntPtr(SafeInt(delegate { return root.Current.NativeWindowHandle; }));
        if (handle == IntPtr.Zero) throw new InvalidOperationException("无法读取剪映窗口句柄");
        if (IsIconic(handle)) ShowWindow(handle, 9);
        SetForegroundWindow(handle);
        Thread.Sleep(250);
        keybd_event(0x20, 0, 0, UIntPtr.Zero);
        keybd_event(0x20, 0, 0x0002, UIntPtr.Zero);
        Thread.Sleep(150);
        return new Dictionary<string, object>
        {
            { "success", true },
            { "message", "剪映空格键发送成功" }
        };
    }

    private static Dictionary<string, object> SeekTimeline(long timeUs, long durationUs)
    {
        if (timeUs < 0 || durationUs <= 0 || timeUs > durationUs)
            throw new ArgumentOutOfRangeException("timeUs", "时间轴定位参数无效");

        AutomationElement root = null;
        AutomationElement ruler = null;
        AutomationElement timelineRoot = null;
        System.Windows.Rect rootBounds = System.Windows.Rect.Empty;
        IntPtr handle = IntPtr.Zero;

        // MainWindow is reported before the QML timeline has finished mounting.
        // Wait for a real track row instead of treating that transient state as
        // an unsupported Jianying layout.
        for (int attempt = 0; attempt < 32 && ruler == null; attempt++)
        {
            List<AutomationElement> roots = FindWindowRoots(Process.GetProcessesByName("JianyingPro"));
            if (roots.Count == 0)
            {
                if (attempt == 31) throw new InvalidOperationException("未找到剪映主窗口");
                Thread.Sleep(250);
                continue;
            }

            root = roots.Find(delegate(AutomationElement element)
            {
                return String.Equals(
                    SafeString(delegate { return element.Current.AutomationId; }),
                    "MainWindow",
                    StringComparison.OrdinalIgnoreCase);
            }) ?? LargestWindow(roots);
            handle = new IntPtr(SafeInt(delegate { return root.Current.NativeWindowHandle; }));
            if (handle == IntPtr.Zero)
            {
                Thread.Sleep(250);
                continue;
            }
            EnsureMaximized(handle);
            try { rootBounds = root.Current.BoundingRectangle; }
            catch
            {
                Thread.Sleep(250);
                continue;
            }

            double rulerTop = Double.MaxValue;
            Walk(root, 0, 24, 5000, delegate(AutomationElement element)
            {
                string automationId = SafeString(delegate { return element.Current.AutomationId; });
                if (String.Equals(
                    automationId,
                    "timeline_docker_layout.timelineContainer.main_timeline_root",
                    StringComparison.OrdinalIgnoreCase))
                    timelineRoot = element;
                System.Windows.Rect bounds;
                try { bounds = element.Current.BoundingRectangle; }
                catch { return; }
                bool inTimeline = bounds.Left >= rootBounds.Left + rootBounds.Width * 0.28
                    && bounds.Top >= rootBounds.Top + rootBounds.Height * 0.55
                    && bounds.Top <= rootBounds.Top + rootBounds.Height * 0.92;
                bool rulerShape = bounds.Width >= rootBounds.Width * 0.45
                    && bounds.Height >= 12 && bounds.Height <= 50;
                if (inTimeline && rulerShape && bounds.Top < rulerTop)
                {
                    ruler = element;
                    rulerTop = bounds.Top;
                }
            });
            if (ruler == null)
            {
                // The timeline container is a stable public automation ID in
                // Jianying 11.x, while its canvas children use versioned QML
                // class names. Give child controls a short mount window, then
                // use the maximized container geometry as a safe fallback.
                if (timelineRoot != null && attempt >= 11) break;
                Thread.Sleep(250);
            }
        }
        double ratio = Math.Max(0, Math.Min(1, (double)timeUs / durationUs));
        int x;
        int y;
        if (ruler != null)
        {
            System.Windows.Rect rulerBounds = ruler.Current.BoundingRectangle;
            double padding = Math.Min(8, rulerBounds.Width * 0.01);
            double usableWidth = Math.Max(1, rulerBounds.Width - padding * 2);
            x = (int)Math.Round(rulerBounds.Left + padding + usableWidth * ratio);
            // UI Automation exposes the first track row, while the ruler
            // itself is a canvas immediately above it.
            y = (int)Math.Round(rulerBounds.Top - 10);
        }
        else if (timelineRoot != null)
        {
            // Jianying 11.5 exposes the timeline container but can omit the
            // ruler canvas from UIA. In the maximized editor, the canvas uses
            // the rightmost 65% of the window and its ruler sits at 60.5% of
            // the window height. These ratios remain stable under DPI scaling.
            double timelineLeft = rootBounds.Left + rootBounds.Width * 0.335;
            double timelineRight = rootBounds.Right - rootBounds.Width * 0.012;
            x = (int)Math.Round(timelineLeft + (timelineRight - timelineLeft) * ratio);
            y = (int)Math.Round(rootBounds.Top + rootBounds.Height * 0.605);
        }
        else
        {
            throw new InvalidOperationException("剪映时间轴容器尚未加载，请稍后重试");
        }
        ClickWindowAtScreenPoint(handle, x, y, 1);
        Thread.Sleep(500);

        return new Dictionary<string, object>
        {
            { "success", true },
            { "message", "剪映时间轴已定位到无字幕画面" },
            { "timeUs", timeUs },
            { "durationUs", durationUs },
            { "x", x - (int)Math.Round(rootBounds.Left) },
            { "y", y - (int)Math.Round(rootBounds.Top) }
        };
    }

    private static Dictionary<string, object> OpenFirstDraft(string draftName)
    {
        if (String.IsNullOrWhiteSpace(draftName))
            throw new ArgumentException("open-first-draft requires --draft-name");
        // Jianying 11.5 silently truncates long values in the home search
        // field. Search by a stable tail that still contains the episode
        // suffix, so 第1集 cannot be confused with 第10集.
        string expectedSearch = draftName.Length > 16
            ? draftName.Substring(draftName.Length - 16)
            : draftName;

        List<AutomationElement> roots = FindWindowRoots(Process.GetProcessesByName("JianyingPro"));
        AutomationElement root = roots.Find(delegate(AutomationElement element)
        {
            return String.Equals(
                SafeString(delegate { return element.Current.AutomationId; }),
                "HomeWindow",
                StringComparison.OrdinalIgnoreCase);
        });
        if (root == null) throw new InvalidOperationException("未找到剪映草稿首页");

        IntPtr handle = new IntPtr(SafeInt(delegate { return root.Current.NativeWindowHandle; }));
        if (handle == IntPtr.Zero) throw new InvalidOperationException("无法读取剪映窗口句柄");
        if (IsIconic(handle)) ShowWindow(handle, 9);
        SetForegroundWindow(handle);
        Thread.Sleep(150);

        bool searchMatches = false;
        AutomationElement card = null;
        double cardArea = 0;
        System.Windows.Rect rootBounds = root.Current.BoundingRectangle;
        Walk(root, 0, 24, 5000, delegate(AutomationElement element)
        {
            string controlType = SafeString(delegate
            {
                return element.Current.ControlType.ProgrammaticName.Replace("ControlType.", "");
            });
            if (controlType == "Edit")
            {
                object valuePattern;
                if (element.TryGetCurrentPattern(ValuePattern.Pattern, out valuePattern))
                {
                    string value = SafeString(delegate { return ((ValuePattern)valuePattern).Current.Value; });
                    if (String.Equals(value, expectedSearch, StringComparison.OrdinalIgnoreCase))
                        searchMatches = true;
                }
            }

            string className = SafeString(delegate { return element.Current.ClassName; });
            if (!className.StartsWith("HomePageOpenProjectItem", StringComparison.OrdinalIgnoreCase)) return;
            System.Windows.Rect bounds;
            try { bounds = element.Current.BoundingRectangle; }
            catch { return; }
            bool visibleCard = bounds.Width >= 60 && bounds.Width <= 500
                && bounds.Height >= 80 && bounds.Height <= 600
                && bounds.Left >= rootBounds.Left && bounds.Right <= rootBounds.Right
                && bounds.Top >= rootBounds.Top + 100 && bounds.Bottom <= rootBounds.Bottom;
            double area = bounds.Width * bounds.Height;
            if (visibleCard && area > cardArea)
            {
                card = element;
                cardArea = area;
            }
        });
        if (!searchMatches) throw new InvalidOperationException("剪映搜索框中的草稿关键词不匹配");
        if (card == null) throw new InvalidOperationException("未找到可打开的剪映草稿卡片");

        System.Windows.Point point;
        try { point = card.GetClickablePoint(); }
        catch
        {
            System.Windows.Rect bounds = card.Current.BoundingRectangle;
            point = new System.Windows.Point(bounds.Left + bounds.Width / 2, bounds.Top + bounds.Height / 2);
        }
        ClickWindowAtScreenPoint(
            handle,
            (int)Math.Round(point.X),
            (int)Math.Round(point.Y),
            2);
        Thread.Sleep(250);

        return new Dictionary<string, object>
        {
            { "success", true },
            { "message", "已双击剪映草稿卡片" },
            { "draftName", draftName },
            { "x", (int)Math.Round(point.X) },
            { "y", (int)Math.Round(point.Y) }
        };
    }

    private static Dictionary<string, object> CloseMissingMediaWindow()
    {
        List<AutomationElement> roots = FindWindowRoots(Process.GetProcessesByName("JianyingPro"));
        int closedCount = 0;
        foreach (AutomationElement root in roots)
        {
            string automationId = SafeString(delegate { return root.Current.AutomationId; });
            if (String.Equals(automationId, "MainWindow", StringComparison.OrdinalIgnoreCase)
                || String.Equals(automationId, "HomeWindow", StringComparison.OrdinalIgnoreCase))
                continue;

            string rootText = SafeString(delegate { return root.Current.Name; });
            bool isMissingMediaWindow = rootText.IndexOf("链接媒体", StringComparison.OrdinalIgnoreCase) >= 0
                || rootText.IndexOf("媒体丢失", StringComparison.OrdinalIgnoreCase) >= 0;
            Walk(root, 0, 16, 2500, delegate(AutomationElement element)
            {
                if (isMissingMediaWindow) return;
                string text = SafeString(delegate { return element.Current.Name; });
                if (text.IndexOf("链接媒体", StringComparison.OrdinalIgnoreCase) >= 0
                    || text.IndexOf("媒体丢失", StringComparison.OrdinalIgnoreCase) >= 0
                    || text.IndexOf("重新链接后再剪辑", StringComparison.OrdinalIgnoreCase) >= 0)
                    isMissingMediaWindow = true;
            });
            if (!isMissingMediaWindow) continue;

            IntPtr handle = new IntPtr(SafeInt(delegate { return root.Current.NativeWindowHandle; }));
            if (handle == IntPtr.Zero) continue;
            PostMessage(handle, 0x0010, IntPtr.Zero, IntPtr.Zero);
            closedCount++;
        }
        if (closedCount > 0) Thread.Sleep(300);
        return new Dictionary<string, object>
        {
            { "success", true },
            { "message", closedCount > 0 ? "已关闭链接媒体窗口" : "未发现独立链接媒体窗口" },
            { "closedCount", closedCount }
        };
    }

    private static Dictionary<string, object> CloseEditorWindow()
    {
        List<AutomationElement> roots = FindWindowRoots(Process.GetProcessesByName("JianyingPro"));
        AutomationElement editor = roots.Find(delegate(AutomationElement root)
        {
            return String.Equals(
                SafeString(delegate { return root.Current.AutomationId; }),
                "MainWindow",
                StringComparison.OrdinalIgnoreCase);
        });
        if (editor == null)
        {
            return new Dictionary<string, object>
            {
                { "success", true },
                { "message", "剪映编辑器窗口未打开" },
                { "closed", false }
            };
        }

        IntPtr handle = new IntPtr(SafeInt(delegate { return editor.Current.NativeWindowHandle; }));
        if (handle == IntPtr.Zero) throw new InvalidOperationException("无法读取剪映编辑器窗口句柄");
        PostMessage(handle, 0x0010, IntPtr.Zero, IntPtr.Zero);
        Thread.Sleep(300);
        return new Dictionary<string, object>
        {
            { "success", true },
            { "message", "已关闭剪映编辑器窗口" },
            { "closed", true }
        };
    }

    private static Dictionary<string, object> PressEnter()
    {
        keybd_event(0x0D, 0, 0, UIntPtr.Zero);
        keybd_event(0x0D, 0, 0x0002, UIntPtr.Zero);
        Thread.Sleep(150);
        return new Dictionary<string, object>
        {
            { "success", true },
            { "message", "剪映回车键发送成功" }
        };
    }

    private static Dictionary<string, object> ReturnHome()
    {
        List<AutomationElement> roots = FindWindowRoots(Process.GetProcessesByName("JianyingPro"));
        if (roots.Count == 0) throw new InvalidOperationException("未找到剪映主窗口");
        AutomationElement root = roots.Find(delegate(AutomationElement element)
        {
            return String.Equals(
                SafeString(delegate { return element.Current.AutomationId; }),
                "MainWindow",
                StringComparison.OrdinalIgnoreCase);
        }) ?? LargestWindow(roots);
        IntPtr handle = new IntPtr(SafeInt(delegate { return root.Current.NativeWindowHandle; }));
        if (handle == IntPtr.Zero) throw new InvalidOperationException("无法读取剪映窗口句柄");

        // Jianying's built-in "return to drafts" shortcut is Ctrl+Alt+Q.
        // Keyboard injection does not move or depend on the physical mouse.
        IntPtr previousForeground = GetForegroundWindow();
        if (IsIconic(handle)) ShowWindow(handle, 9);
        SetForegroundWindow(handle);
        Thread.Sleep(80);
        keybd_event(0x11, 0, 0, UIntPtr.Zero);
        keybd_event(0x12, 0, 0, UIntPtr.Zero);
        keybd_event(0x51, 0, 0, UIntPtr.Zero);
        keybd_event(0x51, 0, 0x0002, UIntPtr.Zero);
        keybd_event(0x12, 0, 0x0002, UIntPtr.Zero);
        keybd_event(0x11, 0, 0x0002, UIntPtr.Zero);
        Thread.Sleep(300);
        if (previousForeground != IntPtr.Zero && previousForeground != handle)
            SetForegroundWindow(previousForeground);
        return new Dictionary<string, object>
        {
            { "success", true },
            { "message", "已请求剪映返回草稿首页" }
        };
    }

    private static Dictionary<string, object> ImportMedia(List<string> files)
    {
        if (files.Count == 0) throw new ArgumentException("import-media requires at least one --file");
        foreach (string file in files)
            if (!File.Exists(file)) throw new FileNotFoundException("待导入的视频不存在", file);

        List<AutomationElement> roots = FindWindowRoots(Process.GetProcessesByName("JianyingPro"));
        if (roots.Count == 0) throw new InvalidOperationException("未找到剪映主窗口");
        AutomationElement mainWindow = roots.Find(delegate(AutomationElement root)
        {
            return String.Equals(
                SafeString(delegate { return root.Current.AutomationId; }),
                "MainWindow",
                StringComparison.OrdinalIgnoreCase);
        }) ?? LargestWindow(roots);
        IntPtr mainHandle = new IntPtr(SafeInt(delegate { return mainWindow.Current.NativeWindowHandle; }));
        if (mainHandle == IntPtr.Zero) throw new InvalidOperationException("无法读取剪映窗口句柄");
        SetForegroundWindow(mainHandle);
        Thread.Sleep(250);

        AutomationElement dialog = FindFileDialog(roots);
        for (int clickAttempt = 0; clickAttempt < 3 && dialog == null; clickAttempt++)
        {
            // The missing-media window can appear a few seconds after the
            // editor itself. Close it immediately before every import click.
            CloseMissingMediaWindow();
            Thread.Sleep(clickAttempt == 0 ? 250 : 500);
            roots = FindWindowRoots(Process.GetProcessesByName("JianyingPro"));
            mainWindow = roots.Find(delegate(AutomationElement root)
            {
                return String.Equals(
                    SafeString(delegate { return root.Current.AutomationId; }),
                    "MainWindow",
                    StringComparison.OrdinalIgnoreCase);
            });
            if (mainWindow == null) throw new InvalidOperationException("剪映编辑器窗口未打开");
            mainHandle = new IntPtr(SafeInt(delegate { return mainWindow.Current.NativeWindowHandle; }));
            if (mainHandle == IntPtr.Zero) throw new InvalidOperationException("无法读取剪映编辑器窗口句柄");
            if (IsIconic(mainHandle)) ShowWindow(mainHandle, 9);
            SetForegroundWindow(mainHandle);

            AutomationElement importButton = null;
            int importButtonScore = -1;
            Walk(mainWindow, 0, 20, 2000, delegate(AutomationElement element)
            {
                string className = SafeString(delegate { return element.Current.ClassName; });
                string name = SafeString(delegate { return element.Current.Name; }).Trim();
                string controlType = SafeString(delegate { return element.Current.ControlType.ProgrammaticName; });
                System.Windows.Rect bounds;
                try { bounds = element.Current.BoundingRectangle; }
                catch { return; }
                if (bounds.Width < 40 || bounds.Height < 18) return;
                int score = -1;
                if (name == "导入" && controlType == "ControlType.Button") score = 4;
                else if (name == "导入") score = 3;
                else if (className.StartsWith("SubtitlesImportItem", StringComparison.OrdinalIgnoreCase)) score = 2;
                if (score > importButtonScore)
                {
                    importButton = element;
                    importButtonScore = score;
                }
            });
            if (importButton == null) throw new InvalidOperationException("未找到剪映素材导入按钮");
            System.Windows.Rect importBounds = importButton.Current.BoundingRectangle;
            ClickWindowAtScreenPoint(
                mainHandle,
                (int)Math.Round(importBounds.Left + Math.Min(34, importBounds.Width / 2)),
                (int)Math.Round(importBounds.Top + importBounds.Height / 2),
                1);
            for (int attempt = 0; attempt < 15 && dialog == null; attempt++)
            {
                Thread.Sleep(200);
                roots = FindWindowRoots(Process.GetProcessesByName("JianyingPro"));
                dialog = FindFileDialog(roots);
            }
        }
        if (dialog == null) throw new InvalidOperationException("剪映未打开媒体文件选择框");

        AutomationElement fileNameEdit = null;
        double lowestTop = Double.MinValue;
        Walk(dialog, 0, 12, 1000, delegate(AutomationElement element)
        {
            string controlType = SafeString(delegate { return element.Current.ControlType.ProgrammaticName; });
            if (controlType != "ControlType.Edit") return;
            System.Windows.Rect bounds;
            try { bounds = element.Current.BoundingRectangle; }
            catch { return; }
            string automationId = SafeString(delegate { return element.Current.AutomationId; });
            if (automationId == "1148" || bounds.Top > lowestTop)
            {
                fileNameEdit = element;
                lowestTop = bounds.Top;
            }
        });
        if (fileNameEdit == null) throw new InvalidOperationException("文件选择框中未找到文件名输入框");
        string fileList = String.Join(" ", files.ConvertAll(delegate(string file) {
            return "\"" + Path.GetFullPath(file) + "\"";
        }).ToArray());
        bool fileNameSet = false;
        object valuePattern;
        if (fileNameEdit.TryGetCurrentPattern(ValuePattern.Pattern, out valuePattern))
        {
            ValuePattern editableValue = (ValuePattern)valuePattern;
            if (!editableValue.Current.IsReadOnly)
            {
                try
                {
                    editableValue.SetValue(fileList);
                    fileNameSet = true;
                }
                catch (InvalidOperationException) { }
            }
        }
        if (!fileNameSet)
        {
            IntPtr editHandle = new IntPtr(SafeInt(delegate { return fileNameEdit.Current.NativeWindowHandle; }));
            if (editHandle == IntPtr.Zero) throw new InvalidOperationException("无法控制文件名输入框");
            SendMessage(editHandle, 0x000C, IntPtr.Zero, fileList);
        }

        AutomationElement openButton = null;
        Walk(dialog, 0, 12, 1000, delegate(AutomationElement element)
        {
            if (openButton != null) return;
            string automationId = SafeString(delegate { return element.Current.AutomationId; });
            string name = SafeString(delegate { return element.Current.Name; });
            string controlType = SafeString(delegate { return element.Current.ControlType.ProgrammaticName; });
            if (controlType == "ControlType.Button"
                && (name.StartsWith("打开", StringComparison.OrdinalIgnoreCase)
                    || (automationId == "1" && SafeString(delegate { return element.Current.ClassName; }) == "Button"))
                && Supports(element, InvokePattern.Pattern))
                openButton = element;
        });
        if (openButton == null) throw new InvalidOperationException("文件选择框中未找到打开按钮");
        ((InvokePattern)openButton.GetCurrentPattern(InvokePattern.Pattern)).Invoke();

        for (int attempt = 0; attempt < 100; attempt++)
        {
            Thread.Sleep(200);
            bool stillOpen = FindFileDialog(FindWindowRoots(Process.GetProcessesByName("JianyingPro"))) != null;
            if (!stillOpen) break;
            if (attempt == 99) throw new InvalidOperationException("剪映导入文件超时");
        }

        return new Dictionary<string, object>
        {
            { "success", true },
            { "message", "分段视频已提交到剪映素材库" },
            { "fileCount", files.Count }
        };
    }

    private static AutomationElement FindFileDialog(List<AutomationElement> roots)
    {
        AutomationElement dialog = null;
        foreach (AutomationElement root in roots)
        {
            string rootClass = SafeString(delegate { return root.Current.ClassName; });
            string rootName = SafeString(delegate { return root.Current.Name; });
            if (rootClass == "#32770" || rootName.IndexOf("选择媒体资源", StringComparison.OrdinalIgnoreCase) >= 0)
                return root;
            Walk(root, 0, 8, 1200, delegate(AutomationElement element)
            {
                if (dialog != null) return;
                string className = SafeString(delegate { return element.Current.ClassName; });
                string name = SafeString(delegate { return element.Current.Name; });
                if (className == "#32770" || name.IndexOf("选择媒体资源", StringComparison.OrdinalIgnoreCase) >= 0)
                    dialog = element;
            });
            if (dialog != null) break;
        }
        return dialog;
    }

    private static Dictionary<string, object> Probe(int maxElements, bool includeAllSamples)
    {
        Process[] processes = Process.GetProcessesByName("JianyingPro");
        List<AutomationElement> roots = FindWindowRoots(processes);
        List<Dictionary<string, object>> windows = new List<Dictionary<string, object>>();
        List<Dictionary<string, object>> samples = new List<Dictionary<string, object>>();
        int controlCount = 0;
        int namedControlCount = 0;
        int actionableControlCount = 0;

        foreach (AutomationElement root in roots)
        {
            windows.Add(Describe(root));
            Walk(root, 0, 20, maxElements, delegate(AutomationElement element)
            {
                controlCount++;
                Dictionary<string, object> description = Describe(element);
                if (!String.IsNullOrWhiteSpace((string)description["name"])) namedControlCount++;
                if ((bool)description["actionable"]) actionableControlCount++;
                if (samples.Count < (includeAllSamples ? maxElements : 40)) samples.Add(description);
            });
        }

        bool operable = roots.Count > 0 && controlCount > roots.Count && (namedControlCount > 0 || actionableControlCount > 0);
        return new Dictionary<string, object>
        {
            { "available", roots.Count > 0 },
            { "operable", operable },
            { "processCount", processes.Length },
            { "windowCount", roots.Count },
            { "controlCount", controlCount },
            { "namedControlCount", namedControlCount },
            { "actionableControlCount", actionableControlCount },
            { "message", operable ? "已读取剪映 UI Automation 控件树" : roots.Count > 0 ? "剪映窗口未暴露可操作控件" : "未找到剪映主窗口" },
            { "windows", windows },
            { "samples", samples }
        };
    }

    private static Dictionary<string, object> Launch(string executablePath, string configPath, int holdMilliseconds, int maxElements)
    {
        if (String.IsNullOrWhiteSpace(executablePath) || !File.Exists(executablePath))
            throw new FileNotFoundException("剪映可执行文件不存在", executablePath);

        FileStream configLock = null;
        try
        {
            if (!String.IsNullOrWhiteSpace(configPath) && File.Exists(configPath))
                configLock = new FileStream(configPath, FileMode.Open, FileAccess.Read, FileShare.Read);

            ProcessStartInfo startInfo = new ProcessStartInfo(executablePath);
            startInfo.UseShellExecute = false;
            startInfo.WorkingDirectory = Path.GetDirectoryName(executablePath);
            startInfo.EnvironmentVariables["QT_DISABLE_ACCESSIBILITY"] = "0";
            startInfo.EnvironmentVariables["QT_DISABLE_ACCESSIBLE_EVENT"] = "0";
            startInfo.EnvironmentVariables["ACCESSIBLE_DISABLE_UNIGNORED_CHILDREN"] = "0";
            Process.Start(startInfo);

            int waited = 0;
            while (waited < holdMilliseconds)
            {
                Thread.Sleep(500);
                waited += 500;
            }

            return Probe(maxElements, false);
        }
        finally
        {
            if (configLock != null) configLock.Dispose();
        }
    }

    private static Dictionary<string, object> Operate(string name, string automationId, string className, string controlType, int maxElements, string operation, string newValue)
    {
        if (String.IsNullOrWhiteSpace(name) && String.IsNullOrWhiteSpace(automationId) && String.IsNullOrWhiteSpace(className) && String.IsNullOrWhiteSpace(controlType))
            throw new ArgumentException("operation requires --name, --automation-id, --class-name or --control-type");

        List<AutomationElement> roots = FindWindowRoots(Process.GetProcessesByName("JianyingPro"));
        AutomationElement match = null;
        IntPtr targetWindowHandle = IntPtr.Zero;
        foreach (AutomationElement root in roots)
        {
            Walk(root, 0, 20, maxElements, delegate(AutomationElement element)
            {
                if (match != null) return;
                string elementName = SafeString(delegate { return element.Current.Name; });
                string elementAutomationId = SafeString(delegate { return element.Current.AutomationId; });
                string elementClassName = SafeString(delegate { return element.Current.ClassName; });
                string elementControlType = SafeString(delegate { return element.Current.ControlType.ProgrammaticName.Replace("ControlType.", ""); });
                Dictionary<string, object> description = Describe(element);
                string searchableText = elementName + " " + (string)description["value"] + " " + (string)description["helpText"] + " " + (string)description["legacyName"];
                bool nameMatches = String.IsNullOrWhiteSpace(name) || searchableText.IndexOf(name, StringComparison.OrdinalIgnoreCase) >= 0;
                bool idMatches = String.IsNullOrWhiteSpace(automationId) || String.Equals(elementAutomationId, automationId, StringComparison.OrdinalIgnoreCase);
                bool classMatches = String.IsNullOrWhiteSpace(className) || String.Equals(elementClassName, className, StringComparison.OrdinalIgnoreCase);
                bool typeMatches = String.IsNullOrWhiteSpace(controlType) || String.Equals(elementControlType, controlType, StringComparison.OrdinalIgnoreCase);
                if (nameMatches && idMatches && classMatches && typeMatches)
                {
                    match = element;
                    targetWindowHandle = new IntPtr(SafeInt(delegate { return root.Current.NativeWindowHandle; }));
                }
            });
            if (match != null) break;
        }

        if (match == null) throw new InvalidOperationException("未找到匹配的剪映控件");

        if (operation == "click" || operation == "double-click")
        {
            if (targetWindowHandle != IntPtr.Zero)
            {
                ShowWindow(targetWindowHandle, 9);
            }
            System.Windows.Point point;
            try { point = match.GetClickablePoint(); }
            catch
            {
                System.Windows.Rect bounds = match.Current.BoundingRectangle;
                point = new System.Windows.Point(bounds.Left + bounds.Width / 2, bounds.Top + bounds.Height / 2);
            }
            ClickWindowAtScreenPoint(
                targetWindowHandle,
                (int)Math.Round(point.X),
                (int)Math.Round(point.Y),
                operation == "double-click" ? 2 : 1);
        }
        else if (operation == "set-value")
        {
            try { match.SetFocus(); }
            catch { }
            object pattern;
            if (!match.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
                throw new InvalidOperationException("目标控件不支持设置文本");
            ((ValuePattern)pattern).SetValue(newValue ?? String.Empty);
        }
        else if (operation == "type-text")
        {
            if (targetWindowHandle != IntPtr.Zero)
            {
                SetForegroundWindow(targetWindowHandle);
                Thread.Sleep(200);
            }
            match.SetFocus();
            Thread.Sleep(100);
            keybd_event(0x11, 0, 0, UIntPtr.Zero);
            keybd_event(0x41, 0, 0, UIntPtr.Zero);
            keybd_event(0x41, 0, 0x0002, UIntPtr.Zero);
            keybd_event(0x11, 0, 0x0002, UIntPtr.Zero);
            SendUnicodeText(newValue ?? String.Empty);
        }
        else
        {
            object pattern;
            if (match.TryGetCurrentPattern(InvokePattern.Pattern, out pattern))
                ((InvokePattern)pattern).Invoke();
            else if (match.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern))
                ((SelectionItemPattern)pattern).Select();
            else if (match.TryGetCurrentPattern(TogglePattern.Pattern, out pattern))
                ((TogglePattern)pattern).Toggle();
            else
                match.SetFocus();
        }

        Thread.Sleep(250);
        return new Dictionary<string, object>
        {
            { "success", true },
            { "message", operation == "click" || operation == "double-click" ? "剪映控件点击成功" : operation == "set-value" ? "剪映控件文本设置成功" : "剪映控件操作成功" },
            { "element", Describe(match) }
        };
    }

    private static void ClickElement(AutomationElement element)
    {
        System.Windows.Point point;
        try { point = element.GetClickablePoint(); }
        catch
        {
            System.Windows.Rect bounds = element.Current.BoundingRectangle;
            point = new System.Windows.Point(bounds.Left + bounds.Width / 2, bounds.Top + bounds.Height / 2);
        }
        SetCursorPos((int)Math.Round(point.X), (int)Math.Round(point.Y));
        ClickMouse();
    }

    private static void ClickMouse()
    {
        mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
        mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
    }

    private static void ClickWindowAtScreenPoint(IntPtr handle, int screenX, int screenY, int count)
    {
        if (handle == IntPtr.Zero) throw new InvalidOperationException("无法读取剪映窗口句柄");
        NativePoint point = new NativePoint { X = screenX, Y = screenY };
        if (!ScreenToClient(handle, ref point))
            throw new InvalidOperationException("无法换算剪映窗口点击坐标");
        int packed = ((point.Y & 0xFFFF) << 16) | (point.X & 0xFFFF);
        IntPtr location = new IntPtr(packed);
        PostMessage(handle, 0x0200, IntPtr.Zero, location);
        PostMessage(handle, 0x0201, new IntPtr(1), location);
        PostMessage(handle, 0x0202, IntPtr.Zero, location);
        for (int index = 1; index < count; index++)
        {
            Thread.Sleep(100);
            PostMessage(handle, 0x0203, new IntPtr(1), location);
            PostMessage(handle, 0x0202, IntPtr.Zero, location);
        }
    }

    private static void EnsureMaximized(IntPtr handle)
    {
        if (handle == IntPtr.Zero) throw new InvalidOperationException("无法读取剪映窗口句柄");
        if (IsIconic(handle))
        {
            ShowWindow(handle, 9);
            Thread.Sleep(150);
        }
        if (!IsZoomed(handle))
        {
            ShowWindow(handle, 3);
            Thread.Sleep(350);
        }
        SetForegroundWindow(handle);
    }

    private static void SendUnicodeText(string text)
    {
        foreach (char character in text)
        {
            NativeInput[] inputs = new NativeInput[2];
            inputs[0].Type = 1;
            inputs[0].Union.Keyboard.Scan = character;
            inputs[0].Union.Keyboard.Flags = 0x0004;
            inputs[1].Type = 1;
            inputs[1].Union.Keyboard.Scan = character;
            inputs[1].Union.Keyboard.Flags = 0x0004 | 0x0002;
            if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(NativeInput))) == 0)
                throw new InvalidOperationException("剪映文本输入失败");
        }
    }

    [DllImport("user32.dll")]
    private static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    private static extern bool ScreenToClient(IntPtr windowHandle, ref NativePoint point);

    [DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr windowHandle, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr windowHandle);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr windowHandle, int command);

    [DllImport("user32.dll")]
    private static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr windowHandle, out NativeRect rect);

    [DllImport("user32.dll")]
    private static extern bool PrintWindow(IntPtr windowHandle, IntPtr deviceContext, uint flags);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr windowHandle);

    [DllImport("user32.dll")]
    private static extern bool IsZoomed(IntPtr windowHandle);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessage(IntPtr windowHandle, uint message, IntPtr wParam, string lParam);

    [DllImport("user32.dll")]
    private static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint inputCount, NativeInput[] inputs, int inputSize);

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeInput
    {
        public uint Type;
        public NativeInputUnion Union;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct NativeInputUnion
    {
        [FieldOffset(0)] public KeyboardInput Keyboard;
        [FieldOffset(0)] public MouseInput Mouse;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput
    {
        public int X;
        public int Y;
        public uint MouseData;
        public uint Flags;
        public uint Time;
        public UIntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardInput
    {
        public ushort VirtualKey;
        public ushort Scan;
        public uint Flags;
        public uint Time;
        public UIntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativePoint
    {
        public int X;
        public int Y;
    }

    private static List<AutomationElement> FindWindowRoots(Process[] processes)
    {
        List<AutomationElement> roots = new List<AutomationElement>();
        HashSet<IntPtr> handles = new HashSet<IntPtr>();
        HashSet<int> processIds = new HashSet<int>();
        foreach (Process process in processes)
        {
            try { processIds.Add(process.Id); }
            catch { }
        }

        AutomationElement desktopChild = null;
        try { desktopChild = TreeWalker.RawViewWalker.GetFirstChild(AutomationElement.RootElement); }
        catch { }
        while (desktopChild != null)
        {
            try
            {
                int processId = desktopChild.Current.ProcessId;
                IntPtr handle = new IntPtr(desktopChild.Current.NativeWindowHandle);
                if (processIds.Contains(processId) && handle != IntPtr.Zero && handles.Add(handle))
                    roots.Add(desktopChild);
            }
            catch { }

            try { desktopChild = TreeWalker.RawViewWalker.GetNextSibling(desktopChild); }
            catch { break; }
        }

        foreach (Process process in processes)
        {
            try
            {
                process.Refresh();
                IntPtr handle = process.MainWindowHandle;
                if (handle == IntPtr.Zero || !handles.Add(handle)) continue;
                AutomationElement element = AutomationElement.FromHandle(handle);
                if (element != null) roots.Add(element);
            }
            catch { }
        }
        return roots;
    }

    private static AutomationElement LargestWindow(List<AutomationElement> roots)
    {
        AutomationElement largest = roots[0];
        double largestArea = 0;
        foreach (AutomationElement root in roots)
        {
            try
            {
                System.Windows.Rect bounds = root.Current.BoundingRectangle;
                double area = bounds.Width * bounds.Height;
                if (area > largestArea)
                {
                    largest = root;
                    largestArea = area;
                }
            }
            catch { }
        }
        return largest;
    }

    private static void Walk(AutomationElement parent, int depth, int maxDepth, int maxElements, Action<AutomationElement> visitor)
    {
        if (depth > maxDepth || maxElements <= 0) return;
        AutomationElement child;
        try { child = TreeWalker.RawViewWalker.GetFirstChild(parent); }
        catch { return; }

        int visited = 0;
        while (child != null && visited < maxElements)
        {
            visitor(child);
            visited++;
            Walk(child, depth + 1, maxDepth, maxElements - visited, visitor);
            try { child = TreeWalker.RawViewWalker.GetNextSibling(child); }
            catch { break; }
        }
    }

    private static Dictionary<string, object> Describe(AutomationElement element)
    {
        string value = String.Empty;
        string legacyName = String.Empty;
        object valuePattern;
        if (element.TryGetCurrentPattern(ValuePattern.Pattern, out valuePattern))
            value = SafeString(delegate { return ((ValuePattern)valuePattern).Current.Value; });
        System.Windows.Rect bounds;
        try { bounds = element.Current.BoundingRectangle; }
        catch { bounds = System.Windows.Rect.Empty; }
        bool actionable = Supports(element, InvokePattern.Pattern)
            || Supports(element, SelectionItemPattern.Pattern)
            || Supports(element, TogglePattern.Pattern);
        return new Dictionary<string, object>
        {
            { "name", SafeString(delegate { return element.Current.Name; }) },
            { "automationId", SafeString(delegate { return element.Current.AutomationId; }) },
            { "controlType", SafeString(delegate { return element.Current.ControlType.ProgrammaticName.Replace("ControlType.", ""); }) },
            { "className", SafeString(delegate { return element.Current.ClassName; }) },
            { "value", value },
            { "helpText", SafeString(delegate { return element.Current.HelpText; }) },
            { "legacyName", legacyName },
            { "left", bounds.IsEmpty ? 0 : bounds.Left },
            { "top", bounds.IsEmpty ? 0 : bounds.Top },
            { "width", bounds.IsEmpty ? 0 : bounds.Width },
            { "height", bounds.IsEmpty ? 0 : bounds.Height },
            { "enabled", SafeBool(delegate { return element.Current.IsEnabled; }) },
            { "actionable", actionable }
        };
    }

    private static bool Supports(AutomationElement element, AutomationPattern pattern)
    {
        try { object value; return element.TryGetCurrentPattern(pattern, out value); }
        catch { return false; }
    }

    private static string SafeString(Func<string> reader)
    {
        try { return reader() ?? String.Empty; }
        catch { return String.Empty; }
    }

    private static bool SafeBool(Func<bool> reader)
    {
        try { return reader(); }
        catch { return false; }
    }

    private static int SafeInt(Func<int> reader)
    {
        try { return reader(); }
        catch { return 0; }
    }

    private static string ReadArgument(string[] args, string name)
    {
        for (int index = 0; index < args.Length - 1; index++)
            if (String.Equals(args[index], name, StringComparison.OrdinalIgnoreCase)) return args[index + 1];
        return null;
    }

    private static List<string> ReadArguments(string[] args, string name)
    {
        List<string> values = new List<string>();
        for (int index = 0; index < args.Length - 1; index++)
            if (String.Equals(args[index], name, StringComparison.OrdinalIgnoreCase)) values.Add(args[index + 1]);
        return values;
    }

    private static int ReadIntArgument(string[] args, string name, int fallback)
    {
        int result;
        return Int32.TryParse(ReadArgument(args, name), out result) ? result : fallback;
    }

    private static long ReadLongArgument(string[] args, string name, long fallback)
    {
        long result;
        return Int64.TryParse(ReadArgument(args, name), out result) ? result : fallback;
    }

    private static void WriteJson(object value)
    {
        Console.OutputEncoding = System.Text.Encoding.UTF8;
        Console.Write(Json.Serialize(value));
    }
}
