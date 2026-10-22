param([string]$OutputDirectory = '', [switch]$SkipTests)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
if ($env:OS -ne 'Windows_NT') { throw 'Build this package on Windows x64.' }
if (!$OutputDirectory) { $OutputDirectory = Join-Path $root 'dist\windows-preview' }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Use a new output directory; refusing to overwrite previous artifacts.' }
[IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
$work = Join-Path $root ('work\windows-build-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($work) | Out-Null
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_NOLOGO = '1'
$env:DOTNET_CLI_HOME = Join-Path $work 'dotnet-home'
$pin = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'toolchain.json') -Raw | ConvertFrom-Json
$sdk = (& dotnet --version).Trim()
if ($LASTEXITCODE -ne 0 -or $sdk -ne $pin.dotnetSdk) { throw ('Expected .NET SDK ' + $pin.dotnetSdk + ', got ' + $sdk) }
function Invoke-Checked([string]$File, [string[]]$Arguments) {
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw ($File + ' failed with exit ' + $LASTEXITCODE) }
}
$validation = [ordered]@{
    schemaVersion = 1; version = '0.1.0-preview.1'; sourceCommit = $env:GITHUB_SHA
    checkedAtUTC = [DateTime]::UtcNow.ToString('o'); os = [Environment]::OSVersion.VersionString
    dotnetSdk = $sdk; fakeProvidersOnly = $true; desktopUserAcceptance = 'not performed'
    windows10Desktop = 'not tested'; windows11Desktop = 'not tested'; checks = @()
}
Push-Location $root
try {
    if (!$SkipTests) {
        foreach ($hostCommand in @('pwsh','powershell.exe')) {
            Invoke-Checked $hostCommand @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','scripts/windows/tests/test_prepare_codex_archive.ps1')
        }
        $validation.checks += 'PowerShell 7 and Windows PowerShell 5.1 Unicode tar roundtrip and malformed archive rejection'
        Invoke-Checked dotnet @('run','--project','Platforms/Windows/AskGPT.Windows.Core.Tests','--configuration','Release','--','--smoke-test')
        $validation.checks += 'Core console tests (fake providers; auth, config, cache and cancellation)'
        Invoke-Checked dotnet @('run','--project','Platforms/Windows/AskGPT.Windows/PolicyTests','--configuration','Release')
        $validation.checks += 'Selection and clipboard policy checks'
        Invoke-Checked python @('-m','unittest','discover','-s','scripts/windows/tests','-v')
        $validation.checks += 'Windows package validation tests'
    }
    $published = Join-Path $work 'published'
    foreach ($project in @('AskGPT.Windows','AskGPT.Translate')) {
        Invoke-Checked dotnet @('publish', ('Platforms/Windows/' + $project + '/' + $project + '.csproj'), '--configuration','Release','--runtime','win-x64','--self-contained','true','--output',$published,'-p:ContinuousIntegrationBuild=true','-p:NuGetAudit=true','-warnaserror:NU1901,NU1902,NU1903,NU1904')
    }
    $validation.checks += 'Self-contained win-x64 WPF host and JSONL helper publish'
    $bundle = Join-Path $work 'Ask-for-GPT-Windows'
    $uninstall = Join-Path $work 'uninstall-files.nsh'
    Invoke-Checked python @('scripts/windows/package.py','--published',$published,'--output',$bundle,'--nsis-uninstall',$uninstall)
    $smokeReport = Join-Path $work 'smoke report 中文.json'
    $smoke = Start-Process -FilePath (Join-Path $bundle 'AskGPT.Windows.exe') -ArgumentList @('--smoke-test', '--smoke-report', ('"' + $smokeReport + '"')) -PassThru
    if (!$smoke.WaitForExit(45000)) { $smoke.Kill($true); throw 'WPF startup/shutdown exceeded 45 seconds.' }
    if ($smoke.ExitCode -ne 0 -or !(Test-Path -LiteralPath $smokeReport) -or !(Get-Content -LiteralPath $smokeReport -Raw | ConvertFrom-Json).passed) { throw ('WPF startup/shutdown smoke failed: ' + $smoke.ExitCode) }
    $validation.checks += 'WPF automated startup/tray/window/shutdown in an isolated data directory'
    $validation.wpfSmoke = Get-Content -LiteralPath $smokeReport -Raw | ConvertFrom-Json
    $evidence = Join-Path $OutputDirectory 'windows-renderer-evidence'
    [IO.Directory]::CreateDirectory($evidence) | Out-Null
    Copy-Item -LiteralPath $smokeReport -Destination $evidence
    Get-ChildItem -LiteralPath $work -Filter 'smoke report 中文-*.png' | Copy-Item -Destination $evidence
    # Silent install/uninstall below is a runner check, not human desktop acceptance.
    $makensis = Join-Path ${env:ProgramFiles(x86)} 'NSIS\makensis.exe'
    if (!(Test-Path -LiteralPath $makensis)) { throw 'Install pinned NSIS 3.11 before packaging.' }
    $nsisVersion = (& $makensis /VERSION).Trim()
    if ($nsisVersion -notmatch '^v3\.11(?:\.|$)') { throw ('Expected NSIS 3.11, got ' + $nsisVersion) }
    $validation.nsis = $nsisVersion
    $installer = Join-Path $OutputDirectory 'Ask-for-GPT-0.1.0-preview.1-Windows-x64-Setup.exe'
    Invoke-Checked $makensis @('/V2','/INPUTCHARSET','UTF8', ('/DBUNDLE_DIR=' + $bundle), ('/DOUTPUT_FILE=' + $installer), ('/DUNINSTALL_INCLUDE=' + $uninstall), (Join-Path $PSScriptRoot 'installer.nsi'))
    $installed = Join-Path $work 'install smoke 中文'
    $install = Start-Process -FilePath $installer -ArgumentList @('/S', ('/D=' + $installed)) -Wait -PassThru
    if ($install.ExitCode -ne 0 -or !(Test-Path -LiteralPath (Join-Path $installed 'AskGPT.Windows.exe'))) { throw 'Silent runner installation failed.' }
    Invoke-Checked python @('scripts/windows/package.py','--check',$installed,'--installed')
    # NSIS owns one additional generated file; verify separately and preserve user-added files.
    $sentinel = Join-Path $installed 'user-file-preserved.txt'
    Set-Content -LiteralPath $sentinel -Value 'keep' -Encoding UTF8
    $uninstallProcess = Start-Process -FilePath (Join-Path $installed 'Uninstall.exe') -ArgumentList @('/S', ('_?=' + $installed)) -Wait -PassThru
    if ($uninstallProcess.ExitCode -ne 0 -or !(Test-Path -LiteralPath $sentinel) -or (Test-Path -LiteralPath (Join-Path $installed 'AskGPT.Windows.exe'))) { throw 'Runner uninstall/preserve check failed.' }
    foreach ($entry in (Get-Content -LiteralPath (Join-Path $bundle 'package-manifest.json') -Raw | ConvertFrom-Json).files) {
        if (Test-Path -LiteralPath (Join-Path $installed $entry.path)) { throw ('Uninstall left a packaged file: ' + $entry.path) }
    }
    $validation.checks += 'NSIS runner silent install, installed file hashes and uninstall preserving unrelated files'
    $zip = Join-Path $OutputDirectory 'Ask-for-GPT-0.1.0-preview.1-Windows-x64-Portable.zip'
    Invoke-Checked python @('scripts/windows/zip-package.py',$bundle,$zip)
    $validation.checks += 'Portable ZIP extraction and every package member hash'
    $external = Join-Path $root 'work/windows-ci-checks.json'
    if (Test-Path -LiteralPath $external) { $validation.externalChecks = Get-Content -LiteralPath $external -Raw | ConvertFrom-Json }
    Copy-Item -LiteralPath (Join-Path $root 'docs/INSTALL.Windows.zh-CN.md') -Destination (Join-Path $OutputDirectory 'INSTALL.Windows.zh-CN.md')
    $validation | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'build-validation.json') -Encoding UTF8
    $hashes = @(Get-ChildItem -LiteralPath $OutputDirectory -File | Sort-Object Name | ForEach-Object { (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + $_.Name })
    [IO.File]::WriteAllLines((Join-Path $OutputDirectory 'SHA256SUMS.txt'), $hashes, (New-Object Text.UTF8Encoding($false)))
    $validation | ConvertTo-Json -Depth 8
} finally { Pop-Location }
