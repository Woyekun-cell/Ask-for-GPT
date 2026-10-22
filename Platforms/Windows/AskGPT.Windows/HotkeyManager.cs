using System;
using System.Windows.Interop;

namespace AskGPT.Windows;

internal sealed class HotkeyManager : IDisposable
{
    private const int Id = 0x4750;
    private readonly HwndSource source;
    private uint modifiers;
    private uint key;
    private bool registered;
    public event Action? Pressed;

    public HotkeyManager()
    {
        source = new HwndSource(new HwndSourceParameters("AskGPT reading hotkey") { ParentWindow = new IntPtr(-3), Width = 0, Height = 0, WindowStyle = 0 });
        source.AddHook(Message);
    }

    public void Set(uint nextModifiers, uint nextKey)
    {
        if ((nextModifiers & ~15u) != 0 || (nextModifiers & 15u) == 0 || nextKey is < 0x30 or > 0x5A || nextKey is > 0x39 and < 0x41)
            throw new InvalidOperationException("快捷键需包含 Alt、Ctrl、Shift 或 Win，以及一个字母或数字。");
        if (registered && nextModifiers == modifiers && nextKey == key) return;
        if (registered) NativeMethods.UnregisterHotKey(source.Handle, Id);
        bool wasRegistered = registered;
        registered = NativeMethods.RegisterHotKey(source.Handle, Id, nextModifiers | NativeMethods.NoRepeat, nextKey);
        if (!registered)
        {
            if (wasRegistered) registered = NativeMethods.RegisterHotKey(source.Handle, Id, modifiers | NativeMethods.NoRepeat, key);
            throw new InvalidOperationException("快捷键已被其他应用占用。请更换组合后保存。");
        }
        modifiers = nextModifiers;
        key = nextKey;
    }

    private IntPtr Message(IntPtr window, int message, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (message == NativeMethods.WmHotkey && wParam.ToInt32() == Id) { handled = true; Pressed?.Invoke(); }
        return IntPtr.Zero;
    }

    public void Dispose()
    {
        if (registered) NativeMethods.UnregisterHotKey(source.Handle, Id);
        source.RemoveHook(Message);
        source.Dispose();
    }
}
