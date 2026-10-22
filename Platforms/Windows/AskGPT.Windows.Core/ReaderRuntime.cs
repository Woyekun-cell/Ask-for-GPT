using System.Net.Http.Headers;
using System.Text.Json;

namespace AskGPT.Windows.Core;
public sealed class ReaderRuntime : IAsyncDisposable {
    public AppSettings Settings {get;private set;}
    public string StatusText {get;private set;}="本机阅读服务已连接；请配置翻译后端。";
    public bool PdfReady => File.Exists(AppPaths.PythonPath) && File.Exists(Path.Combine(AppPaths.PdfDirectory,"assets-ready.json"));
    private readonly TranslationService translation=new();
    private readonly DictionaryLookup dictionary=new(Path.Combine(AppPaths.BundleDirectory,"Resources","Dictionary","words.sqlite"));
    private readonly PairingConfiguration pairing;
    private readonly CancellationTokenSource lifetime=new();
    private readonly SemaphoreSlim configurationGate=new(1,1);
    private readonly InlineServer inline;
    private OwnedProcess? pdf;
    private bool disposed;
    private ReaderRuntime(AppSettings settings,PairingConfiguration pairing) {Settings=settings;this.pairing=pairing;inline=new(pairing,TranslateAsync);}
    public static async Task<ReaderRuntime> StartAsync(CancellationToken cancellationToken=default) {
        ProtectedFiles.EnsureDirectory(AppPaths.DataDirectory);
        var runtime=new ReaderRuntime(SettingsStore.Load(),PairingConfiguration.LoadOrCreate(AppPaths.ConnectionPath));
        try{await runtime.inline.StartAsync(cancellationToken);runtime.UpdateStatus();return runtime;}catch{await runtime.DisposeAsync();throw;}
    }
    private void UpdateStatus() {try{_ = ProviderConfiguration.FromSettings(Settings);StatusText="本机阅读服务已就绪；后端配置有效，实际连接需用户确认。";}catch(ConfigurationException){StatusText="本机阅读服务已就绪；请先配置翻译后端。";}}
    public async Task<string> TranslateAsync(string text,string source,string target,CancellationToken cancellationToken=default) {ObjectDisposedException.ThrowIf(disposed,this);using var joined=CancellationTokenSource.CreateLinkedTokenSource(cancellationToken,lifetime.Token);return await translation.TranslateAsync(Settings,text,source,target,joined.Token);}
    public async Task<string> AskAsync(string question,string context,CancellationToken cancellationToken=default) {ObjectDisposedException.ThrowIf(disposed,this);using var joined=CancellationTokenSource.CreateLinkedTokenSource(cancellationToken,lifetime.Token);return await translation.AskAsync(Settings,question,context,joined.Token);}
    public Task<LookupResult?> LookupAsync(string word,CancellationToken cancellationToken=default) {ObjectDisposedException.ThrowIf(disposed,this);return dictionary.LookupAsync(word,cancellationToken);}
    public async Task UpdateSettingsAsync(AppSettings settings,CancellationToken cancellationToken=default) {
        SettingsStore.Validate(settings);await configurationGate.WaitAsync(cancellationToken);
        try{if(pdf is not null){await pdf.DisposeAsync();pdf=null;}SettingsStore.Save(settings);Settings=settings;translation.Clear();UpdateStatus();}finally{configurationGate.Release();}
    }
    public Task<string> ExportIntegrationsAsync(string targetDirectory,CancellationToken cancellationToken=default) => new IntegrationExporter(AppPaths.BundleDirectory,pairing).ExportAsync(targetDirectory,cancellationToken);
    public async Task StartPdfAsync(CancellationToken cancellationToken=default) {
        ObjectDisposedException.ThrowIf(disposed,this);await configurationGate.WaitAsync(cancellationToken);
        try {
            if(pdf is not null){if(!pdf.Process.HasExited)return;await pdf.DisposeAsync();pdf=null;}
            if(!PdfReady)throw new ConfigurationException("请先完整准备 PDF 组件与资源。");
            var script=Path.Combine(AppPaths.BundleDirectory,"Integrations","PDFLayout","server.py");if(!File.Exists(script)||!File.Exists(AppPaths.TranslationHelperPath))throw new ConfigurationException("安装包缺少 PDF 引擎或翻译辅助程序。");
            var config=ProviderConfiguration.FromSettings(Settings);ProtectedFiles.EnsureDirectory(AppPaths.PdfDirectory);
            var snapshot=Path.Combine(AppPaths.PdfDirectory,"translation-configuration.json");ProtectedFiles.Write(snapshot,JsonSerializer.SerializeToUtf8Bytes(config,SettingsStore.JsonOptions));
            var env=new Dictionary<string,string?>{{"PYTHONUNBUFFERED","1"},{"PYTHONDONTWRITEBYTECODE","1"},{"ASKGPT_TRANSLATION_CONFIGURATION_PATH",snapshot},{"ASKGPT_TRANSLATION_CACHE_ID",config.Identity}};
            pdf=OwnedProcess.Start(AppPaths.PythonPath,[script,"--config",AppPaths.ConnectionPath,"--translator",AppPaths.TranslationHelperPath,"--cache-root",AppPaths.PdfDirectory],env);
            pdf.StandardInput.Close();
            _=DrainPdfAsync(pdf.StandardOutput.BaseStream);_=DrainPdfAsync(pdf.StandardError.BaseStream);
            using var client=new HttpClient(new HttpClientHandler{AllowAutoRedirect=false,UseCookies=false}) {Timeout=TimeSpan.FromSeconds(2)};
            for(var i=0;i<40;i++) {
                cancellationToken.ThrowIfCancellationRequested();if(pdf.Process.HasExited)throw new ConfigurationException("PDF 服务启动失败，请重新准备组件。");
                try {using var request=new HttpRequestMessage(HttpMethod.Get,"http://127.0.0.1:43795/v1/pdf/health");request.Headers.Authorization=new AuthenticationHeaderValue("Bearer",pairing.Token);using var response=await client.SendAsync(request,cancellationToken);if(response.IsSuccessStatusCode){using var body=StrictJson.Parse(await BoundedIO.ReadAsync(await response.Content.ReadAsStreamAsync(cancellationToken),16384,cancellationToken));if(body.RootElement.GetProperty("status").GetString()=="ready"){StatusText="阅读服务与 PDF 组件已就绪。";return;}}}catch(HttpRequestException){}catch(TaskCanceledException) when(!cancellationToken.IsCancellationRequested){}await Task.Delay(250,cancellationToken);
            }
            throw new ConfigurationException("PDF 服务未及时就绪，请检查组件安装。");
        } catch {if(pdf is not null){await pdf.DisposeAsync();pdf=null;}throw;}finally{configurationGate.Release();}
    }
    private async Task DrainPdfAsync(Stream stream) {try{var buffer=new byte[8192];while(await stream.ReadAsync(buffer,lifetime.Token)>0){} }catch(OperationCanceledException){}catch(IOException){}catch(ObjectDisposedException){}}
    public async ValueTask DisposeAsync() {if(disposed)return;disposed=true;lifetime.Cancel();await inline.DisposeAsync();if(pdf is not null)await pdf.DisposeAsync();translation.Dispose();configurationGate.Dispose();lifetime.Dispose();}
}
