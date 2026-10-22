using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace AskGPT.Windows.Core;
public sealed record PairingConfiguration {
    public int Version {get;init;}=1;
    public string Endpoint {get;init;}="http://127.0.0.1:43792";
    public string Token {get;init;}=Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
    [System.Text.Json.Serialization.JsonPropertyName("extensionID")] public string ExtensionID {get;init;}="ofcbkomnacejiphoifjmkmkpjcjddmfj";
    public void Validate() { if(Version!=1 || Endpoint!="http://127.0.0.1:43792" || Token.Length is <32 or >256 || Token.Any(c=>c<33||c>126) || ExtensionID.Length!=32 || ExtensionID.Any(c=>c<'a'||c>'p')) throw new ConfigurationException("本机配对文件无效。"); }
    public static PairingConfiguration LoadOrCreate(string path) {
        PairingConfiguration value;
        if(File.Exists(path)) { try {using var d=StrictJson.Parse(ProtectedFiles.Read(path,8192,true));value=JsonSerializer.Deserialize<PairingConfiguration>(d.RootElement,SettingsStore.JsonOptions)??throw new JsonException();}catch(JsonException){throw new ConfigurationException("本机配对文件无效。");} }
        else {value=new();ProtectedFiles.Write(path,JsonSerializer.SerializeToUtf8Bytes(value,SettingsStore.JsonOptions));}
        value.Validate();return value;
    }
}
public sealed class InlineServer(PairingConfiguration pairing,Func<string,string,string,CancellationToken,Task<string>> translate,int port=43792) : IAsyncDisposable {
    private WebApplication? app;
    private readonly SemaphoreSlim active=new(1,1);
    private readonly CancellationTokenSource lifetime=new();
    public int Port {get;private set;}=port;
    public async Task StartAsync(CancellationToken ct) {
        var builder=WebApplication.CreateSlimBuilder(new WebApplicationOptions {Args=[],ApplicationName=typeof(InlineServer).Assembly.FullName,ContentRootPath=AppContext.BaseDirectory}); builder.Logging.ClearProviders();
        builder.WebHost.ConfigureKestrel(options=>{options.Listen(IPAddress.Loopback,Port);options.Limits.MaxRequestBodySize=16*1024;options.Limits.MaxRequestHeadersTotalSize=16*1024;options.Limits.RequestHeadersTimeout=TimeSpan.FromSeconds(5);options.Limits.KeepAliveTimeout=TimeSpan.FromSeconds(5);options.Limits.MaxConcurrentConnections=16;});
        app=builder.Build();app.Run(Handle);await app.StartAsync(ct);
        var addresses=app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>(); Port=new Uri(addresses!.Addresses.Single()).Port;
    }
    private async Task Handle(HttpContext context) {
        var request=context.Request; var response=context.Response;
        async Task Error(int status,string code,string message) { response.StatusCode=status;await response.WriteAsJsonAsync(new {error=code,message},context.RequestAborted); }
        try {
            if(request.Host.Value!=$"127.0.0.1:{Port}") {await Error(403,"invalid_host","仅接受固定本机地址。");return;}
            var origin=request.Headers.Origin.ToString();var allowed="chrome-extension://"+pairing.ExtensionID;
            if(origin.Length>0 && origin!=allowed) {await Error(403,"invalid_origin","请求来源未配对。");return;}
            if(origin.Length>0) {response.Headers.AccessControlAllowOrigin=allowed;response.Headers.Vary="Origin";}
            var path=request.Path.Value; var known=path is "/v1/inline/health" or "/v1/inline/translate";
            if(request.Method=="OPTIONS") {
                var headers=request.Headers.AccessControlRequestHeaders.ToString().Split(',',StringSplitOptions.TrimEntries|StringSplitOptions.RemoveEmptyEntries);
                if(origin!=allowed || !known || request.Headers.AccessControlRequestMethod.ToString() is not ("GET" or "POST") || headers.Any(h=>h.ToLowerInvariant() is not ("authorization" or "content-type")) || request.Headers.TryGetValue("Access-Control-Request-Private-Network",out var privateNetwork) && privateNetwork!="true") {await Error(403,"invalid_preflight","不接受此预检请求。");return;}
                response.Headers.AccessControlAllowMethods="GET, POST, OPTIONS";response.Headers.AccessControlAllowHeaders="Authorization, Content-Type";response.Headers["Access-Control-Allow-Private-Network"]="true";response.StatusCode=204;return;
            }
            var actual=Encoding.UTF8.GetBytes(request.Headers.Authorization.ToString());var expected=Encoding.UTF8.GetBytes("Bearer "+pairing.Token);
            if(!CryptographicOperations.FixedTimeEquals(actual,expected)) {await Error(401,"unauthorized","本机连接令牌不匹配。");return;}
            if(request.Method=="GET" && path=="/v1/inline/health") {await response.WriteAsJsonAsync(new {status="ready",protocolVersion=1});return;}
            if(request.Method!="POST" || path!="/v1/inline/translate") {await Error(404,"not_found","不存在此原位翻译接口。");return;}
            if(request.ContentType?.Split(';')[0].Trim().ToLowerInvariant()!="application/json") {await Error(415,"unsupported_media_type","请求必须为 JSON。");return;}
            if(request.ContentLength>16384) {await Error(413,"request_too_large","请求过大。");return;}
            using var timeout=CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted,lifetime.Token);timeout.CancelAfter(TimeSpan.FromSeconds(120));
            var bytes=await BoundedIO.ReadAsync(request.Body,16384,timeout.Token);using var document=StrictJson.Parse(bytes);var root=document.RootElement;
            if(root.ValueKind!=JsonValueKind.Object)throw new JsonException();
            var names=root.EnumerateObject().Select(p=>p.Name).ToHashSet();if(!names.SetEquals(new[]{"id","text","source","target"}) || root.EnumerateObject().Any(p=>p.Value.ValueKind!=JsonValueKind.String)) throw new JsonException();
            var id=root.GetProperty("id").GetString()!;var text=root.GetProperty("text").GetString()!;var source=root.GetProperty("source").GetString()!;var target=root.GetProperty("target").GetString()!;
            if(string.IsNullOrWhiteSpace(id)||id.Length>80||id.Any(c=>c<32||c>126)||string.IsNullOrWhiteSpace(text)||!TranslationService.LanguagePair(source,target)) throw new JsonException();
            if(text.EnumerateRunes().Count()>1800) {await Error(413,"request_too_large","请求过大。");return;}
            if(!await active.WaitAsync(0,timeout.Token)) {await Error(409,"busy","上一段仍在翻译。");return;}
            try {var value=await translate(text,source,target,timeout.Token);await response.WriteAsJsonAsync(new {id,translation=value},timeout.Token);}finally{active.Release();}
        } catch(OperationCanceledException) {if(!context.RequestAborted.IsCancellationRequested) await Error(504,"translation_timeout","本段翻译已停止。");}
        catch(BadHttpRequestException e) {await Error(e.StatusCode,"request_too_large","请求无效或过大。");}
        catch(JsonException) {await Error(400,"bad_request","请求格式无效。");}
        catch(TranslationException) {await Error(502,"translation_failed","本机翻译未完成。请检查配置。");}
        catch(ConfigurationException) {await Error(503,"provider_unavailable","请先配置翻译后端。");}
        catch(Exception) {await Error(502,"translation_failed","本机翻译未完成。");}
    }
    public async ValueTask DisposeAsync() {lifetime.Cancel();if(app is not null){using var shutdown=new CancellationTokenSource(TimeSpan.FromSeconds(5));try{await app.StopAsync(shutdown.Token);}catch(OperationCanceledException){}await app.DisposeAsync();}lifetime.Dispose();active.Dispose();}
}
