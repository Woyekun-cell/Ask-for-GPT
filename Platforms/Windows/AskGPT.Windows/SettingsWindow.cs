using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using AskGPT.Windows.Core;
using Microsoft.Win32;

namespace AskGPT.Windows;

internal sealed class SettingsWindow : Window
{
    private readonly ReaderRuntime runtime;
    private readonly Func<AppSettings, Task> save;
    private readonly Dictionary<string, TextBox> fields = new();
    private readonly ComboBox provider = new() { MinHeight = 32 };
    private readonly CheckBox automatic = new() { Content = "启用自动划词（拖选 / 双击后读取短文本）", Margin = new Thickness(0, 8, 0, 8) };
    private readonly CheckBox alt = new() { Content = "Alt", Margin = new Thickness(0, 0, 12, 0) };
    private readonly CheckBox control = new() { Content = "Ctrl", Margin = new Thickness(0, 0, 12, 0) };
    private readonly CheckBox shift = new() { Content = "Shift", Margin = new Thickness(0, 0, 12, 0) };
    private readonly CheckBox win = new() { Content = "Win", Margin = new Thickness(0, 0, 12, 0) };
    private readonly TextBox key = new() { Width = 55, MaxLength = 1, MinHeight = 30, VerticalContentAlignment = VerticalAlignment.Center };
    private readonly TextBlock status = Ui.Text("", 13, true);
    private bool allowClose;

