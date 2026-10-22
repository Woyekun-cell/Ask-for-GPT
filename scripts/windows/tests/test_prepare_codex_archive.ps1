Set-StrictMode -Version 3
$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot '..\prepare-codex.ps1'
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw ($parseErrors | Out-String) }
$definition = $ast.Find({ param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Expand-VerifiedCodexArchive'
}, $false)
if (-not $definition) { throw 'Codex archive extraction function is missing.' }
Invoke-Expression $definition.Extent.Text

# Build Unicode without source-file encoding assumptions in Windows PowerShell 5.1.
$unicode = [string][char]0x4E2D + [char]0x6587
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('AskGPT tar ' + $unicode + ' ' + [Guid]::NewGuid().ToString('N'))
$source = Join-Path $temporary ('source ' + $unicode)
$destination = Join-Path $temporary ('extract ' + $unicode)
[void][IO.Directory]::CreateDirectory($source)
[void][IO.Directory]::CreateDirectory($destination)
try {
    Write-Output ('Archive test host: PowerShell ' + $PSVersionTable.PSVersion + '; console input preamble bytes: ' + [Console]::InputEncoding.GetPreamble().Length)
    [IO.File]::WriteAllText((Join-Path $source 'payload.txt'), 'Unicode archive path roundtrip')
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = Join-Path ([Environment]::SystemDirectory) 'tar.exe'
    $start.WorkingDirectory = $source
    $start.Arguments = '-czf fixture.tgz payload.txt'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $process = [Diagnostics.Process]::Start($start)
    try {
        if (-not $process.WaitForExit(30000)) { $process.Kill(); [void]$process.WaitForExit(5000); throw 'Fixture tar creation timed out.' }
        if ($process.ExitCode -ne 0) { throw 'Fixture tar creation failed.' }
    } finally { $process.Dispose() }
    $archive = Join-Path $temporary ('codex archive ' + $unicode + '.tgz')
    Move-Item -LiteralPath (Join-Path $source 'fixture.tgz') -Destination $archive
    $header = [IO.File]::ReadAllBytes($archive)
    if ($header.Length -lt 2 -or $header[0] -ne 0x1F -or $header[1] -ne 0x8B) { throw 'Fixture is not a gzip archive before extraction.' }
    Expand-VerifiedCodexArchive $archive $destination
    if ([IO.File]::ReadAllText((Join-Path $destination 'payload.txt')) -ne 'Unicode archive path roundtrip') { throw 'Unicode archive extraction differs.' }
    if (@(Get-ChildItem -LiteralPath $destination -Filter 'askgpt-archive-*.tgz').Count -ne 0) { throw 'Successful extraction leaked its temporary archive copy.' }

    $invalid = Join-Path $temporary ('invalid ' + $unicode + '.tgz')
    [IO.File]::WriteAllText($invalid, 'This is not a gzip or tar archive.')
    $failure = $null
    try { Expand-VerifiedCodexArchive $invalid $destination } catch { $failure = $_.Exception.Message }
    if (-not $failure -or $failure -notmatch 'tar exit [1-9]') { throw "Invalid archive was not rejected: $failure" }
    if ($failure.Length -gt 17000) { throw 'System tar output exceeded the diagnostic bound.' }
    if (@(Get-ChildItem -LiteralPath $destination -Filter 'askgpt-archive-*.tgz').Count -ne 0) { throw 'Failed extraction leaked its temporary archive copy.' }
    Write-Output 'PASS Codex archive Unicode roundtrip, invalid-archive rejection and temporary-copy cleanup.'
} finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
}
