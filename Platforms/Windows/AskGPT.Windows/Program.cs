using System;
using System.IO;
using System.Linq;
using System.Security.Principal;
using System.Text.Json;
using System.Threading;

namespace AskGPT.Windows;

internal static class Program
{
    [STAThread]
    public static int Main(string[] args)
    {
        if (args.Contains("--self-test", StringComparer.Ordinal)) return PolicyChecks.Run(Console.Out);
        bool smoke = args.Contains("--smoke-test", StringComparer.Ordinal);
        if (!smoke) return RunApplication(false, out _);

        string? report = null;
        int reportIndex = Array.IndexOf(args, "--smoke-report");
        if (reportIndex >= 0)
        {
            if (reportIndex + 1 >= args.Length || !Path.IsPathFullyQualified(args[reportIndex + 1])) return 64;
            report = args[reportIndex + 1];
        }
        string directory = Path.Combine(Path.GetTempPath(), "AskGPT-smoke-" + Guid.NewGuid().ToString("N"));
        string? previous = Environment.GetEnvironmentVariable("ASKGPT_DATA_DIRECTORY");
        Environment.SetEnvironmentVariable("ASKGPT_DATA_DIRECTORY", directory);
        DesktopApp? app = null;
        int exitCode = 1;
        string error = "";
        bool cleaned = false;
        try
        {
            if (report is not null) Directory.CreateDirectory(Path.GetDirectoryName(report)!);
            exitCode = RunApplication(true, out app, report is null ? null : Path.ChangeExtension(report, null));
        }
        catch (Exception exception) { error = Ui.Error(exception); }
        finally
        {
            Environment.SetEnvironmentVariable("ASKGPT_DATA_DIRECTORY", previous);
            try { if (Directory.Exists(directory)) Directory.Delete(directory, true); cleaned = !Directory.Exists(directory); }
            catch (Exception exception) { error = Ui.Error(exception); exitCode = 1; }
        }
        bool passed = exitCode == 0 && app is { SmokeWindowsCreated: true, SmokeTrayInitialized: true, SmokeRuntimeStopped: true, SmokeLayoutVerified: true, SmokeGlobalInputsDisabled: true, SmokeError.Length: 0 } && cleaned && string.IsNullOrEmpty(error);
        if (!passed) exitCode = 1;
        if (report is not null)
        {
            try
            {
                File.WriteAllText(report, JsonSerializer.Serialize(new
                {
                    passed, exitCode, windowsCreated = app?.SmokeWindowsCreated ?? false,
                    trayInitialized = app?.SmokeTrayInitialized ?? false, runtimeStopped = app?.SmokeRuntimeStopped ?? false,
                    layoutVerified = app?.SmokeLayoutVerified ?? false, globalInputsDisabled = app?.SmokeGlobalInputsDisabled ?? false,
                    screenshotsCreated = app?.SmokeScreenshotsCreated ?? false, isolatedDataCleaned = cleaned, modelCallsExercised = false,
                    settingsLayout = app?.SmokeSettingsLayout, readerLayout = app?.SmokeReaderLayout,
                    error = string.IsNullOrEmpty(error) ? app?.SmokeError ?? "" : error
                }, new JsonSerializerOptions { WriteIndented = true }));
            }
            catch { return 1; }
        }
        return exitCode;
    }

    private static int RunApplication(bool smoke, out DesktopApp? app, string? smokeArtifactPrefix = null)
    {
        app = null;
        string identity = WindowsIdentity.GetCurrent().User?.Value ?? Environment.UserName;
        if (smoke) identity += ".Smoke." + Guid.NewGuid().ToString("N");
        using var mutex = new Mutex(true, @"Local\AskGPTReader." + identity, out bool first);
        if (!first)
        {
            try { using var existing = EventWaitHandle.OpenExisting(@"Local\AskGPTReader.Show." + identity); existing.Set(); }
            catch (WaitHandleCannotBeOpenedException) { }
            return smoke ? 2 : 0;
        }
        try
        {
            using var activation = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\AskGPTReader.Show." + identity);
            var desktop = new DesktopApp(smoke, smokeArtifactPrefix);
            app = desktop;
            RegisteredWaitHandle wait = ThreadPool.RegisterWaitForSingleObject(activation, (_, _) =>
            {
                if (!desktop.Dispatcher.HasShutdownStarted) desktop.Dispatcher.BeginInvoke(desktop.ShowSettings);
            }, null, Timeout.Infinite, false);
            try { return desktop.Run(); }
            finally { wait.Unregister(null); }
        }
        finally { mutex.ReleaseMutex(); }
    }
}
