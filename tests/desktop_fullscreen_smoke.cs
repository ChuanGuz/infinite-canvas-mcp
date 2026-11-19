using System;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

internal static class FullscreenSmoke
{
    private const BindingFlags Private = BindingFlags.Instance | BindingFlags.NonPublic;
    private const int Decorations = 0x00CF0000;
    private static Type type;
    private static MethodInfo tick, shortcut;
    [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr hwnd, int index);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
    [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, System.Text.StringBuilder text, int length);
    [StructLayout(LayoutKind.Sequential)] private struct Rect { public int Left, Top, Right, Bottom; }
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    private static bool Full(object controller) { return (bool)type.GetField("Fullscreen", Private).GetValue(controller); }
    private static bool Key(object controller, int key, bool down, bool focused)
    { return (bool)shortcut.Invoke(controller, new object[] { key, down, focused }); }
    private static void Press(object controller, int key)
    {
        Check(Key(controller, key, true, true), "Fullscreen shortcut must be consumed");
        bool expected = Full(controller);
        Check(Key(controller, key, true, true) && Full(controller) == expected, "Key repeat toggled twice");
        Check(Key(controller, key, false, true), "Consumed shortcut keyup leaked to browser");
    }
    // Require a stable result instead of racing a fixed delay against Chromium.
    private static void Wait(object controller, string phase, Action assertion)
    {
        var watch = Stopwatch.StartNew();
        long stable = -1;
        Exception last = null;
        while (watch.ElapsedMilliseconds < 6000)
        {
            Application.DoEvents();
            if (type.GetField("form", Private).GetValue(controller) == null &&
                (bool)type.GetField("browserFullscreen", Private).GetValue(controller) != Full(controller))
            {
                // No global F11 or focus races in automation: the parent controls
                // Chromium's fullscreen state via CDP, then native bounds are tested.
                Console.WriteLine(Full(controller) ? "BROWSER_FULL" : "BROWSER_NORMAL");
                Check(Console.ReadLine() == "OK", "Browser transition failed");
                type.GetField("browserFullscreen", Private).SetValue(controller, Full(controller));
            }
            tick.Invoke(controller, null);
            try
            {
                Check((DateTime)type.GetField("settleUntil", Private).GetValue(controller) == DateTime.MinValue,
                    "Native transition is still pending");
                assertion();
                if (stable < 0) stable = watch.ElapsedMilliseconds;
                if (watch.ElapsedMilliseconds - stable >= 500) return;
            }
            catch (Exception error) { last = error; stable = -1; }
            Thread.Sleep(20);
        }
        IntPtr hwnd = (IntPtr)type.GetField("Handle", Private).GetValue(controller);
        Rect rect; GetWindowRect(hwnd, out rect);
        Rect client; GetClientRect(hwnd, out client);
        Console.Error.WriteLine("State: full=" + Full(controller) + " style=" + GetWindowLong(hwnd, -16).ToString("X") +
            " hwnd=" + hwnd + " foreground=" + GetForegroundWindow() + " rect=" + rect.Left + "," + rect.Top + "," + rect.Right + "," + rect.Bottom + " client=" + client.Right + "," + client.Bottom + " work=" + Screen.FromHandle(hwnd).WorkingArea);
        throw new Exception("Window did not settle: " + phase, last);
    }
    [STAThread] private static void Main(string[] args)
    {
        try
        {
            SetProcessDpiAwarenessContext(new IntPtr(-4));
            var launcher = Assembly.LoadFrom(args[0]).GetType("Launcher");
            type = launcher.GetNestedType("WindowController", BindingFlags.NonPublic);
            tick = type.GetMethod("Tick", Private);
            shortcut = type.GetMethod("HandleShortcut", Private);
            using (var form = new Form { Text = "Redundant title", Width = 800, Height = 600 })
            {
                form.Show();
                Exercise(form.Handle, form);
                Console.WriteLine("Native fullscreen checks passed");
                if (args.Length > 1) CheckBrowser(args[1], args[2]);
            }
        }
        catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
    }
    private static void Exercise(IntPtr hwnd, Form form)
    {
        object controller = Activator.CreateInstance(type, Private, null, new object[] { hwnd, form }, null);
        Wait(controller, "windowed startup", delegate { AssertWindowed(hwnd); });
        Press(controller, 0x7A);
        Wait(controller, "F11 startup", delegate { AssertFull(hwnd); });
        Check(!Key(controller, 0x7A, true, false) && Full(controller), "Background F11 was intercepted");
        Check(!Key(controller, 0x1B, true, false) && Full(controller), "Background Esc was intercepted");
        Check(!Key(controller, 0x41, true, true), "Ordinary key was intercepted");
        Press(controller, 0x1B);
        Wait(controller, "Esc exit", delegate { AssertWindowed(hwnd); });
        Check(!Key(controller, 0x1B, true, true), "Windowed Esc must remain available to dialogs");
        Key(controller, 0x1B, false, true);
        var work = Screen.FromHandle(hwnd).WorkingArea;
        SetWindowPos(hwnd, IntPtr.Zero, work.Left + 35, work.Top + 40,
            Math.Min(800, work.Width - 70), Math.Min(600, work.Height - 80), 0x0014);
        Wait(controller, "custom window bounds", delegate { AssertWindowed(hwnd); });
        Rect original;
        GetWindowRect(hwnd, out original);
        ShowWindow(hwnd, 3); // The native square caption button maximizes the window.
        Wait(controller, "maximize", delegate { AssertFull(hwnd); Check(Full(controller), "Maximize did not enter fullscreen"); });
        Press(controller, 0x7A);
        Wait(controller, "F11 exit after maximize", delegate {
            AssertWindowed(hwnd);
            Rect restored; GetWindowRect(hwnd, out restored);
            Check(restored.Equals(original), "Previous window size/position was not restored");
        });
        Press(controller, 0x7A);
        Wait(controller, "F11 enter", delegate { AssertFull(hwnd); });
        ShowWindow(hwnd, 6);
        Wait(controller, "minimize", delegate { Check(IsIconic(hwnd), "Monitor loop unminimized the app"); });
        ShowWindow(hwnd, 9);
        Wait(controller, "restore minimized", delegate { AssertFull(hwnd); });
        Press(controller, 0x1B);
        Wait(controller, "Esc exit after restore", delegate { AssertWindowed(hwnd); });
    }
    private static void CheckBrowser(string executable, string profile)
    {
        using (var process = Process.Start(new ProcessStartInfo(executable,
            "--app=data:text/html,%3Ctitle%3E%26%2365279%3B%3C/title%3E --remote-debugging-port=0 --window-size=800,600 --disable-gpu --no-sandbox --disable-extensions --disable-background-networking --no-first-run --no-default-browser-check --disable-background-mode --user-data-dir=\"" + profile + "\"")
            { UseShellExecute = false, WindowStyle = ProcessWindowStyle.Hidden }))
        {
            try
            {
                var watch = Stopwatch.StartNew();
                while (process.MainWindowHandle == IntPtr.Zero && watch.ElapsedMilliseconds < 10000)
                { Thread.Sleep(50); process.Refresh(); }
                Check(process.MainWindowHandle != IntPtr.Zero, "Browser app window did not open");
                Console.WriteLine("BROWSER_READY");
                Check(Console.ReadLine() == "OK", "Browser automation did not connect");
                Exercise(process.MainWindowHandle, null);
                Console.WriteLine("Chromium app fullscreen checks passed");
            }
            finally
            {
                process.Refresh();
                if (!process.HasExited) { process.CloseMainWindow(); if (!process.WaitForExit(3000)) { process.Kill(); process.WaitForExit(); } }
            }
        }
    }
    private static void AssertTitle(IntPtr hwnd)
    {
        var text = new System.Text.StringBuilder(256);
        GetWindowText(hwnd, text, text.Capacity);
        Check(text.Length == 0, "Window title was not cleared");
    }
    private static void AssertWindowed(IntPtr hwnd)
    {
        Check((GetWindowLong(hwnd, -16) & Decorations) == Decorations, "Native caption buttons/border not restored");
        Check((GetWindowLong(hwnd, -16) & 0x01000000) == 0, "Window still maximized");
        Rect rect; GetWindowRect(hwnd, out rect);
        var work = Screen.FromHandle(hwnd).WorkingArea;
        Check(rect.Right - rect.Left < work.Width, "Window did not leave fullscreen");
        AssertTitle(hwnd);
    }
    private static void AssertFull(IntPtr hwnd)
    {
        Rect rect; GetWindowRect(hwnd, out rect);
        var bounds = Screen.FromHandle(hwnd).Bounds;
        Check(rect.Left == bounds.Left && rect.Top == bounds.Top && rect.Right == bounds.Right && rect.Bottom == bounds.Bottom,
            "Window must exactly cover rcMonitor, including the taskbar");
        Check((GetWindowLong(hwnd, -16) & Decorations) == 0, "Fullscreen still has caption/buttons");
        Rect client; GetClientRect(hwnd, out client);
        Check(client.Right == bounds.Width && client.Bottom == bounds.Height, "Client area does not fill the monitor");
        AssertTitle(hwnd);
    }
}
