using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Automation;

namespace AskGPT.Windows;

internal sealed record SelectionResult(string? Text, string Message);

internal sealed class SelectionCapture
{
    private readonly SemaphoreSlim automationSlot = new(1, 1);

    public async Task<SelectionResult> CaptureAsync(bool automatic, CancellationToken cancellationToken)
    {
        IntPtr window = NativeMethods.GetForegroundWindow();
        NativeMethods.GetWindowThreadProcessId(window, out uint processId);
        bool SameForeground() => window != IntPtr.Zero && NativeMethods.IsWindow(window) && NativeMethods.GetForegroundWindow() == window;
        if (!SameForeground() || processId == (uint)Environment.ProcessId)
            return new(null, "请在其他应用中选中文字，再按快捷键。也可在这里粘贴输入。");
        if (!NativeMethods.HasReadableIntegrity(processId))
            return new(null, "无法安全读取此应用选区。请复制后粘贴；无需以管理员身份运行。");

        AutomationSelection? selection = await InspectAsync(processId, automatic, true, cancellationToken);
        if (selection is null) return new(null, "应用未及时返回选区。请复制后粘贴输入。");
        if (!SelectionPolicy.CanRead(selection.Inspected, false, SameForeground(), true))
            return new(null, "选区不可读取或位于受保护控件。请切换到普通文本后重试。");
        if (selection.Text is not null)
        {
            string? text = SelectionPolicy.Normalize(selection.Text, automatic);
            return text is null ? new(null, "选区为空或过长，请缩小范围。") : new(text, "已读取选区");
        }
        if (automatic) return new(null, "此应用未提供可读取的选区。");

        // Only an explicit hotkey can copy. Wait for Alt/Ctrl/Shift to be released so
        // the synthesized Ctrl+C cannot become a different shortcut in the source app.
        for (int attempt = 0; attempt < 35 && NativeMethods.IsModifierPressed(); attempt++)
            await Task.Delay(20, cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        if (!SameForeground() || NativeMethods.IsModifierPressed())
            return new(null, "前台窗口已变化或快捷键仍按下。请松开按键后重试。");
        if (!TrySnapshotClipboard(out DataObject? previous, out uint originalSequence))
            return new(null, "剪贴板含图片、文件或暂被占用。为保留内容，请直接粘贴文本。");
        // A password control can gain focus inside the same foreground window
        // while the hotkey modifiers are being released. Reinspect that exact
        // focused runtime ID and its ancestors before any synthesized copy.
        AutomationSelection? current = await InspectAsync(processId, false, false, cancellationToken);
        if (!SelectionPolicy.CanCopyFallback(current?.Inspected == true, SameForeground(), NativeMethods.HasReadableIntegrity(processId), selection.RuntimeId, current?.RuntimeId))
            return new(null, "输入焦点已变化或位于受保护控件，已取消复制。请手动粘贴文本。");
        if (!SameForeground() || NativeMethods.GetClipboardSequenceNumber() != originalSequence || NativeMethods.IsModifierPressed())
            return new(null, "窗口或剪贴板已变化，已取消复制。请重试。");

        uint copiedSequence = 0;
        string? captured = null;
        string message = "未获取到选区。请复制后粘贴输入。";
        try
        {
            if (!NativeMethods.SendCopy()) return new(null, "此应用未接受复制请求。请手动复制后粘贴。");
            for (int attempt = 0; attempt < 24; attempt++)
            {
                await Task.Delay(20, cancellationToken);
                uint sequence = NativeMethods.GetClipboardSequenceNumber();
                if (sequence == originalSequence) continue;
                if (!ClipboardOwnedBy(processId)) break;
                copiedSequence = sequence;
                if (!SameForeground()) { message = "前台窗口已变化，已取消读取。"; break; }
                try
                {
                    string value = Clipboard.ContainsText(TextDataFormat.UnicodeText) ? Clipboard.GetText(TextDataFormat.UnicodeText) : "";
                    if (NativeMethods.GetClipboardSequenceNumber() != sequence) { copiedSequence = 0; message = "剪贴板已更新，已取消读取。"; break; }
                    captured = SelectionPolicy.Normalize(value, false);
                    message = captured is null ? "选区为空或超过 12,000 字符，请缩小范围。" : "已读取选区";
                }
                catch (ExternalException) { message = "剪贴板暂被占用。请直接粘贴输入。"; }
                break;
            }
        }
        finally
        {
            // Never overwrite a newer copy, even when the foreground has changed.
            if (SelectionPolicy.CanRestoreClipboard(copiedSequence, NativeMethods.GetClipboardSequenceNumber(), ClipboardOwnedBy(processId)))
            {
                try
                {
                    if (previous is null) Clipboard.Clear();
                    else Clipboard.SetDataObject(previous, true);
                }
                catch (ExternalException) { message += "；剪贴板暂被占用，未能恢复原内容。"; }
            }
        }
        return new(captured, message);
    }

    private async Task<AutomationSelection?> InspectAsync(uint processId, bool automatic, bool readText, CancellationToken cancellationToken)
    {
        if (!automationSlot.Wait(0)) return null;
        var completion = new TaskCompletionSource<AutomationSelection>(TaskCreationOptions.RunContinuationsAsynchronously);
        var thread = new Thread(() =>
        {
            try { completion.TrySetResult(ReadAutomation(processId, automatic, readText)); }
            catch { completion.TrySetResult(new(false, null, null)); }
            finally { automationSlot.Release(); }
        }) { IsBackground = true, Name = "AskGPT selection UI Automation" };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        try { return await completion.Task.WaitAsync(TimeSpan.FromMilliseconds(850), cancellationToken); }
        catch (TimeoutException) { return null; }
    }

    private static AutomationSelection ReadAutomation(uint processId, bool automatic, bool readText)
    {
        AutomationElement? focused;
        try { focused = AutomationElement.FocusedElement; }
        catch { return new(false, null, null); }
        if (focused is null) return new(false, null, null);
        try
        {
            if (focused.Current.ProcessId != processId) return new(false, null, null);
            AutomationElement? element = focused;
            bool reachedWindow = false;
            for (int depth = 0; element is not null && depth < 24; depth++)
            {
                if (element.Current.IsPassword) return new(false, null, null);
                if (element.Current.ControlType == ControlType.Window) { reachedWindow = true; break; }
                element = TreeWalker.ControlViewWalker.GetParent(element);
            }
            if (!reachedWindow) return new(false, null, null);
            int[] runtimeId = focused.GetRuntimeId();
            if (!readText || !focused.TryGetCurrentPattern(TextPattern.Pattern, out object pattern)) return new(true, null, runtimeId);
            var ranges = ((TextPattern)pattern).GetSelection();
            if (ranges.Length == 0) return new(true, null, runtimeId);
            int limit = automatic ? SelectionPolicy.AutomaticLimit : SelectionPolicy.ExplicitLimit;
            var parts = new List<string>();
            int total = 0;
            foreach (var range in ranges)
            {
                string value = range.GetText(limit + 1);
                total += value.Length;
                if (total > limit || parts.Count >= 4) return new(true, new string(' ', limit + 1), runtimeId);
                if (!string.IsNullOrWhiteSpace(value)) parts.Add(value);
            }
            return new(true, parts.Count == 0 ? null : string.Join("\n", parts), runtimeId);
        }
        catch (ElementNotAvailableException) { return new(false, null, null); }
        catch (InvalidOperationException) { return new(false, null, null); }
        catch (COMException) { return new(false, null, null); }
    }

    private static bool ClipboardOwnedBy(uint processId)
    {
        IntPtr owner = NativeMethods.GetClipboardOwner();
        return owner != IntPtr.Zero && NativeMethods.GetWindowThreadProcessId(owner, out uint ownerProcess) != 0 && ownerProcess == processId;
    }

    private static bool TrySnapshotClipboard(out DataObject? snapshot, out uint sequence)
    {
        snapshot = null;
        sequence = NativeMethods.GetClipboardSequenceNumber();
        if (sequence == 0) return false;
        try
        {
            IDataObject? data = Clipboard.GetDataObject();
            if (data is null) return NativeMethods.GetClipboardSequenceNumber() == sequence;
            var copy = new DataObject();
            string[] formats = data.GetFormats(false);
            foreach (string format in formats)
            {
                // Unknown custom/OLE formats may be delayed, huge or deserialize
                // application objects. Refuse fallback instead of losing them.
                if (format is not ("UnicodeText" or "Text" or "System.String" or "OEMText" or "HTML Format" or "Rich Text Format" or "Csv" or "Locale")) return false;
                object? value = data.GetData(format, false);
                if (value is string text && text.Length <= 2_000_000) copy.SetData(format, text, false);
                else if (value is byte[] bytes && bytes.Length <= 8_000_000) copy.SetData(format, bytes.Clone(), false);
                else if (value is System.IO.MemoryStream stream && stream.Length <= 8_000_000) copy.SetData(format, new System.IO.MemoryStream(stream.ToArray(), false), false);
                else return false;
            }
            snapshot = formats.Length == 0 ? null : copy;
            return NativeMethods.GetClipboardSequenceNumber() == sequence;
        }
        catch (ExternalException) { return false; }
        catch (InvalidOperationException) { return false; }
    }

    private sealed record AutomationSelection(bool Inspected, string? Text, int[]? RuntimeId);
}
