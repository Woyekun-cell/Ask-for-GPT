using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using AskGPT.Windows.Core;
using Microsoft.Win32;
using Forms = System.Windows.Forms;

namespace AskGPT.Windows;

internal sealed record WindowLayoutSnapshot(double Width, double Height, double ViewportWidth, double ViewportHeight, double ContentHeight, double ScrollableHeight);

internal sealed class DesktopApp : Application
{
    private readonly bool smokeTest;
    private readonly string? smokeArtifactPrefix;
    private readonly CancellationTokenSource lifetime = new();
    private readonly SelectionCapture capture = new();
    private readonly PreparationRunner preparation = new();
    private ReaderRuntime? runtime;
    private SettingsWindow? settings;
    private ReaderWindow? reader;
    private HotkeyManager? hotkey;
    private AutomaticSelectionObserver? automatic;
    private Forms.NotifyIcon? tray;
    private CancellationTokenSource? captureRequest;
    private bool exiting;
    private string lastAutomaticText = "";
    private IntPtr lastAutomaticWindow;
    private DateTime lastAutomaticTime;
    public bool SmokeWindowsCreated { get; private set; }
    public bool SmokeTrayInitialized { get; private set; }
    public bool SmokeRuntimeStopped { get; private set; }
    public bool SmokeLayoutVerified { get; private set; }
    public bool SmokeGlobalInputsDisabled { get; private set; }
    public bool SmokeScreenshotsCreated { get; private set; }
    public WindowLayoutSnapshot? SmokeSettingsLayout { get; private set; }
    public WindowLayoutSnapshot? SmokeReaderLayout { get; private set; }
    public string SmokeError { get; private set; } = "";

    public DesktopApp(bool smokeTest, string? smokeArtifactPrefix = null)
    {
        this.smokeTest = smokeTest;
        this.smokeArtifactPrefix = smokeArtifactPrefix;
        ShutdownMode = ShutdownMode.OnExplicitShutdown;
        DispatcherUnhandledException += (_, args) =>
        {
            args.Handled = true;
            if (smokeTest) { SmokeError = Ui.Error(args.Exception); _ = QuitAsync(1); return; }
            if (settings is not null) settings.SetStatus(Ui.Error(args.Exception));
            else { MessageBox.Show("启动失败：" + Ui.Error(args.Exception), "Ask for GPT", MessageBoxButton.OK, MessageBoxImage.Error); Shutdown(1); }
        };
    }

    protected override async void OnStartup(StartupEventArgs args)
    {
        base.OnStartup(args);
        try
        {
            runtime = await ReaderRuntime.StartAsync(lifetime.Token);
            reader = new ReaderWindow(runtime, ShowSettings);
            settings = new SettingsWindow(runtime, SaveAsync, PrepareAsync, StartPdfAsync, ExportAsync, OpenGuide, LoginHelp, () => _ = QuitAsync());
            MainWindow = settings;
            if (smokeTest)
            {
                // Use the real windows and tray on an isolated data directory.
                // No input hook, hotkey, provider request, or component download.
                CreateTray();
                reader.PrepareSmokePreview();
                settings.Show(); reader.Show();
                await Dispatcher.InvokeAsync(() => { }, DispatcherPriority.ApplicationIdle);
                settings.UpdateLayout(); reader.UpdateLayout();
                SmokeWindowsCreated = new WindowInteropHelper(settings).Handle != IntPtr.Zero && new WindowInteropHelper(reader).Handle != IntPtr.Zero
                    && settings.IsMeasureValid && reader.IsMeasureValid;
                SmokeTrayInitialized = tray is { Visible: true, ContextMenuStrip.Items.Count: > 0 };
                SmokeLayoutVerified = settings.IsLayoutReachable() && reader.IsLayoutReachable();
                SmokeSettingsLayout = CaptureLayout(settings);
                SmokeReaderLayout = CaptureLayout(reader);
                SmokeGlobalInputsDisabled = hotkey is null && automatic is null;
                if (!SmokeWindowsCreated || !SmokeTrayInitialized || !SmokeLayoutVerified || !SmokeGlobalInputsDisabled) throw new InvalidOperationException("窗口、托盘或布局初始化检查失败。");
                if (smokeArtifactPrefix is not null)
                {
                    SaveRendererPreview(settings, smokeArtifactPrefix + "-settings.png");
                    SaveRendererPreview(reader, smokeArtifactPrefix + "-reader.png");
                    SmokeScreenshotsCreated = true;
                }
                if (PolicyChecks.Run(Console.Out) != 0) throw new InvalidOperationException("选区策略检查失败。");
                await Dispatcher.InvokeAsync(() => { }, DispatcherPriority.ApplicationIdle);
                await QuitAsync();
                return;
            }
            hotkey = new HotkeyManager();
            hotkey.Pressed += () => _ = CaptureAsync(false);
            string? hotkeyError = null;
            try { hotkey.Set(runtime.Settings.HotKeyModifiers, runtime.Settings.HotKeyKey); }
            catch (Exception error) { hotkeyError = Ui.Error(error); }
            try { SetAutomatic(runtime.Settings.AutomaticSelection); }
            catch (Exception error) { hotkeyError = Ui.Error(error); }
            CreateTray();
            ShowSettings();
            if (hotkeyError is not null) settings.SetStatus(hotkeyError);
        }
        catch (Exception error)
        {
            if (smokeTest) SmokeError = Ui.Error(error);
            if (!smokeTest) MessageBox.Show("阅读助手未能启动：" + Ui.Error(error) + "\n请检查是否已有程序占用本地阅读端口，或查看安装指南。", "Ask for GPT", MessageBoxButton.OK, MessageBoxImage.Error);
            await QuitAsync(1);
        }
    }

