[CmdletBinding()]
param(
    [string]$CacheRoot = (Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'AskGPTReader\PDFLayout'),
    [string]$IntegrationDirectory = (Join-Path $PSScriptRoot '..\..\Integrations\PDFLayout'),
    [switch]$SkipAssets
)

Set-StrictMode -Version 3
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$UvVersion = '0.12.23'
$UvSha256 = '75d05de6762778c31ee183398de7dd15093fad0ed90b1f236d8205ea5ec00c90'
$UvUrl = "https://releases.astral.sh/github/uv/releases/download/$UvVersion/uv-x86_64-pc-windows-msvc.zip"
# Official checksum: the same URL with '.sha256' appended, verified 2026-10-22.
$PythonVersion = '3.12.15'
$CurrentUser = [Security.Principal.WindowsIdentity]::GetCurrent().User

function Assert-NoReparse([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'unsafe_reparse_point' }
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
}

function Assert-PrivateItem([string]$Path) {
    Assert-NoReparse $Path
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
    Assert-NoReparse $Path
    $item = Get-Item -LiteralPath $Path -Force
    $item
    if ($item.PSIsContainer) {
        foreach ($child in @(Get-ChildItem -LiteralPath $Path -Force)) { Get-PlainTree $child.FullName }
    }
}

function Assert-PrivateTree([string]$Path) {
    foreach ($item in @(Get-PlainTree $Path)) { Assert-PrivateItem $item.FullName }
}

# Only call for entries created by this invocation inside an already private tree.
function Protect-NewItems([string]$Path, [hashtable]$Existing) {
    foreach ($item in @(Get-PlainTree $Path)) {
        if ($Existing.ContainsKey($item.FullName)) { continue }
        if ($item.PSIsContainer) { $security = [Security.AccessControl.DirectorySecurity]::new(); $inheritance = 'ContainerInherit,ObjectInherit' }
        else { $security = [Security.AccessControl.FileSecurity]::new(); $inheritance = 'None' }
        $security.SetOwner($CurrentUser)
        $security.SetAccessRuleProtection($true, $false)
        foreach ($sid in @($CurrentUser.Value, 'S-1-5-18', 'S-1-5-32-544')) {
            $trustee = [Security.Principal.SecurityIdentifier]::new($sid)
            $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($trustee, 'FullControl', $inheritance, 'None', 'Allow'))
        }
        Set-Acl -LiteralPath $item.FullName -AclObject $security
    }
    Assert-PrivateTree $Path
}

