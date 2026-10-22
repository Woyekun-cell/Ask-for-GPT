using System;
using System.Runtime.InteropServices;
using System.Windows.Threading;

namespace AskGPT.Windows;

internal sealed class AutomaticSelectionObserver : IDisposable
{
    private readonly Dispatcher dispatcher;
    private readonly NativeMethods.HookProc callback;
    private IntPtr hook;
    private NativeMethods.Point down;
    private NativeMethods.Point previousUp;
    private uint previousUpTime;
    private bool pressed;
    public event Action? SelectionGesture;

    public AutomaticSelectionObserver(Dispatcher dispatcher)
    {
        this.dispatcher = dispatcher;
        callback = OnMouse;
        hook = NativeMethods.SetWindowsHookEx(NativeMethods.WhMouseLowLevel, callback, NativeMethods.GetModuleHandle(null), 0);
        if (hook == IntPtr.Zero) throw new InvalidOperationException("自动划词观察未能启动。可继续使用快捷键。");
    }

    private IntPtr OnMouse(int code, IntPtr message, IntPtr data)
    {
        if (code >= 0)
        {
            var mouse = Marshal.PtrToStructure<NativeMethods.MouseHook>(data);
            if ((mouse.Flags & 1) == 0) // Ignore injected mouse events.
            {
                if (message.ToInt32() == NativeMethods.WmLButtonDown) { down = mouse.Point; pressed = true; }
                else if (message.ToInt32() == NativeMethods.WmLButtonUp && pressed)
                {
                    pressed = false;
                    bool drag = Math.Abs(down.X - mouse.Point.X) > 4 || Math.Abs(down.Y - mouse.Point.Y) > 4;
                    bool doubleClick = previousUpTime != 0 && unchecked(mouse.Time - previousUpTime) <= NativeMethods.GetDoubleClickTime()
                        && Math.Abs(previousUp.X - mouse.Point.X) <= 4 && Math.Abs(previousUp.Y - mouse.Point.Y) <= 4;
                    previousUp = mouse.Point;
                    previousUpTime = mouse.Time;
                    if ((drag || doubleClick) && !NativeMethods.IsModifierPressed())
                        dispatcher.BeginInvoke(() => SelectionGesture?.Invoke(), DispatcherPriority.Background);
                }
            }
        }
        return NativeMethods.CallNextHookEx(hook, code, message, data);
    }

    public void Dispose()
    {
        if (hook != IntPtr.Zero) { NativeMethods.UnhookWindowsHookEx(hook); hook = IntPtr.Zero; }
    }
}