    public void ShowSettings()
    {
        if (settings is null || exiting) return;
        if (!settings.IsVisible) settings.Show();
        if (settings.WindowState == WindowState.Minimized) settings.WindowState = WindowState.Normal;
        settings.Activate();
    }

    private static void SaveRendererPreview(Window window, string path)
    {
        var bitmap = new RenderTargetBitmap((int)Math.Ceiling(window.ActualWidth), (int)Math.Ceiling(window.ActualHeight), 96, 96, PixelFormats.Pbgra32);
        bitmap.Render(window);
        var encoder = new PngBitmapEncoder();
        encoder.Frames.Add(BitmapFrame.Create(bitmap));
        using var output = File.Create(path);
        encoder.Save(output);
    }

    private static WindowLayoutSnapshot CaptureLayout(Window window)
    {
        var scroll = (System.Windows.Controls.ScrollViewer)window.Content;
        return new(window.ActualWidth, window.ActualHeight, scroll.ViewportWidth, scroll.ViewportHeight, scroll.ExtentHeight, scroll.ScrollableHeight);
    }

    private async Task CaptureAsync(bool isAutomatic)
    {
        if (exiting || reader is null) return;
        if (captureRequest is { } previous) previous.Cancel();
        var current = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
        captureRequest = current;
        try
        {
            IntPtr originalWindow = NativeMethods.GetForegroundWindow();
            if (isAutomatic)
            {
                await Task.Delay(240, current.Token);
                if (NativeMethods.GetForegroundWindow() != originalWindow) return;
            }
            SelectionResult selected = await capture.CaptureAsync(isAutomatic, current.Token);
            current.Token.ThrowIfCancellationRequested();
            if (isAutomatic)
            {
                if (selected.Text is null) return;
                if (lastAutomaticWindow == originalWindow && selected.Text == lastAutomaticText && DateTime.UtcNow - lastAutomaticTime < TimeSpan.FromSeconds(15)) return;
                lastAutomaticText = selected.Text; lastAutomaticWindow = originalWindow; lastAutomaticTime = DateTime.UtcNow;
            }
            await reader.PresentAsync(selected, isAutomatic);
        }
        catch (OperationCanceledException) { }
        catch (Exception error) { if (!isAutomatic && settings is not null) { settings.SetStatus(Ui.Error(error)); ShowSettings(); } }
        finally { if (captureRequest == current) captureRequest = null; current.Dispose(); }
    }

    private async Task SaveAsync(AppSettings next)
    {
        if (runtime is null || hotkey is null) throw new InvalidOperationException("程序尚未就绪。");
        AppSettings previous = runtime.Settings;
        hotkey.Set(next.HotKeyModifiers, next.HotKeyKey);
        try
        {
            // Prove observer startup before persisting the opt-in setting.
            SetAutomatic(next.AutomaticSelection);
            await runtime.UpdateSettingsAsync(next, lifetime.Token);
            reader?.ResetLanguages();
        }
        catch
        {
            hotkey.Set(previous.HotKeyModifiers, previous.HotKeyKey);
            SetAutomatic(previous.AutomaticSelection);
            throw;
        }
    }

    private void SetAutomatic(bool enabled)
    {
        if (!enabled) { automatic?.Dispose(); automatic = null; return; }
        if (automatic is not null) return;
        automatic = new AutomaticSelectionObserver(Dispatcher);
        automatic.SelectionGesture += () => _ = CaptureAsync(true);
    }

