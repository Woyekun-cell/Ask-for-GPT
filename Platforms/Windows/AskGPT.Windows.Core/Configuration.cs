using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace AskGPT.Windows.Core;

public sealed record AppSettings {
    public string Provider { get; init; } = "codex";
    public string CliPath { get; init; } = "";
    public string Model { get; init; } = "gpt-6.1-sol";
    public string Endpoint { get; init; } = "";
    public string ApiKeyFile { get; init; } = "";
    public string TranslationConfigurationPath { get; init; } = "";
    public string SourceLanguage { get; init; } = "en";
    public string TargetLanguage { get; init; } = "zh-Hans";
    public bool AutomaticSelection { get; init; }
    public uint HotKeyModifiers { get; init; } = 1;
    public uint HotKeyKey { get; init; } = 0x44;
}
public static class AppPaths {
    public static string DataDirectory {
        get {
            var smoke=Environment.GetEnvironmentVariable("ASKGPT_DATA_DIRECTORY");
            if(Environment.GetCommandLineArgs().Contains("--smoke-test",StringComparer.Ordinal) && !string.IsNullOrWhiteSpace(smoke)) {
                if(!Path.IsPathFullyQualified(smoke)) throw new ConfigurationException("测试数据目录须为绝对路径。");
                return Path.GetFullPath(smoke);
            }
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),"AskGPTReader");
        }
    }
    public static string DefaultCodexPath => Path.Combine(DataDirectory,"Tools","codex-0.163.0","vendor","x86_64-pc-windows-msvc","bin","codex.exe");
    public static string BundleDirectory => AppContext.BaseDirectory;
    public static string SettingsPath => Path.Combine(DataDirectory,"windows-settings.json");
    public static string ConnectionPath => Path.Combine(DataDirectory,"inline-connection.json");
    public static string PdfDirectory => Path.Combine(DataDirectory,"PDFLayout");
    public static string PythonPath => Path.Combine(PdfDirectory,"runtime","Scripts","python.exe");
    public static string TranslationHelperPath => Path.Combine(BundleDirectory,"AskGPT.Translate.exe");
}
public sealed class ConfigurationException(string message) : Exception(message);
public static class SettingsStore {
    public static JsonSerializerOptions JsonOptions { get; } = new() { PropertyNamingPolicy=JsonNamingPolicy.CamelCase, WriteIndented=true, UnmappedMemberHandling=JsonUnmappedMemberHandling.Disallow };
    public static AppSettings Load() {
        if(!File.Exists(AppPaths.SettingsPath)) return new() {CliPath=File.Exists(AppPaths.DefaultCodexPath)?AppPaths.DefaultCodexPath:""};
        var settings=JsonSerializer.Deserialize<AppSettings>(ProtectedFiles.Read(AppPaths.SettingsPath,64*1024,true),JsonOptions) ?? throw new ConfigurationException("设置文件为空。");
        Validate(settings); return settings;
    }
    public static void Validate(AppSettings settings) {
        if(settings.Provider is not ("codex" or "claude-code" or "openai-compatible") || settings.Model is null || settings.Model.Length>256 || settings.Model.Any(char.IsControl) || settings.SourceLanguage is not ("en" or "zh-Hans") || settings.TargetLanguage is not ("en" or "zh-Hans") || settings.SourceLanguage==settings.TargetLanguage || settings.HotKeyKey is <1 or >254 || settings.HotKeyModifiers>15)
            throw new ConfigurationException("语言、后端或快捷键设置无效。");
        foreach(var path in new[]{settings.CliPath,settings.ApiKeyFile,settings.TranslationConfigurationPath}) if(!string.IsNullOrEmpty(path) && (!Path.IsPathFullyQualified(path) || path.Any(char.IsControl))) throw new ConfigurationException("文件路径须为绝对路径。");
    }
    public static void Save(AppSettings settings) { Validate(settings); ProtectedFiles.Write(AppPaths.SettingsPath,JsonSerializer.SerializeToUtf8Bytes(settings,JsonOptions)); }
}
public sealed record ProviderConfiguration {
    public string Provider { get; init; }="codex";
    public string CliPath { get; init; }="";
    public string Model { get; init; }="";
    public string Endpoint { get; init; }="";
    public string ApiKeyFile { get; init; }="";
    [JsonIgnore] public string Identity { get; init; }="";
    internal string IdentityWithKey(byte[] key) => Convert.ToHexStringLower(SHA256.HashData([..JsonSerializer.SerializeToUtf8Bytes(this,SettingsStore.JsonOptions),..SHA256.HashData(key)]));
    public static ProviderConfiguration FromSettings(AppSettings settings) {
        SettingsStore.Validate(settings);
        ProviderConfiguration config;
        if(!string.IsNullOrEmpty(settings.TranslationConfigurationPath)) {
            var data=ProtectedFiles.Read(settings.TranslationConfigurationPath,64*1024,false);
            try { using var document=StrictJson.Parse(data); config=JsonSerializer.Deserialize<ProviderConfiguration>(data,SettingsStore.JsonOptions) ?? throw new JsonException(); }
            catch(JsonException) { throw new ConfigurationException("翻译配置须使用 provider、endpoint、model、apiKeyFile、cliPath JSON 字段。"); }
        } else { config=new() {Provider=settings.Provider,CliPath=settings.CliPath,Model=settings.Model,Endpoint=settings.Endpoint,ApiKeyFile=settings.ApiKeyFile}; }
        if(new[]{config.Provider,config.CliPath,config.Model,config.Endpoint,config.ApiKeyFile}.Any(v=>v is null || v.Any(char.IsControl)) || config.Model.Length>256) throw new ConfigurationException("翻译配置包含无效字段。");
        byte[] fingerprint=[];
        if(config.Provider=="openai-compatible") {
            if(!Uri.TryCreate(config.Endpoint,UriKind.Absolute,out var endpoint) || endpoint.Scheme!="https" || string.IsNullOrEmpty(endpoint.Host) || !string.IsNullOrEmpty(endpoint.UserInfo) || !string.IsNullOrEmpty(endpoint.Fragment) || string.IsNullOrWhiteSpace(config.Model) || !Path.IsPathFullyQualified(config.ApiKeyFile)) throw new ConfigurationException("API 需要完整 HTTPS endpoint、model 和绝对 apiKeyFile 路径。");
            var key=ProtectedFiles.Read(config.ApiKeyFile,16*1024,true);
            fingerprint=SHA256.HashData(key);
        } else if(config.Provider is "codex" or "claude-code") {
            if(!Path.IsPathFullyQualified(config.CliPath) || !File.Exists(config.CliPath) || (OperatingSystem.IsWindows() && !config.CliPath.EndsWith(".exe",StringComparison.OrdinalIgnoreCase))) throw new ConfigurationException("请选择真实 CLI .exe 的绝对路径；不支持 .cmd/.bat 包装器。");
            ProtectedFiles.RejectLinks(config.CliPath);
            if(config.Provider=="codex" && string.IsNullOrWhiteSpace(config.Model)) throw new ConfigurationException("Codex 需要模型名称。");
        } else throw new ConfigurationException("provider 须为 codex、claude-code 或 openai-compatible。");
        // The helper reads the serialized effective snapshot, not the original
        // user JSON. Hash these same bytes on both sides, plus key content.
        var snapshot=JsonSerializer.SerializeToUtf8Bytes(config,SettingsStore.JsonOptions);
        return config with {Identity=Convert.ToHexStringLower(SHA256.HashData([..snapshot,..fingerprint]))};
    }
}
public static class StrictJson {
    public static JsonDocument Parse(byte[] data) { var document=JsonDocument.Parse(data,new JsonDocumentOptions{MaxDepth=32}); try { Check(document.RootElement); return document; } catch { document.Dispose(); throw; } }
    public static JsonDocument Parse(string text) => Parse(Encoding.UTF8.GetBytes(text));
    private static void Check(JsonElement e) {
        if(e.ValueKind==JsonValueKind.Object) { var names=new HashSet<string>(StringComparer.Ordinal); foreach(var p in e.EnumerateObject()) { if(!names.Add(p.Name)) throw new JsonException("Duplicate JSON key."); Check(p.Value); } }
        else if(e.ValueKind==JsonValueKind.Array) foreach(var item in e.EnumerateArray()) Check(item);
    }
}
