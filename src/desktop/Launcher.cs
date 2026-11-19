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

    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        bool first;
        using (var mutex = new Mutex(true, "Local\\InfiniteCanvasDesktopLauncher", out first))
        {
            if (!first) return;
            try
            {
                if (!Ready()) StartServer();
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
                            window.Refresh();
                            bool visible = window.MainWindowHandle != IntPtr.Zero;
                            if (visible) seen = true;
                            if (seen && !visible) break;
                            if (!seen && startupTicks++ > 120) break;
                            Thread.Sleep(250);
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
        using (var form = new Form { Text = "无限画布", Width = 1520, Height = 940, StartPosition = FormStartPosition.CenterScreen })
        using (var browser = new WebBrowser { Dock = DockStyle.Fill, ScriptErrorsSuppressed = true })
        {
            var hint = new Label { Dock = DockStyle.Top, Height = 42,
                Text = "当前使用系统兼容视图。如画布无法显示，请安装现代浏览器后重新打开无限画布。" };
            form.Controls.Add(browser);
            form.Controls.Add(hint);
            browser.Navigate(Url);
            Application.Run(form);
        }
    }

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