    private void CreateTray()
    {
        var menu = new Forms.ContextMenuStrip();
        void Add(string text, Action action) => menu.Items.Add(text, null, (_, _) => Dispatcher.BeginInvoke(action));
        Add("打开设置", ShowSettings);
        // Opening the menu moves focus; manual text entry is reliable from here.
        Add("输入文本查词 / 翻译", () => { if (reader is not null) _ = reader.PresentAsync(new(null, "请粘贴或输入文本。"), false); });
        Add("启动 PDF 服务", () => _ = TrayTaskAsync(StartPdfAsync));
        Add("导出阅读集成", () => _ = TrayTaskAsync(ExportAsync));
        menu.Items.Add(new Forms.ToolStripSeparator());
        Add("退出", () => _ = QuitAsync());
        tray = new Forms.NotifyIcon { Text = "Ask for GPT 阅读助手", Icon = System.Drawing.SystemIcons.Information, ContextMenuStrip = menu, Visible = true };
        tray.DoubleClick += (_, _) => Dispatcher.BeginInvoke(ShowSettings);
    }

    private async Task TrayTaskAsync(Func<Task> task)
    {
        try { await task(); }
        catch (OperationCanceledException) { }
        catch (Exception error) { settings?.SetStatus(Ui.Error(error)); ShowSettings(); }
    }

    private async Task PrepareAsync(string name)
    {
        settings?.SetStatus(name == "prepare-pdf.ps1" ? "正在准备 PDF 组件，首次需下载运行环境；请等待。" : "正在准备 Codex CLI，请等待。");
        await preparation.RunAsync(name, lifetime.Token);
        lifetime.Token.ThrowIfCancellationRequested();
        if (runtime is not null && name == "prepare-codex.ps1" && runtime.Settings.Provider == "codex" && string.IsNullOrWhiteSpace(runtime.Settings.CliPath) && File.Exists(AppPaths.DefaultCodexPath))
        {
            await runtime.UpdateSettingsAsync(runtime.Settings with { CliPath = AppPaths.DefaultCodexPath }, lifetime.Token);
            settings?.RefreshCliPath();
        }
        settings?.RefreshStatus("组件准备完成。 ");
        if (name == "prepare-codex.ps1") LoginHelp();
    }

    private async Task StartPdfAsync()
    {
        if (runtime is null) return;
        settings?.SetStatus("正在启动 PDF 阅读服务…");
        await runtime.StartPdfAsync(lifetime.Token);
        settings?.RefreshStatus("PDF 服务已启动。 ");
    }

    private async Task ExportAsync()
    {
        if (runtime is null) return;
        var dialog = new OpenFolderDialog { Title = "选择阅读集成导出目录" };
        if (dialog.ShowDialog(settings) != true) return;
        string destination = await runtime.ExportIntegrationsAsync(dialog.FolderName, lifetime.Token);
        settings?.SetStatus("阅读集成已导出到：" + destination + "。请按安装指南加载扩展并完成配对。");
        ShowSettings();
    }

    private static void LoginHelp()
    {
        string path = AppPaths.DefaultCodexPath;
        MessageBox.Show("Codex CLI：准备组件后，在 PowerShell 运行下方命令，并按其提示登录（Ctrl+C 可复制本提示）：\n\n& '" + path.Replace("'", "''") + "' -c cli_auth_credentials_store=file login\n\n设置中可选择上述 codex.exe 路径。CLI 登录由你在官方界面完成。\n\nClaude Code：先按官方说明安装并自行登录，在设置中选择实际 claude.exe 路径。\n\nAPI：使用已有服务的端点、模型及密钥文件。保存设置不会发起模型请求；实际翻译或提问由你触发。", "CLI 与 API 配置", MessageBoxButton.OK, MessageBoxImage.Information);
    }

    private static void OpenGuide()
    {
        string path = Path.Combine(AppContext.BaseDirectory, "安装与配置说明.txt");
        if (File.Exists(path)) Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
        else MessageBox.Show("安装指南未随当前目录提供。请使用完整安装包中的 docs/INSTALL.Windows.zh-CN.md。\n\nChrome：导出阅读集成，在扩展管理页加载 AskGPT-Chrome 目录。\nZotero：按导出目录内说明安装扩展并完成本地配对。\nPDF：准备组件后启动 PDF 服务，再在阅读集成中打开对照。", "安装指南", MessageBoxButton.OK, MessageBoxImage.Information);
    }

    private async Task QuitAsync(int exitCode = 0)
    {
        if (exiting) return;
        exiting = true;
        lifetime.Cancel(); captureRequest?.Cancel();
        automatic?.Dispose(); hotkey?.Dispose();
        if (tray is not null) { tray.Visible = false; tray.ContextMenuStrip?.Dispose(); tray.Dispose(); }
        reader?.CloseForExit(); settings?.CloseForExit();
        try
        {
            await preparation.DisposeAsync();
            if (runtime is not null) await runtime.DisposeAsync();
            SmokeRuntimeStopped = true;
        }
        catch (Exception error) { exitCode = 1; if (smokeTest) SmokeError = Ui.Error(error); }
        lifetime.Dispose();
        Shutdown(exitCode);
    }
}