function Protect-PrivateDirectory([string]$Path) {
    Assert-NoReparse $Path
    if (-not (Test-Path -LiteralPath $Path)) {
        $security = [Security.AccessControl.DirectorySecurity]::new()
        $security.SetOwner($CurrentUser)
        $security.SetAccessRuleProtection($true, $false)
        foreach ($sid in @($CurrentUser.Value, 'S-1-5-18', 'S-1-5-32-544')) {
            $trustee = [Security.Principal.SecurityIdentifier]::new($sid)
            $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($trustee, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
        }
        if ($PSVersionTable.PSEdition -eq 'Core') {
            [void][IO.FileSystemAclExtensions]::CreateDirectory($security, $Path)
        } else {
            [void][IO.Directory]::CreateDirectory($Path, $security)
        }
    } else { Assert-PrivateItem $Path }
    Assert-NoReparse $Path
    $item = Get-Item -LiteralPath $Path -Force
    if (-not $item.PSIsContainer) { throw 'unsafe_cache_directory' }
    $acl = Get-Acl -LiteralPath $Path
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $CurrentUser.Value) { throw 'unsafe_file_owner' }
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
    foreach ($sid in @($CurrentUser.Value, 'S-1-5-18', 'S-1-5-32-544')) {
        $trustee = [Security.Principal.SecurityIdentifier]::new($sid)
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($trustee, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Invoke-Uv([string[]]$Arguments) {
    & $script:Uv @Arguments
    if ($LASTEXITCODE -ne 0) { throw "PDF component preparation failed: uv exit $LASTEXITCODE" }
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess) {
    throw 'PDF components require 64-bit Windows PowerShell or PowerShell on Windows x64.'
}
$CacheRoot = [IO.Path]::GetFullPath($CacheRoot)
$IntegrationDirectory = [IO.Path]::GetFullPath($IntegrationDirectory)
$requirements = Join-Path $IntegrationDirectory 'requirements.windows.lock'
$assetsScript = Join-Path $IntegrationDirectory 'prepare-assets.py'
if (-not (Test-Path -LiteralPath $requirements -PathType Leaf) -or -not (Test-Path -LiteralPath $assetsScript -PathType Leaf)) {
    throw 'Bundled PDF integration is incomplete.'
}
Protect-PrivateDirectory $CacheRoot
$tools = Join-Path $CacheRoot 'Tools'
Protect-PrivateDirectory $tools
Assert-PrivateTree $tools
$runtime = Join-Path $CacheRoot 'runtime'
$python = Join-Path $runtime 'Scripts\python.exe'
$managedPython = Join-Path $tools 'python'
$existingPython = @{}
foreach ($tree in @($runtime, $managedPython)) {
    Assert-NoReparse $tree
    if (Test-Path -LiteralPath $tree) {
        Assert-PrivateTree $tree
        foreach ($item in @(Get-PlainTree $tree)) { $existingPython[$item.FullName] = $true }
    }
}
if ((Test-Path -LiteralPath $runtime) -and -not (Test-Path -LiteralPath $python -PathType Leaf)) { throw 'Existing PDF runtime is incomplete; use a new cache directory.' }
$lockPath = Join-Path $CacheRoot '.install-lock'
Assert-NoReparse $lockPath
$installationLock = $null
$temporary = $null
$savedEnvironment = @{}
try {
    try { $installationLock = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None') }
    catch { throw 'Another PDF preparation is running, or the installation lock is unsafe. Close it and retry.' }
    $temporary = Join-Path $CacheRoot ('.install-' + [Guid]::NewGuid().ToString('N'))
    Protect-PrivateDirectory $temporary
    foreach ($name in @('UV_PYTHON_INSTALL_DIR', 'UV_CACHE_DIR', 'UV_LINK_MODE')) {
        $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    }
    $env:UV_PYTHON_INSTALL_DIR = $managedPython
    $env:UV_CACHE_DIR = Join-Path $temporary 'uv-cache'
    $env:UV_LINK_MODE = 'copy'
    Assert-NoReparse $env:UV_PYTHON_INSTALL_DIR
    $archive = Join-Path $tools "uv-$UvVersion-windows-x64.zip"
    Assert-NoReparse $archive
    if (Test-Path -LiteralPath $archive) { Assert-PrivateItem $archive }
    if ((Test-Path -LiteralPath $archive) -and (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $UvSha256) {
        throw 'Cached uv ZIP checksum mismatch. The archive has not been executed.'
    }
    if (-not (Test-Path -LiteralPath $archive)) {
        Write-Output "Downloading verified PDF tool uv $UvVersion..."
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $download = Join-Path $temporary 'uv.zip'
        Invoke-WebRequest -Uri $UvUrl -OutFile $download -UseBasicParsing -TimeoutSec 600
        if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant() -ne $UvSha256) {
            throw 'uv ZIP checksum mismatch. Downloaded content has not been executed.'
        }
        Move-Item -LiteralPath $download -Destination $archive
        Protect-NewItems $archive @{}
    }
    $unpacked = Join-Path $temporary 'uv'
    Expand-Archive -LiteralPath $archive -DestinationPath $unpacked
    $downloadedUv = Join-Path $unpacked 'uv.exe'
    Assert-NoReparse $downloadedUv
    if (-not (Test-Path -LiteralPath $downloadedUv -PathType Leaf)) { throw 'Official uv ZIP is incomplete.' }
    Protect-NewItems $unpacked @{}
    $script:Uv = Join-Path $tools 'uv.exe'
    Assert-NoReparse $script:Uv
    $uvExisted = Test-Path -LiteralPath $script:Uv
    if ($uvExisted) { Assert-PrivateItem $script:Uv }
    Copy-Item -LiteralPath $downloadedUv -Destination $script:Uv -Force
    if (-not $uvExisted) {
        # The source is a hash-verified official executable; secure its new copy.
        Protect-NewItems $script:Uv @{}
    }
    Assert-PrivateItem $script:Uv
    $version = & $script:Uv --version
    if ($LASTEXITCODE -ne 0 -or $version -notmatch ('^uv ' + [regex]::Escape($UvVersion) + '( |$)')) { throw 'uv version mismatch.' }
    Write-Output "Preparing independent Python $PythonVersion..."
    Invoke-Uv @('python', 'install', '--install-dir', $env:UV_PYTHON_INSTALL_DIR, '--no-bin', '--no-config', $PythonVersion)
    Protect-NewItems $managedPython $existingPython
    if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
        Invoke-Uv @('venv', '--python', $PythonVersion, '--managed-python', '--no-python-downloads', '--no-config', $runtime)
        Protect-NewItems $runtime $existingPython
    }
    Assert-PrivateTree $runtime
    $actualPython = & $python -I -B -c 'import platform; print(platform.python_version())'
    if ($LASTEXITCODE -ne 0 -or $actualPython -ne $PythonVersion) { throw 'Existing PDF runtime has a different Python version.' }
    $ready = Join-Path $CacheRoot 'assets-ready.json'
    Assert-NoReparse $ready
    if (Test-Path -LiteralPath $ready) { Remove-Item -LiteralPath $ready }
    Write-Output 'Installing locked binary PDF dependencies with per-package hashes...'
    Invoke-Uv @('pip', 'install', '--python', $python, '--only-binary', ':all:', '--require-hashes', '--no-python-downloads', '--no-config', '-r', $requirements)
    Protect-NewItems $managedPython $existingPython
    Protect-NewItems $runtime $existingPython
    if ($SkipAssets) {
        Write-Output 'PDF dependencies installed. Assets were skipped; PDF components are not ready.'
    } else {
        & $python -B $assetsScript --cache-root $CacheRoot
        if ($LASTEXITCODE -ne 0) { throw "PDF assets failed: Python exit $LASTEXITCODE" }
        Assert-NoReparse $ready
        if (-not (Test-Path -LiteralPath $ready -PathType Leaf)) { throw 'PDF asset completion record is missing.' }
        $record = Get-Content -LiteralPath $ready -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($record.babeldoc -ne '0.6.4' -or @($record.files).Count -eq 0 -or $record.bytes -le 0) { throw 'PDF asset completion record is invalid.' }
        Write-Output 'PDF components ready. Return to Ask for GPT to use layout-preserving translation.'
    }
} finally {
    foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
    if ($temporary -and (Test-Path -LiteralPath $temporary)) {
        Assert-NoReparse $temporary
        Remove-Item -LiteralPath $temporary -Recurse -Force
    }
    if ($installationLock) { $installationLock.Dispose() }
}
