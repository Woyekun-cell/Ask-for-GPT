using System;
using System.IO;

namespace AskGPT.Windows;

internal static class PolicyChecks
{
    public static int Run(TextWriter output)
    {
        int count = 0;
        void Check(bool condition, string name)
        {
            if (!condition) throw new InvalidOperationException(name);
            count++;
        }
        try
        {
            Check(SelectionPolicy.Normalize("  word\r\n", false) == "word", "trim selected text");
            Check(SelectionPolicy.Normalize("", false) is null, "empty selection rejected");
            Check(SelectionPolicy.Normalize(new string('a', SelectionPolicy.ExplicitLimit), false) is not null, "explicit bound accepted");
            Check(SelectionPolicy.Normalize(new string('a', SelectionPolicy.ExplicitLimit + 1), false) is null, "oversize selection rejected");
            Check(SelectionPolicy.Normalize(new string('a', SelectionPolicy.AutomaticLimit + 1), true) is null, "automatic short-text bound");
            Check(SelectionPolicy.Normalize("safe\0hidden", false) is null, "NUL rejected");
            Check(SelectionPolicy.Normalize("safe\u0001hidden", false) is null, "control character rejected");
            Check(SelectionPolicy.Normalize("第一行\nsecond\tline", false) is not null, "Chinese and whitespace accepted");
            Check(!SelectionPolicy.CanRead(false, false, true, true), "password exclusion");
            Check(!SelectionPolicy.CanRead(true, true, true, true), "password ancestor exclusion");
            Check(!SelectionPolicy.CanRead(true, false, false, true), "foreground change exclusion");
            Check(!SelectionPolicy.CanRead(true, false, true, false), "unknown permissions exclusion");
            Check(SelectionPolicy.CanRead(true, false, true, true), "safe focused control accepted");
            Check(SelectionPolicy.CanCopyFallback(true, true, true, [1, 2, 3], [1, 2, 3]), "same focused control permits explicit copy");
            Check(!SelectionPolicy.CanCopyFallback(true, true, true, [1, 2, 3], [1, 2, 4]), "same-window focus change rejects copy");
            Check(!SelectionPolicy.CanCopyFallback(false, true, true, [1, 2, 3], [1, 2, 3]), "protected reinspection rejects copy");
            Check(!SelectionPolicy.CanCopyFallback(true, false, true, [1], [1]), "new foreground rejects copy");
            Check(!SelectionPolicy.CanCopyFallback(true, true, false, [1], [1]), "unreadable process rejects copy");
            Check(!SelectionPolicy.CanCopyFallback(true, true, true, [], []), "missing control identity rejects copy");
            Check(SelectionPolicy.CanRestoreClipboard(42, 42, true), "unchanged captured clipboard restored");
            Check(!SelectionPolicy.CanRestoreClipboard(42, 43, true), "newer clipboard preserved");
            Check(!SelectionPolicy.CanRestoreClipboard(42, 42, false), "foreign clipboard owner preserved");
            Check(!SelectionPolicy.CanRestoreClipboard(0, 0, true), "unknown clipboard sequence rejected");
            Check(SelectionPolicy.IsDictionaryWord("word") && SelectionPolicy.IsDictionaryWord("mother-in-law"), "dictionary words accepted");
            Check(!SelectionPolicy.IsDictionaryWord("two words") && !SelectionPolicy.IsDictionaryWord("中文段落"), "paragraph bypasses dictionary");
            output.WriteLine($"Selection policy: {count} checks passed.");
            return 0;
        }
        catch (Exception error)
        {
            output.WriteLine($"Selection policy failed: {error.Message}");
            return 1;
        }
    }
}
