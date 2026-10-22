using AskGPT.Windows.Core;
using System.Text;
using System.Text.Json;

Console.InputEncoding=Encoding.UTF8;Console.OutputEncoding=new UTF8Encoding(false);
var mode=args.Length==0?"":args.Length==1?args[0]:"invalid";
if(mode is not ("" or "--gpt-batch" or "--gpt-align" or "--gpt-phrase-align" or "--gpt-selection-align")) {Console.WriteLine("{\"id\":\"\",\"error\":\"invalid_request\"}");return 2;}
using var stopping=new CancellationTokenSource();Console.CancelKeyPress+=(_,e)=>{e.Cancel=true;stopping.Cancel();};
while(!stopping.IsCancellationRequested) {
    string? line;
    try{line=await BoundedIO.ReadLineAsync(Console.In,mode==""?65536:256*1024,stopping.Token);if(line is null)break;}catch(OperationCanceledException){break;}catch(TranslationException){Console.WriteLine("{\"id\":\"\",\"error\":\"invalid_request\"}");return 2;}
    try {
        using var request=StrictJson.Parse(line);var path=Environment.GetEnvironmentVariable("ASKGPT_TRANSLATION_CONFIGURATION_PATH");var settings=string.IsNullOrEmpty(path)?SettingsStore.Load():new AppSettings {TranslationConfigurationPath=path};
        // Resolve at request time so CLI-only startup never performs a model call.
        var provider=new DeferredProvider(settings);
        var protocol=new PdfTranslationProtocol(provider);var response=await protocol.HandleAsync(mode,request.RootElement,stopping.Token);Console.WriteLine(JsonSerializer.Serialize(response));
    }catch(OperationCanceledException){break;}catch(JsonException){Console.WriteLine("{\"id\":\"\",\"error\":\"invalid_request\"}");}catch(Exception){Console.WriteLine("{\"id\":\"\",\"error\":\"gpt_unavailable\"}");}
}
return 0;
sealed class DeferredProvider(AppSettings settings):ITranslationProvider {
    public Task PrepareAsync(CancellationToken ct) => new ConfiguredProvider(Resolve()).PrepareAsync(ct);
    private ProviderConfiguration Resolve() {var config=ProviderConfiguration.FromSettings(settings);var expected=Environment.GetEnvironmentVariable("ASKGPT_TRANSLATION_CACHE_ID");if(!string.IsNullOrEmpty(expected)&&config.Identity!=expected)throw new ConfigurationException("翻译配置已改变，请重新启动 PDF 服务。");return config;}
    public Task<string> CompleteAsync(string instructions,string input,JsonElement? schema,CancellationToken ct) {
        var config=Resolve();
        return new ConfiguredProvider(config).CompleteAsync(instructions,input,schema,ct);
    }
}
