using System.IO.Compression;
using System.Text.Json;

namespace AskGPT.Windows.Core;

internal sealed class IntegrationExporter(string bundleDirectory,PairingConfiguration pairing) {
    public async Task<string> ExportAsync(string targetDirectory,CancellationToken cancellationToken=default) {
        cancellationToken.ThrowIfCancellationRequested();
        var browserSource=Path.Combine(bundleDirectory,"Integrations","Browser");var zotero=Path.Combine(bundleDirectory,"Integrations","Zotero");
        if(!Directory.Exists(browserSource)||!Directory.Exists(zotero))throw new ConfigurationException("安装包缺少 Chrome 或 Zotero 集成。");
        ProtectedFiles.RejectLinks(browserSource);ProtectedFiles.RejectLinks(zotero);
        // The selected folder may be Desktop or a shared working folder. Only
        // this exclusively created application child may receive private ACLs.
        var target=ProtectedFiles.CreatePrivateSubdirectory(targetDirectory,"AskGPT-Integrations-");
        var browser=Path.Combine(target,"AskGPT-Chrome");
        CopyTree(browserSource,browser,cancellationToken);
        ProtectedFiles.Write(Path.Combine(browser,"connection.local.json"),JsonSerializer.SerializeToUtf8Bytes(pairing,SettingsStore.JsonOptions));
        var xpi=Path.Combine(target,"askgpt-inline-zotero.xpi");
        using(var archive=ZipFile.Open(xpi,ZipArchiveMode.Create)) foreach(var file in Directory.EnumerateFiles(zotero,"*",SearchOption.AllDirectories)) {cancellationToken.ThrowIfCancellationRequested();ProtectedFiles.RejectLinks(file);if(IsExportFile(file))archive.CreateEntryFromFile(file,Path.GetRelativePath(zotero,file).Replace('\\','/'),CompressionLevel.Optimal);}
        await Task.CompletedTask;return target;
    }
    private static bool IsExportFile(string path)=>!path.Contains(Path.DirectorySeparatorChar+"tests"+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase)&&!Path.GetFileName(path).StartsWith('.')&&!Path.GetFileName(path).Equals("connection.local.json",StringComparison.OrdinalIgnoreCase);
    private static void CopyTree(string source,string target,CancellationToken ct) {if(!Directory.Exists(source))throw new ConfigurationException("安装包缺少 Chrome 集成。");ProtectedFiles.EnsureDirectory(target);foreach(var file in Directory.EnumerateFiles(source,"*",SearchOption.AllDirectories)){ct.ThrowIfCancellationRequested();ProtectedFiles.RejectLinks(file);if(!IsExportFile(file))continue;var output=Path.Combine(target,Path.GetRelativePath(source,file));ProtectedFiles.EnsureDirectory(Path.GetDirectoryName(output)!);File.Copy(file,output,false);}}
}
