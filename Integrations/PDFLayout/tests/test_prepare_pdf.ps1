Set-StrictMode -Version 3
$ErrorActionPreference = 'Stop'
$script = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\scripts\windows\prepare-pdf.ps1'))
$codexScript = Join-Path ([IO.Path]::GetDirectoryName($script)) 'prepare-codex.ps1'
$tokens = $null; $parseErrors = $null
[void][Management.Automation.Language.Parser]::ParseFile($script, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw ($parseErrors | Out-String) }
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('AskGPT PDF test 中文 ' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($temporary)
$checks = 0
function Set-FixtureOwner([string]$Path) {
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetOwner([Security.Principal.WindowsIdentity]::GetCurrent().User)
    Set-Acl -LiteralPath $Path -AclObject $acl
}
function New-UnsafeRuntime([string]$Root, [switch]$ForeignOwner) {
    $scripts = Join-Path $Root 'runtime\Scripts'
    [void][IO.Directory]::CreateDirectory($scripts)
    $executable = Join-Path $scripts 'python.exe'
    [IO.File]::WriteAllText($executable, 'This must never execute.')
    foreach ($path in @($Root, (Join-Path $Root 'runtime'), $scripts, $executable)) { Set-FixtureOwner $path }
    $acl = Get-Acl -LiteralPath $executable
    if ($ForeignOwner) {
        $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
    } else {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'FullControl', 'Allow'))
    }
    Set-Acl -LiteralPath $executable -AclObject $acl
}
function Must-Reject([string]$Root, [string]$Expected) {
    $failure = $null
    try { & $script -CacheRoot $Root -SkipAssets } catch { $failure = $_.Exception.Message }
    if (-not $failure -or $failure -notmatch $Expected) { throw "Expected $Expected; received $failure" }
    if (Test-Path -LiteralPath (Join-Path $Root 'assets-ready.json')) { throw 'Failed preparation claimed readiness.' }
    $script:checks++
}
function Must-RejectCodex([string]$Root, [string]$Expected) {
    $failure = $null
    try { & $codexScript -ToolsRoot $Root } catch { $failure = $_.Exception.Message }
    if (-not $failure -or $failure -notmatch $Expected) { throw "Expected Codex $Expected; received $failure" }
    $script:checks++
}
try {
    $cache = Join-Path $temporary 'checksum'
    $tools = Join-Path $cache 'Tools'
    [void][IO.Directory]::CreateDirectory($tools)
    Set-FixtureOwner $cache
    Set-FixtureOwner $tools
    [IO.File]::WriteAllText((Join-Path $tools 'uv-0.12.23-windows-x64.zip'), 'This must never execute.')
    Set-FixtureOwner (Join-Path $tools 'uv-0.12.23-windows-x64.zip')
    Must-Reject $cache 'checksum mismatch'
    if (Test-Path -LiteralPath (Join-Path $tools 'uv.exe')) { throw 'Invalid archive was extracted.' }
    if (@(Get-ChildItem -LiteralPath $cache -Filter '.install-*' -Directory).Count -ne 0) { throw 'Temporary installer directory leaked.' }
    $cache = Join-Path $temporary 'locked'
    [void][IO.Directory]::CreateDirectory($cache)
    Set-FixtureOwner $cache
    $lock = [IO.File]::Open((Join-Path $cache '.install-lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    try { Must-Reject $cache 'Another PDF preparation' } finally { $lock.Dispose() }
    $actual = Join-Path $temporary 'actual'
    [void][IO.Directory]::CreateDirectory($actual)
    $junction = Join-Path $temporary 'junction'
    [void](New-Item -ItemType Junction -Path $junction -Target $actual)
    try { Must-Reject $junction 'unsafe_reparse_point' } finally { [IO.Directory]::Delete($junction) }
    $cache = Join-Path $temporary 'writable-runtime'
    New-UnsafeRuntime $cache
    Must-Reject $cache 'unsafe_file_acl'
    $cache = Join-Path $temporary 'foreign-runtime'
    New-UnsafeRuntime $cache -ForeignOwner
    Must-Reject $cache 'unsafe_file_owner'
    foreach ($foreign in @($false, $true)) {
        $tools = Join-Path $temporary ('codex-' + $foreign)
        $target = Join-Path $tools 'codex-0.163.0'
        New-UnsafeRuntime $target -ForeignOwner:$foreign
        Set-FixtureOwner $tools
        if ($foreign) { Must-RejectCodex $tools 'unsafe_file_owner' }
        else { Must-RejectCodex $tools 'unsafe_file_acl' }
    }
    Write-Output "PASS component preparation safeguards: $checks checks (checksum, exclusive lock, junction, PDF/Codex writable and foreign-owner files), plus PowerShell syntax."
} finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
}