    public SettingsWindow(ReaderRuntime runtime, Func<AppSettings, Task> save, Func<string, Task> prepare, Func<Task> startPdf, Func<Task> export, Action openGuide, Action loginHelp, Action quit)
    {
        this.runtime = runtime; this.save = save;
        Title = "Ask for GPT · 设置"; Ui.SizeToWorkArea(this, 790, 790, 560, 480);
        FontFamily = new System.Windows.Media.FontFamily("Microsoft YaHei UI"); FontSize = 14;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        var body = new StackPanel { Margin = new Thickness(24) };
        body.Children.Add(Ui.Text("Ask for GPT 阅读助手", 26));
        body.Children.Add(Ui.Text("选中文字，按 Alt+D。英文单词可离线查词；联网翻译需先配置后端。关闭此窗口后仍在托盘运行。", 13, true));
        body.Children.Add(status);
        body.Children.Add(Ui.Text("翻译后端", 17));
        provider.Items.Add(new ComboBoxItem { Content = "Codex CLI", Tag = "codex" });
        provider.Items.Add(new ComboBoxItem { Content = "OpenAI 兼容 API（含 DeepSeek）", Tag = "openai-compatible" });
        provider.Items.Add(new ComboBoxItem { Content = "Claude Code", Tag = "claude-code" });
        provider.Margin = new Thickness(0, 0, 0, 12); body.Children.Add(provider);
        AddField(body, "CliPath", "CLI 程序路径", "选择 .exe 文件；不要选择 npm 的 .cmd / .bat 启动脚本。", true);
        AddField(body, "Model", "模型", "填写该后端支持的模型名。");
        AddField(body, "Endpoint", "API 端点", "仅 API 后端需要，例如你所使用服务的兼容接口地址。");
        AddField(body, "ApiKeyFile", "API 密钥文件", "选择仅当前用户可读的密钥文本文件；配对导出不包含密钥。", true);
        AddField(body, "TranslationConfigurationPath", "外部翻译配置（可选）", "沿用已有 JSON 配置时选择此文件；应用只读加载，不改写文件。", true);
        var languages = new Grid(); languages.ColumnDefinitions.Add(new() { Width = new GridLength(1, GridUnitType.Star) }); languages.ColumnDefinitions.Add(new() { Width = new GridLength(1, GridUnitType.Star) });
        var left = new StackPanel { Margin = new Thickness(0, 0, 12, 0) }; var right = new StackPanel(); Grid.SetColumn(right, 1);
        AddField(left, "SourceLanguage", "源语言", "en / zh-Hans");
        AddField(right, "TargetLanguage", "目标语言", "zh-Hans / en");
        languages.Children.Add(left); languages.Children.Add(right); body.Children.Add(languages);
        body.Children.Add(Ui.Text("划词快捷键", 17));
        var shortcut = new WrapPanel { Margin = new Thickness(0, 0, 0, 8) };
        shortcut.Children.Add(alt); shortcut.Children.Add(control); shortcut.Children.Add(shift); shortcut.Children.Add(win); shortcut.Children.Add(key); body.Children.Add(shortcut);
        body.Children.Add(automatic);
        body.Children.Add(Ui.Text("自动划词默认关闭。启用后仅在前台应用拖选或双击时读取不超过 1,200 字符；不会自动使用剪贴板。", 12, true));
        var actions = new WrapPanel();
        actions.Children.Add(Ui.AsyncButton("保存设置", SaveAsync, ShowError));
        actions.Children.Add(Ui.AsyncButton("准备 Codex CLI", () => prepare("prepare-codex.ps1"), ShowError));
        actions.Children.Add(Ui.Button("CLI 登录帮助", loginHelp));
        body.Children.Add(actions);
        body.Children.Add(Ui.Text("网页、Zotero 与 PDF", 17));
        body.Children.Add(Ui.Text("导出扩展后，按安装指南在 Chrome / Zotero 中加载。首次使用 PDF 对照阅读需准备组件；原 PDF 保留。", 13, true));
        var reading = new WrapPanel();
        reading.Children.Add(Ui.AsyncButton("导出阅读集成", export, ShowError));
        reading.Children.Add(Ui.AsyncButton("准备 PDF 组件", () => prepare("prepare-pdf.ps1"), ShowError));
        reading.Children.Add(Ui.AsyncButton("启动 PDF 服务", startPdf, ShowError));
        reading.Children.Add(Ui.Button("安装指南", openGuide));
        body.Children.Add(reading);
        body.Children.Add(Ui.Text("Windows 预览版：构建和自动检查不代表 Windows 10 / 11 桌面实机验收。", 12, true));
        body.Children.Add(Ui.Button("退出应用", quit));
        Content = new ScrollViewer { Content = body, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        LoadValues();
        Closing += (_, args) => { if (!allowClose) { args.Cancel = true; Hide(); } };
        PreviewKeyDown += (_, args) => { if (args.Key == Key.Escape) { Hide(); args.Handled = true; } };
    }

    private void AddField(Panel parent, string name, string label, string hint, bool browse = false)
    {
        parent.Children.Add(Ui.Text(label, 13));
        var row = new DockPanel { Margin = new Thickness(0, 0, 0, 5) };
        var input = new TextBox { MinHeight = 32, VerticalContentAlignment = VerticalAlignment.Center, Padding = new Thickness(7, 3, 7, 3), MaxLength = 4096 };
        fields.Add(name, input);
        if (browse)
        {
            var button = Ui.Button("浏览…", () =>
            {
                var dialog = new OpenFileDialog { CheckFileExists = true, Title = label, Filter = name == "CliPath" ? "可执行文件 (*.exe)|*.exe|所有文件|*.*" : "所有文件|*.*" };
                if (dialog.ShowDialog(this) == true) input.Text = dialog.FileName;
            });
            button.Margin = new Thickness(8, 0, 0, 0); DockPanel.SetDock(button, Dock.Right); row.Children.Add(button);
        }
        row.Children.Add(input); parent.Children.Add(row); parent.Children.Add(Ui.Text(hint, 12, true));
    }

    private void LoadValues()
    {
        AppSettings settings = runtime.Settings;
        foreach (ComboBoxItem item in provider.Items) if ((string)item.Tag == settings.Provider) provider.SelectedItem = item;
        if (provider.SelectedItem is null) provider.SelectedIndex = 0;
        fields["CliPath"].Text = settings.CliPath; fields["Model"].Text = settings.Model; fields["Endpoint"].Text = settings.Endpoint;
        fields["ApiKeyFile"].Text = settings.ApiKeyFile; fields["TranslationConfigurationPath"].Text = settings.TranslationConfigurationPath;
        fields["SourceLanguage"].Text = settings.SourceLanguage; fields["TargetLanguage"].Text = settings.TargetLanguage;
        automatic.IsChecked = settings.AutomaticSelection;
        alt.IsChecked = (settings.HotKeyModifiers & 1) != 0; control.IsChecked = (settings.HotKeyModifiers & 2) != 0;
        shift.IsChecked = (settings.HotKeyModifiers & 4) != 0; win.IsChecked = (settings.HotKeyModifiers & 8) != 0;
        key.Text = char.ConvertFromUtf32((int)settings.HotKeyKey);
        RefreshStatus();
    }

    private async Task SaveAsync()
    {
        string chosenKey = key.Text.Trim().ToUpperInvariant();
        if (chosenKey.Length != 1 || !char.IsAsciiLetterOrDigit(chosenKey[0])) throw new InvalidOperationException("快捷键主键请填写一个英文字母或数字。");
        uint modifiers = (alt.IsChecked == true ? 1u : 0u) | (control.IsChecked == true ? 2u : 0u) | (shift.IsChecked == true ? 4u : 0u) | (win.IsChecked == true ? 8u : 0u);
        string Field(string name) => fields[name].Text.Trim();
        await save(runtime.Settings with
        {
            Provider = (string)((ComboBoxItem)provider.SelectedItem).Tag,
            CliPath = Field("CliPath"), Model = Field("Model"), Endpoint = Field("Endpoint"), ApiKeyFile = Field("ApiKeyFile"),
            TranslationConfigurationPath = Field("TranslationConfigurationPath"), SourceLanguage = Field("SourceLanguage"), TargetLanguage = Field("TargetLanguage"),
            AutomaticSelection = automatic.IsChecked == true, HotKeyModifiers = modifiers, HotKeyKey = chosenKey[0]
        });
        RefreshStatus("设置已保存。 ");
    }

    public void RefreshStatus(string prefix = "") => status.Text = prefix + runtime.StatusText + (runtime.PdfReady ? " · PDF 组件已就绪" : " · PDF 组件未准备");
    public void RefreshCliPath() { if (string.IsNullOrWhiteSpace(fields["CliPath"].Text)) fields["CliPath"].Text = runtime.Settings.CliPath; }
    public bool IsLayoutReachable() => Content is ScrollViewer { ViewportHeight: > 0, ViewportWidth: > 0, ExtentHeight: > 0 }
        && fields.Values.All(field => field.ActualWidth > 0 && field.ActualHeight > 0);
    public void SetStatus(string message) => status.Text = message;
    private void ShowError(Exception error) => status.Text = Ui.Error(error);
    public void CloseForExit() { allowClose = true; Close(); }
}
