using System;

namespace AskGPT.Windows;

internal static class SelectionPolicy
{
    public const int ExplicitLimit = 12_000;
    public const int AutomaticLimit = 1_200;

    public static string? Normalize(string? text, bool automatic)
    {
        if (string.IsNullOrWhiteSpace(text) || text.Length > (automatic ? AutomaticLimit : ExplicitLimit)) return null;
        foreach (char value in text)
            if (char.IsControl(value) && value is not '\r' and not '\n' and not '\t') return null;
        return text.Trim();
    }

    public static bool CanRead(bool controlInspected, bool password, bool sameForeground, bool permissionSafe) =>
        controlInspected && !password && sameForeground && permissionSafe;

    public static bool CanCopyFallback(bool controlInspected, bool sameForeground, bool permissionSafe, ReadOnlySpan<int> initialRuntimeId, ReadOnlySpan<int> currentRuntimeId) =>
        CanRead(controlInspected, false, sameForeground, permissionSafe) && !initialRuntimeId.IsEmpty && initialRuntimeId.SequenceEqual(currentRuntimeId);

    public static bool CanRestoreClipboard(uint capturedSequence, uint currentSequence, bool sameOwner) =>
        capturedSequence != 0 && capturedSequence == currentSequence && sameOwner;

    public static bool IsDictionaryWord(string text)
    {
        if (text.Length is < 1 or > 80) return false;
        foreach (char value in text)
            if (!(value is >= 'a' and <= 'z' or >= 'A' and <= 'Z' or '\'' or '-')) return false;
        return true;
    }
}
