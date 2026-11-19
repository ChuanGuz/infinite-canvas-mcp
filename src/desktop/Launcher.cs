using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class Launcher
{
    private const string Url = "http://127.0.0.1:3456";
    private static readonly string Root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
    private static Process ownedServer;
    private static IntPtr serverJob;
    private static WindowController controller;
    private static IntPtr keyboardHook;
    private static readonly KeyboardProc keyboardProc = KeyboardShortcut;

    [STAThread]
    private static void Main()
    {
        // Use physical monitor coordinates, including on mixed-DPI desktops.
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
        catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        bool first;
        using (var mutex = new Mutex(true, "Local\\InfiniteCanvasDesktopLauncher", out first))
        {
            if (!first) return;
            try
            {
                if (!Ready()) StartServer();
                // One owner consumes desktop shortcuts before Chromium can toggle too.
                keyboardHook = SetWindowsHookEx(13, keyboardProc, GetModuleHandle(null), 0); // WH_KEYBOARD_LL
                if (keyboardHook == IntPtr.Zero) throw new InvalidOperationException("无法注册窗口快捷键。");
                string browser = FindBrowser();
                if (browser != null)
                {
                    string profile = Path.Combine(Root, "data", "desktop_app_profile");
                    Directory.CreateDirectory(profile);
                    using (Process window = Process.Start(new ProcessStartInfo(browser,
                        "--app=" + Url + " --user-data-dir=" + Quote(profile) +
                        " --window-size=1520,940 --no-first-run --no-default-browser-check --disable-background-mode")
                    { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Root }))
                    {
                        // App mode has no address bar, tabs, bookmarks, or console window.
                        // Wait for the app window, not Chromium background processes.
                        bool seen = false;
                        int startupTicks = 0;
                        while (!window.HasExited)
                        {
                            Application.DoEvents(); // Dispatch the foreground keyboard hook.
                            window.Refresh();
                            bool visible = window.MainWindowHandle != IntPtr.Zero;
                            if (visible)
                            {
                                seen = true;
                                if (controller == null || controller.Handle != window.MainWindowHandle)
                                    controller = new WindowController(window.MainWindowHandle, null);
                                controller.Tick();
                            }
                            if (seen && !visible) break;
                            if (!seen && startupTicks++ > 600) break;
                            Thread.Sleep(50);
                        }
                        if (!seen) ShowFallback();
                    }
                }
                else ShowFallback();
            }
            catch (Exception error)
            {
                MessageBox.Show("无限画布启动失败：\n" + error.Message + "\n请确认已安装运行环境并在项目目录安装依赖。",
                    "无限画布", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            finally
            {
                if (keyboardHook != IntPtr.Zero) UnhookWindowsHookEx(keyboardHook);
                // Only the server created by this launcher belongs to this lifetime.
                if (serverJob != IntPtr.Zero) CloseHandle(serverJob);
                if (ownedServer != null)
                {
                    try { if (!ownedServer.HasExited) ownedServer.Kill(); } catch { }
                    ownedServer.Dispose();
                }
                mutex.ReleaseMutex();
            }
        }
    }

    private static bool Ready()
    {
        try
        {
            var request = (HttpWebRequest)WebRequest.Create(Url + "/api/canvases");
            request.Proxy = null;
            request.Timeout = 700;
            request.ReadWriteTimeout = 700;
            using (var response = (HttpWebResponse)request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream()))
                return response.StatusCode == HttpStatusCode.OK && reader.ReadToEnd().TrimStart().StartsWith("[");
        }
        catch { return false; }
    }

    private static void StartServer()
    {
        string node = FindNode();
        string cli = Path.Combine(Root, "node_modules", "tsx", "dist", "cli.mjs");
        if (node == null || !File.Exists(cli)) throw new InvalidOperationException("缺少运行环境或项目依赖。");
        var start = new ProcessStartInfo(node, Quote(cli) + " " + Quote(Path.Combine(Root, "src", "index.ts")))
        {
            WorkingDirectory = Root, UseShellExecute = false, CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden, RedirectStandardOutput = true, RedirectStandardError = true
        };
        start.EnvironmentVariables["HOST"] = "127.0.0.1";
        start.EnvironmentVariables["PORT"] = "3456";
        start.EnvironmentVariables["DATA_DIR"] = Path.Combine(Root, "data");
        ownedServer = Process.Start(start);
        ownedServer.OutputDataReceived += delegate { };
        ownedServer.ErrorDataReceived += delegate { };
        ownedServer.BeginOutputReadLine();
        ownedServer.BeginErrorReadLine();
        // A job closes the tsx child as well as its parent, including on launcher termination.
        serverJob = CreateJobObject(IntPtr.Zero, null);
        var limits = new JobLimits();
        limits.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        int length = Marshal.SizeOf(limits);
        IntPtr buffer = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.StructureToPtr(limits, buffer, false);
            if (serverJob == IntPtr.Zero || !SetInformationJobObject(serverJob, 9, buffer, (uint)length) ||
                !AssignProcessToJobObject(serverJob, ownedServer.Handle))
                throw new InvalidOperationException("无法建立后台服务的生命周期管理。");
        }
        finally { Marshal.FreeHGlobal(buffer); }
        for (int attempt = 0; attempt < 100; attempt++)
        {
            if (Ready()) return;
            if (ownedServer.HasExited) throw new InvalidOperationException("后台服务提前退出，请检查项目依赖与数据文件。");
            Thread.Sleep(250);
        }
        throw new TimeoutException("等待本机服务启动超时。");
    }

    private static string FindNode()
    {
        foreach (string directory in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
        {
            string candidate = Path.Combine(directory.Trim().Trim('"'), "node.exe");
            if (File.Exists(candidate)) return candidate;
        }
        string conventional = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe");
        if (File.Exists(conventional)) return conventional;
        string local = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "nodejs-24");
        if (Directory.Exists(local))
            foreach (string candidate in Directory.GetFiles(local, "node.exe", SearchOption.AllDirectories)) return candidate;
        return null;
    }

    private static string FindBrowser()
    {
        foreach (string exe in new[] { "msedge.exe", "chrome.exe" })
        {
            foreach (RegistryKey hive in new[] { Registry.CurrentUser, Registry.LocalMachine })
                using (RegistryKey key = hive.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\" + exe))
                {
                    string candidate = key == null ? null : key.GetValue(null) as string;
                    if (candidate != null && File.Exists(candidate)) return candidate;
                }
            foreach (string folder in new[] { Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) })
            {
                string candidate = Path.Combine(folder, exe == "msedge.exe" ? @"Microsoft\Edge\Application\msedge.exe" : @"Google\Chrome\Application\chrome.exe");
                if (File.Exists(candidate)) return candidate;
            }
        }
        return null;
    }

    private static void ShowFallback()
    {
        using (var form = new Form { Text = "", Width = 1520, Height = 940, StartPosition = FormStartPosition.CenterScreen })
        using (var browser = new WebBrowser { Dock = DockStyle.Fill, ScriptErrorsSuppressed = true })
        using (var timer = new System.Windows.Forms.Timer { Interval = 50 })
        {
            var hint = new Label { Dock = DockStyle.Top, Height = 42,
                Text = "当前使用系统兼容视图。如画布无法显示，请安装现代浏览器后重新打开无限画布。" };
            form.Controls.Add(browser);
            form.Controls.Add(hint);
            form.Shown += delegate { controller = new WindowController(form.Handle, form); timer.Start(); };
            timer.Tick += delegate { controller.Tick(); };
            form.FormClosed += delegate { timer.Stop(); controller = null; };
            browser.Navigate(Url);
            Application.Run(form);
        }
    }

    private static IntPtr KeyboardShortcut(int code, IntPtr message, IntPtr data)
    {
        // Let only our marked synthetic key reach Chromium without toggling twice.
        if (code >= 0 && controller != null && Marshal.ReadIntPtr(data, 16) != new IntPtr(FullscreenKeyTag))
        {
            int kind = message.ToInt32();
            bool down = kind == 0x0100 || kind == 0x0104;
            bool up = kind == 0x0101 || kind == 0x0105;
            bool focused = GetAncestor(GetForegroundWindow(), 2) == controller.Handle;
            if ((down || up) && controller.HandleShortcut(Marshal.ReadInt32(data), down, focused))
                return new IntPtr(1);
        }
        return CallNextHookEx(keyboardHook, code, message, data);
    }

    private sealed class WindowController
    {
        internal readonly IntPtr Handle;
        internal bool Fullscreen;
        private readonly Form form;
        private bool f11Down, escapeDown, browserFullscreen;
        private Rect windowedBounds;
        private bool hasWindowedBounds;
        private DateTime settleUntil = DateTime.UtcNow.AddMilliseconds(500);
        private DateTime windowedStableSince = DateTime.MinValue;

        internal WindowController(IntPtr handle, Form fallback)
        {
            Handle = handle;
            form = fallback;
        }

        internal void Tick()
        {
            SetWindowTextW(Handle, "");
            if (form == null && browserFullscreen != Fullscreen)
            {
                // Accelerators require actual keyboard input; posted WM_KEYDOWN
                // does not update keyboard state and can be ignored by Chromium.
                // Never deliver a synthetic key to an unrelated foreground app.
                if (GetAncestor(GetForegroundWindow(), 2) != Handle) return;
                var keys = new[] {
                    new KeyInput { Type = 1, VirtualKey = VK_F11, ExtraInfo = new UIntPtr(FullscreenKeyTag) },
                    new KeyInput { Type = 1, VirtualKey = VK_F11, Flags = 2, ExtraInfo = new UIntPtr(FullscreenKeyTag) }
                };
                if (SendInput(2, keys, Marshal.SizeOf(typeof(KeyInput))) != 2)
                    throw new InvalidOperationException("无法切换窗口全屏状态。");
                browserFullscreen = Fullscreen;
                settleUntil = DateTime.UtcNow.AddMilliseconds(350);
                return;
            }
            // Chromium hides its custom caption first; then enforce physical monitor bounds.
            if (DateTime.UtcNow < settleUntil) return;
            if (IsIconic(Handle)) return;
            if (!Fullscreen && settleUntil == DateTime.MinValue && IsZoomed(Handle)) { SetFullscreen(true); return; }
            if (Fullscreen) ApplyFullscreen();
            else if (settleUntil != DateTime.MinValue)
            {
                // Chromium can asynchronously restore its old maximized rectangle
                // after F11. Keep restoring until the native rectangle stays stable,
                // before treating another maximize as a new user request.
                if (!ApplyWindowed()) windowedStableSince = DateTime.MinValue;
                else if (windowedStableSince == DateTime.MinValue) windowedStableSince = DateTime.UtcNow;
                if (windowedStableSince == DateTime.MinValue ||
                    (DateTime.UtcNow - windowedStableSince).TotalMilliseconds < 500) return;
                hasWindowedBounds = GetWindowRect(Handle, out windowedBounds);
            }
            else if (!Fullscreen) hasWindowedBounds = GetWindowRect(Handle, out windowedBounds);
            settleUntil = DateTime.MinValue;
        }

        internal bool HandleShortcut(int key, bool down, bool focused)
        {
            if (key != VK_F11 && key != VK_ESCAPE) return false;
            bool held = key == VK_F11 ? f11Down : escapeDown;
            if (!down)
            {
                if (key == VK_F11) f11Down = false; else escapeDown = false;
                return held && focused;
            }
            if (!focused) return false;
            if (held) return true; // Holding a key must not repeatedly toggle.
            if (key == VK_ESCAPE && !Fullscreen) return false; // Normal dialogs keep Esc.
            if (key == VK_F11) f11Down = true; else escapeDown = true;
            SetFullscreen(key == VK_F11 ? !Fullscreen : false);
            return true;
        }

        private void SetFullscreen(bool full)
        {
            if (full == Fullscreen) return;
            if (full && settleUntil == DateTime.MinValue && !IsZoomed(Handle) && !IsIconic(Handle))
                hasWindowedBounds = GetWindowRect(Handle, out windowedBounds);
            Fullscreen = full;
            settleUntil = DateTime.UtcNow.AddMilliseconds(350);
            windowedStableSince = DateTime.MinValue;
        }

        private MonitorInfo Monitor()
        {
            var info = new MonitorInfo { Size = Marshal.SizeOf(typeof(MonitorInfo)) };
            if (!GetMonitorInfo(MonitorFromWindow(Handle, 2), ref info))
                throw new InvalidOperationException("无法读取显示器边界。");
            return info;
        }

        private void ApplyFullscreen()
        {
            Rect bounds = Monitor().rcMonitor;
            if (form != null && form.FormBorderStyle != FormBorderStyle.None)
            {
                form.FormBorderStyle = FormBorderStyle.None;
                form.WindowState = FormWindowState.Maximized;
            }
            int style = GetWindowLong(Handle, GWL_STYLE);
            Rect current, client;
            GetWindowRect(Handle, out current);
            GetClientRect(Handle, out client);
            if ((style & WindowDecorations) == 0 && current.Equals(bounds) &&
                client.Right == bounds.Right - bounds.Left && client.Bottom == bounds.Bottom - bounds.Top) return;
            SetWindowLong(Handle, GWL_STYLE, style & ~WindowDecorations);
            SetWindowPos(Handle, IntPtr.Zero, bounds.Left, bounds.Top,
                bounds.Right - bounds.Left, bounds.Bottom - bounds.Top, SWP_FRAMECHANGED | SWP_NOZORDER | SWP_NOACTIVATE);
        }

        private bool ApplyWindowed()
        {
            Rect work = Monitor().rcWork;
            int width = Math.Min(1520, (work.Right - work.Left) * 4 / 5);
            int height = Math.Min(940, (work.Bottom - work.Top) * 4 / 5);
            int left = work.Left + (work.Right - work.Left - width) / 2;
            int top = work.Top + (work.Bottom - work.Top - height) / 2;
            if (hasWindowedBounds)
            {
                width = Math.Min(windowedBounds.Right - windowedBounds.Left, work.Right - work.Left);
                height = Math.Min(windowedBounds.Bottom - windowedBounds.Top, work.Bottom - work.Top);
                left = Math.Max(work.Left, Math.Min(windowedBounds.Left, work.Right - width));
                top = Math.Max(work.Top, Math.Min(windowedBounds.Top, work.Bottom - height));
            }
            Rect current;
            GetWindowRect(Handle, out current);
            if (!IsZoomed(Handle) && (GetWindowLong(Handle, GWL_STYLE) & WindowDecorations) == WindowDecorations &&
                current.Left == left && current.Top == top && current.Right == left + width && current.Bottom == top + height)
                return true;
            if (form != null)
            {
                form.WindowState = FormWindowState.Normal;
                form.FormBorderStyle = FormBorderStyle.Sizable;
            }
            ShowWindow(Handle, 9); // SW_RESTORE clears maximize before the next monitor tick.
            SetWindowLong(Handle, GWL_STYLE, (GetWindowLong(Handle, GWL_STYLE) | WindowDecorations) & ~WS_MAXIMIZE);
            SetWindowPos(Handle, IntPtr.Zero, left, top, width, height,
                SWP_FRAMECHANGED | SWP_NOZORDER | SWP_NOACTIVATE);
            SetWindowTextW(Handle, "");
            return false;
        }
    }

    private const int GWL_STYLE = -16, VK_F11 = 0x7A, VK_ESCAPE = 0x1B;
    private const int WS_CAPTION = 0x00C00000, WS_THICKFRAME = 0x00040000,
        WS_MINIMIZEBOX = 0x00020000, WS_MAXIMIZEBOX = 0x00010000, WS_SYSMENU = 0x00080000, WS_MAXIMIZE = 0x01000000;
    private const int WindowDecorations = WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU;
    private const uint SWP_FRAMECHANGED = 0x0020, SWP_NOZORDER = 0x0004, SWP_NOACTIVATE = 0x0010;
    [StructLayout(LayoutKind.Sequential)] private struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] private struct MonitorInfo { public int Size; public Rect rcMonitor, rcWork; public uint Flags; }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool SetWindowTextW(IntPtr hwnd, string text);
    [DllImport("user32.dll")] private static extern bool IsZoomed(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr hwnd, int index);
    [DllImport("user32.dll")] private static extern int SetWindowLong(IntPtr hwnd, int index, int value);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    private delegate IntPtr KeyboardProc(int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll")] private static extern IntPtr SetWindowsHookEx(int type, KeyboardProc callback, IntPtr module, uint thread);
    [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string name);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    private const uint FullscreenKeyTag = 0x49434653;
    // INPUT/KEYBDINPUT union offsets for this launcher's x64 build.
    [StructLayout(LayoutKind.Explicit, Size = 40)] private struct KeyInput
    {
        [FieldOffset(0)] public uint Type;
        [FieldOffset(8)] public ushort VirtualKey;
        [FieldOffset(12)] public uint Flags;
        [FieldOffset(24)] public UIntPtr ExtraInfo;
    }
    [DllImport("user32.dll")] private static extern uint SendInput(uint count, KeyInput[] inputs, int size);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr context);

    private static string Quote(string value) { return "\"" + value + "\""; }
    [StructLayout(LayoutKind.Sequential)] private struct BasicLimits
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] private struct JobLimits
    {
        public BasicLimits BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll")] private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll")] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
}
