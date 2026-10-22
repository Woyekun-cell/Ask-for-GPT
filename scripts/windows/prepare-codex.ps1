param([string]$ToolsRoot = (Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'AskGPTReader\Tools'))
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$CurrentUser = [Security.Principal.WindowsIdentity]::GetCurrent().User
function Assert-PlainPath([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Component paths must not contain reparse points.' }
        }
        $parent = Split-Path -Parent $cursor
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
}
function Assert-PrivateItem([string]$Path) {
    Assert-PlainPath $Path
    $acl = Get-Acl -LiteralPath $Path
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $CurrentUser.Value) { throw 'unsafe_file_owner' }
    $hasUser = $false
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
            $rule.IdentityReference.Value -notin @($CurrentUser.Value, 'S-1-5-18', 'S-1-5-32-544')) { throw 'unsafe_file_acl' }
        if ($rule.IdentityReference.Value -eq $CurrentUser.Value -and
            -not ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -and
            ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) { $hasUser = $true }
    }
    if (-not $hasUser) { throw 'unsafe_file_acl' }
}
function Get-PlainTree([string]$Path) {
    Assert-PlainPath $Path
    $item = Get-Item -LiteralPath $Path -Force
    $item
    if ($item.PSIsContainer) {
        foreach ($child in @(Get-ChildItem -LiteralPath $Path -Force)) { Get-PlainTree $child.FullName }
    }
}
function Assert-PrivateTree([string]$Path) {
    foreach ($item in @(Get-PlainTree $Path)) { Assert-PrivateItem $item.FullName }
}
# This tree comes only from this invocation's verified archive and bundled notices.
function Protect-NewTree([string]$Path) {
    foreach ($item in @(Get-PlainTree $Path)) {
        if ($item.PSIsContainer) { $security = [Security.AccessControl.DirectorySecurity]::new(); $inheritance = 'ContainerInherit,ObjectInherit' }
        else { $security = [Security.AccessControl.FileSecurity]::new(); $inheritance = 'None' }
        $security.SetOwner($CurrentUser)
        $security.SetAccessRuleProtection($true, $false)
        $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($CurrentUser, 'FullControl', $inheritance, 'None', 'Allow'))
        Set-Acl -LiteralPath $item.FullName -AclObject $security
    }
    Assert-PrivateTree $Path
}
function Protect-Directory([string]$Path) {
    Assert-PlainPath $Path
    if (Test-Path -LiteralPath $Path) { Assert-PrivateItem $Path }
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($CurrentUser)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($CurrentUser, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    if (-not (Test-Path -LiteralPath $Path)) {
        if ($PSVersionTable.PSEdition -eq 'Core') { [void][IO.FileSystemAclExtensions]::CreateDirectory($acl, $Path) }
        else { [void][IO.Directory]::CreateDirectory($Path, $acl) }
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}
$pin = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'toolchain.json') -Raw | ConvertFrom-Json).codex
$ToolsRoot = [IO.Path]::GetFullPath($ToolsRoot)
Protect-Directory $ToolsRoot
$lockPath = Join-Path $ToolsRoot '.codex-install-lock'
Assert-PlainPath $lockPath
try { $installationLock = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None') }
catch { throw 'Another Codex preparation is running, or its installation lock is unsafe.' }
$stage = $null
try {
$target = Join-Path $ToolsRoot ('codex-' + $pin.version)
$marker = Join-Path $target 'askgpt-provenance.json'
if (Test-Path -LiteralPath $target) {
    Assert-PrivateTree $target
    if (!(Test-Path -LiteralPath $marker)) { throw 'Existing Codex directory has no verified manifest; choose a new ToolsRoot.' }
    $existing = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
    if ($existing.archiveSHA512 -ne $pin.sha512) { throw 'Existing Codex version differs from the fixed package.' }
    foreach ($file in $existing.files) {
        $path = Join-Path $target $file.path
        Assert-PlainPath $path
        if (!(Test-Path -LiteralPath $path -PathType Leaf) -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) { throw 'Existing Codex file failed integrity verification.' }
    }
    Write-Output (Join-Path $target $pin.executable)
    exit 0
}
$stage = Join-Path $ToolsRoot ('prepare-' + [Guid]::NewGuid().ToString('N'))
Protect-Directory $stage
    $archive = Join-Path $stage 'codex.tgz'
    Invoke-WebRequest -UseBasicParsing -Uri $pin.archive -OutFile $archive -TimeoutSec 600
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA512).Hash.ToLowerInvariant() -ne $pin.sha512) { throw 'Official Codex package SHA512 mismatch.' }
    $extract = Join-Path $stage 'extract'
    Protect-Directory $extract
    & tar.exe -xzf $archive -C $extract
    if ($LASTEXITCODE -ne 0) { throw 'Unable to extract official Codex package.' }
    $package = Join-Path $extract 'package'
    $exe = Join-Path $package $pin.executable
    if (!(Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Complete Windows Codex payload is missing its executable.' }
    foreach ($notice in @('LICENSE-Codex-Apache-2.0.txt', 'NOTICE-Codex.txt')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot ('..\..\Resources\Distribution\' + $notice)) -Destination (Join-Path $package $notice)
    }
    $files = @(Get-ChildItem -LiteralPath $package -File -Recurse | ForEach-Object {
        Assert-PlainPath $_.FullName
        @{ path = $_.FullName.Substring($package.Length + 1).Replace('\','/'); sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
    })
    @{ version = $pin.version; source = $pin.source; archiveSHA512 = $pin.sha512; files = $files } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $package 'askgpt-provenance.json') -Encoding UTF8
    Protect-NewTree $package
    Move-Item -LiteralPath $package -Destination $target
    Write-Output (Join-Path $target $pin.executable)
    Write-Output 'Codex prepared. Complete sign-in yourself using the installed codex.exe login command; no model requests were sent.'
} finally {
    # Only this invocation's unique staging directory is removed.
    if ($stage -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage -Recurse -Force }
    $installationLock.Dispose()
}
