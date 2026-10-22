using System;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using AskGPT.Windows.Core;

namespace AskGPT.Windows;

internal sealed class ReaderWindow : Window
{
    private readonly ReaderRuntime runtime;
    private readonly TextBox input = new() { AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, MinHeight = 70, MaxHeight = 200, MaxLength = SelectionPolicy.ExplicitLimit, Padding = new Thickness(10), Margin = new Thickness(0, 0, 0, 10) };
    private readonly TextBox output = new() { IsReadOnly = true, AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Padding = new Thickness(10), MinHeight = 100, MaxHeight = 320, Margin = new Thickness(0, 0, 0, 10) };
    private readonly TextBlock status = Ui.Text("选词先查离线词典；段落使用已配置的翻译后端。", 12, true);
    private readonly ComboBox source = new() { IsEditable = true, MinWidth = 100, Margin = new Thickness(0, 0, 10, 8) };
    private readonly ComboBox target = new() { IsEditable = true, MinWidth = 110, Margin = new Thickness(0, 0, 10, 8) };
    private readonly TextBox question = new() { AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, MinHeight = 55, MaxHeight = 95, MaxLength = 4_000, Padding = new Thickness(8), Margin = new Thickness(0, 0, 0, 8) };
    private CancellationTokenSource? request;
    private bool allowClose;

