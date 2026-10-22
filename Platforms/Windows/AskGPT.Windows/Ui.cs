using System;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace AskGPT.Windows;

internal static class Ui
{
    public static readonly Brush Muted = new SolidColorBrush(Color.FromRgb(82, 91, 107));

    public static void SizeToWorkArea(Window window, double width, double height, double minimumWidth, double minimumHeight)
    {
        Rect area = SystemParameters.WorkArea;
        window.Width = Math.Min(width, Math.Max(300, area.Width - 32));
        window.Height = Math.Min(height, Math.Max(300, area.Height - 32));
        window.MinWidth = Math.Min(minimumWidth, window.Width);
        window.MinHeight = Math.Min(minimumHeight, window.Height);
    }

    public static TextBlock Text(string text, double size = 14, bool muted = false) => new()
    {
        Text = text, FontSize = size, TextWrapping = TextWrapping.Wrap,
        Foreground = muted ? Muted : SystemColors.ControlTextBrush, Margin = new Thickness(0, 0, 0, 8)
    };

    public static Button Button(string text, Action action)
    {
        var button = new Button { Content = text, Padding = new Thickness(13, 7, 13, 7), Margin = new Thickness(0, 0, 8, 8), MinHeight = 34 };
        button.Click += (_, _) => action();
        return button;
    }

    public static Button AsyncButton(string text, Func<Task> action, Action<Exception> failed)
    {
        var button = new Button { Content = text, Padding = new Thickness(13, 7, 13, 7), Margin = new Thickness(0, 0, 8, 8), MinHeight = 34 };
        button.Click += async (_, _) =>
        {
            button.IsEnabled = false;
            try { await action(); }
            catch (OperationCanceledException) { }
            catch (Exception error) { failed(error); }
            finally { button.IsEnabled = true; }
        };
        return button;
    }

    public static string Error(Exception error)
    {
        string text = error.Message.Replace('\0', ' ').Trim();
        return text.Length > 600 ? text[..600] + "…" : text;
    }
}
