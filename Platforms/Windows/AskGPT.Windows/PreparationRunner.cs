using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using AskGPT.Windows.Core;

namespace AskGPT.Windows;

internal sealed class PreparationRunner : IAsyncDisposable
{
    private readonly CancellationTokenSource shutdown = new();
    private OwnedProcess? owned;
    private Task? active;

    public Task RunAsync(string scriptName, CancellationToken cancellationToken)
    {
        if (scriptName is not ("prepare-pdf.ps1" or "prepare-codex.ps1")) throw new ArgumentException("未知组件准备入口。");
        if (shutdown.IsCancellationRequested) throw new ObjectDisposedException(nameof(PreparationRunner));
        if (active is { IsCompleted: false }) throw new InvalidOperationException("已有组件准备任务，请等待完成。");
        active = RunCoreAsync(scriptName, cancellationToken);
        return active;
    }

    private async Task RunCoreAsync(string scriptName, CancellationToken cancellationToken)
    {
        string script = Path.Combine(AppContext.BaseDirectory, "scripts", "windows", scriptName);
        if (!File.Exists(script)) throw new FileNotFoundException("安装包缺少准备脚本，请重新解压完整便携包或重新安装。", script);
        string powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, shutdown.Token);
        timeout.CancelAfter(TimeSpan.FromMinutes(25));
        await using var process = OwnedProcess.Start(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script]);
        owned = process;
        using var cancel = timeout.Token.Register(process.Kill);
        process.StandardInput.Close();
        Task<string> stdout = ReadTailAsync(process.StandardOutput, timeout.Token);
        Task<string> stderr = ReadTailAsync(process.StandardError, timeout.Token);
        try
        {
            await process.Process.WaitForExitAsync(timeout.Token);
            await Task.WhenAll(stdout, stderr);
            if (process.Process.ExitCode != 0)
                throw new InvalidOperationException("组件准备失败。请检查网络和当前用户目录权限后重试。" + (string.IsNullOrWhiteSpace(stderr.Result) ? "" : "\n" + stderr.Result));
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested && !shutdown.IsCancellationRequested)
        {
            throw new TimeoutException("组件准备超时。可稍后重试，已下载的组件按脚本规则复用。");
        }
        finally
        {
            process.Kill();
            try { await Task.WhenAll(stdout, stderr); }
            catch (OperationCanceledException) { }
            catch (IOException) { }
            owned = null;
        }
    }

    private static async Task<string> ReadTailAsync(StreamReader stream, CancellationToken cancellationToken)
    {
        var buffer = new char[2048];
        string tail = "";
        while (true)
        {
            int size = await stream.ReadAsync(buffer.AsMemory(), cancellationToken);
            if (size == 0) return tail.Trim();
            tail += new string(buffer, 0, size);
            if (tail.Length > 600) tail = tail[^600..];
        }
    }

    public async ValueTask DisposeAsync()
    {
        shutdown.Cancel();
        owned?.Kill();
        if (active is not null) { try { await active; } catch { } }
        shutdown.Dispose();
    }
}