    public ReaderWindow(ReaderRuntime runtime, Action openSettings)
    {
        this.runtime = runtime;
        Title = "Ask for GPT · 划词阅读";
        Ui.SizeToWorkArea(this, 640, 740, 430, 500);
        ShowInTaskbar = false; Topmost = true; WindowStartupLocation = WindowStartupLocation.CenterScreen;
        FontFamily = new System.Windows.Media.FontFamily("Microsoft YaHei UI");
        FontSize = 14;
        var panel = new Grid { Margin = new Thickness(20), MinHeight = 550 };
        panel.RowDefinitions.Add(new() { Height = GridLength.Auto });
        panel.RowDefinitions.Add(new() { Height = new GridLength(1, GridUnitType.Star), MinHeight = 70 });
        panel.RowDefinitions.Add(new() { Height = GridLength.Auto });
        panel.RowDefinitions.Add(new() { Height = new GridLength(2, GridUnitType.Star), MinHeight = 100 });
        panel.RowDefinitions.Add(new() { Height = GridLength.Auto });
        void Add(UIElement element, int row) { Grid.SetRow(element, row); panel.Children.Add(element); }
        var heading = new StackPanel();
        heading.Children.Add(Ui.Text("划词阅读", 22));
        heading.Children.Add(Ui.Text("原文（也可直接粘贴或编辑）", 12, true));
        Add(heading, 0); Add(input, 1);
        var top = new StackPanel();
        foreach (string language in new[] { "en", "zh-Hans" }) source.Items.Add(language);
        foreach (string language in new[] { "zh-Hans", "en" }) target.Items.Add(language);
        ResetLanguages();
        var languages = new WrapPanel();
        languages.Children.Add(Ui.Text("从", 13)); languages.Children.Add(source);
        languages.Children.Add(Ui.Text("译为", 13)); languages.Children.Add(target);
        top.Children.Add(languages);
        var buttons = new WrapPanel();
        buttons.Children.Add(Ui.AsyncButton("查词 / 翻译", () => RunAsync(true), ShowError));
        buttons.Children.Add(Ui.AsyncButton("重新翻译", () => RunAsync(false), ShowError));
        buttons.Children.Add(Ui.Button("取消", Cancel));
        buttons.Children.Add(Ui.Button("复制结果", CopyResult));
        buttons.Children.Add(Ui.Button("设置", openSettings));
        top.Children.Add(buttons);
        top.Children.Add(status);
        Add(top, 2);
        var followup = new StackPanel();
        followup.Children.Add(Ui.Text("基于上方原文继续提问", 13));
        followup.Children.Add(question);
        followup.Children.Add(Ui.AsyncButton("提问", AskAsync, ShowError));
        Add(followup, 4); Add(output, 3);
        Content = new ScrollViewer { Content = panel, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
        Closing += (_, args) => { Cancel(); if (!allowClose) { args.Cancel = true; Hide(); } };
        PreviewKeyDown += (_, args) => { if (args.Key == Key.Escape) { Cancel(); Hide(); args.Handled = true; } };
    }

    public void ResetLanguages()
    {
        source.Text = runtime.Settings.SourceLanguage;
        target.Text = runtime.Settings.TargetLanguage;
    }

    public void PrepareSmokePreview()
    {
        input.Text = "This preview checks the Windows reading window. No translation service is called.";
        output.Text = "Windows 界面渲染检查。此处为本地示例文字，未调用翻译服务。";
        question.Text = "这段文字的意思是什么？";
        status.Text = "本地示例 · 未调用模型";
    }

    public bool IsLayoutReachable()
    {
        if (Content is not ScrollViewer { Content: Grid grid, ViewportHeight: > 0, ViewportWidth: > 0 }) return false;
        return grid.Children.OfType<FrameworkElement>().All(element =>
        {
            Rect bounds = element.TransformToAncestor(grid).TransformBounds(new Rect(element.RenderSize));
            return element.ActualWidth > 0 && element.ActualHeight > 0 && bounds.Left >= -0.5 && bounds.Top >= -0.5
                && bounds.Right <= grid.ActualWidth + 0.5 && bounds.Bottom <= grid.ActualHeight + 0.5;
        });
    }

    public async Task PresentAsync(SelectionResult selection, bool automatic)
    {
        Cancel();
        input.Text = selection.Text ?? "";
        question.Clear();
        output.Clear();
        status.Text = selection.Message;
        ShowActivated = !automatic;
        if (!IsVisible) Show();
        if (!automatic) { Activate(); input.Focus(); input.CaretIndex = input.Text.Length; }
        if (selection.Text is not null) await RunAsync(true);
    }

    private async Task RunAsync(bool useDictionary)
    {
        string? text = SelectionPolicy.Normalize(input.Text, false);
        if (text is null) { status.Text = "请输入 1–12,000 字符的普通文本。"; return; }
        string sourceLanguage = source.Text.Trim(), targetLanguage = target.Text.Trim();
        if (sourceLanguage is not ("en" or "zh-Hans") || targetLanguage is not ("en" or "zh-Hans") || sourceLanguage == targetLanguage) { status.Text = "请选择不同的源语言与目标语言：en / zh-Hans。"; return; }
        Cancel();
        var current = new CancellationTokenSource();
        request = current;
        status.Text = "处理中…";
        try
        {
            if (useDictionary && SelectionPolicy.IsDictionaryWord(text))
            {
                LookupResult? found = await runtime.LookupAsync(text, current.Token);
                if (found is not null)
                {
                    current.Token.ThrowIfCancellationRequested();
                    output.Text = string.Join("\n\n", Array.FindAll(new[] { found.Word, found.Phonetic, found.Translation, found.Definition }, value => !string.IsNullOrWhiteSpace(value)));
                    status.Text = "离线词典";
                    return;
                }
            }
            string translated = await runtime.TranslateAsync(text, sourceLanguage, targetLanguage, current.Token);
            current.Token.ThrowIfCancellationRequested();
            if (request == current) { output.Text = translated; status.Text = "翻译完成"; }
        }
        catch (OperationCanceledException) { if (request == current) status.Text = "已取消"; }
        catch (Exception error) { if (request == current) ShowError(error); }
        finally { if (request == current) request = null; current.Dispose(); }
    }

    private async Task AskAsync()
    {
        string? text = SelectionPolicy.Normalize(input.Text, false);
        string? prompt = SelectionPolicy.Normalize(question.Text, false);
        if (text is null) { status.Text = "请先输入或选取原文。"; return; }
        if (prompt is null || prompt.Length > 4_000) { status.Text = "请输入 1–4,000 字符的问题。"; return; }
        Cancel();
        var current = new CancellationTokenSource();
        request = current;
        status.Text = "正在回答…";
        try
        {
            string answer = await runtime.AskAsync(prompt, text, current.Token);
            current.Token.ThrowIfCancellationRequested();
            if (request == current) { output.Text = answer; status.Text = "回答完成（基于上方原文）"; }
        }
        catch (OperationCanceledException) { if (request == current) status.Text = "已取消"; }
        catch (Exception error) { if (request == current) ShowError(error); }
        finally { if (request == current) request = null; current.Dispose(); }
    }

    public void Cancel()
    {
        if (request is { } current) { request = null; current.Cancel(); status.Text = "已取消"; }
    }

    private void CopyResult()
    {
        if (string.IsNullOrWhiteSpace(output.Text)) { status.Text = "还没有可复制的结果。"; return; }
        try { Clipboard.SetText(output.Text); status.Text = "结果已复制"; }
        catch (ExternalException) { status.Text = "剪贴板暂被占用，请稍后重试。"; }
    }

    private void ShowError(Exception error) => status.Text = Ui.Error(error);

    public void CloseForExit() { allowClose = true; Cancel(); Close(); }
}
