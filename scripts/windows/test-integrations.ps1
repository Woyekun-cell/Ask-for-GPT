[CmdletBinding()]
param()

Set-StrictMode -Version 3
$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$dependencySource = Join-Path $PSScriptRoot 'browser-test-deps'
$testDirectory = Join-Path $repository 'work\browser-inline-test'
$npmDirectory = Join-Path $repository 'work\windows-integration-npm'

function Assert-NoReparse([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'Integration test paths must not contain reparse points.'
            }
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
}

foreach ($path in @($testDirectory, $npmDirectory)) { Assert-NoReparse $path }
if (Test-Path -LiteralPath $testDirectory) {
    if (-not (Test-Path -LiteralPath $testDirectory -PathType Container)) { throw 'Browser test fixture path is not a directory.' }
    $existingPackage = Join-Path $testDirectory 'package.json'
    if (Test-Path -LiteralPath $existingPackage -PathType Leaf) {
        Assert-NoReparse $existingPackage
        $existing = Get-Content -LiteralPath $existingPackage -Raw -Encoding UTF8 | ConvertFrom-Json
        $properties = @($existing.PSObject.Properties.Name)
        if ('devDependencies' -notin $properties -or 'jsdom' -notin @($existing.devDependencies.PSObject.Properties.Name) -or
            $existing.devDependencies.jsdom -ne '30.1.3' -or
            @($existing.devDependencies.PSObject.Properties).Count -ne 1 -or
            @($properties | Where-Object { $_ -notin @('name', 'version', 'private', 'description', 'devDependencies') }).Count -gt 0) {
            throw 'Existing browser-inline-test directory is not the expected test-only jsdom fixture.'
        }
        if ('name' -in $properties -and $existing.name -ne 'askgpt-browser-integration-test-deps') {
            throw 'Existing browser-inline-test package belongs to another project.'
        }
    } elseif (@(Get-ChildItem -LiteralPath $testDirectory -Force).Count -ne 0) {
        throw 'Refusing to overwrite a nonempty directory without the expected test package.'
    }
}
[void][IO.Directory]::CreateDirectory($testDirectory)
[void][IO.Directory]::CreateDirectory($npmDirectory)
foreach ($path in @($testDirectory, $npmDirectory)) { Assert-NoReparse $path }
foreach ($name in @('package.json', 'package-lock.json')) {
    Assert-NoReparse (Join-Path $testDirectory $name)
    Copy-Item -LiteralPath (Join-Path $dependencySource $name) -Destination (Join-Path $testDirectory $name) -Force
}
# npm also reads a project .npmrc; reject it rather than using user credentials.
if (Test-Path -LiteralPath (Join-Path $testDirectory '.npmrc')) { throw 'The test fixture must not contain a project .npmrc.' }
$userConfig = Join-Path $npmDirectory 'empty-user.npmrc'
$globalConfig = Join-Path $npmDirectory 'empty-global.npmrc'
foreach ($path in @($userConfig, $globalConfig)) {
    Assert-NoReparse $path
    [IO.File]::WriteAllText($path, '')
}
$cache = Join-Path $npmDirectory 'cache'
Assert-NoReparse $cache
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCommand) { $npmCommand = Get-Command npm -ErrorAction Stop }
$savedEnvironment = @{}
foreach ($entry in [Environment]::GetEnvironmentVariables('Process').GetEnumerator()) {
    if ($entry.Key -match '^(?i:npm_|node_auth_token$|node_options$|corepack_npm_)') {
        $savedEnvironment[$entry.Key] = $entry.Value
    }
}
try {
    foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
    Push-Location -LiteralPath $testDirectory
    try {
        & $npmCommand.Source ci --ignore-scripts --no-audit --no-fund --engine-strict --registry=https://registry.npmjs.org/ --cache $cache --userconfig $userConfig --globalconfig $globalConfig
        if ($LASTEXITCODE -ne 0) { throw 'Locked browser integration test dependencies failed to install.' }
    } finally { Pop-Location }
    $zoteroTests = @(Get-ChildItem -LiteralPath (Join-Path $repository 'Integrations\Zotero\tests') -Filter '*tests.cjs' | Sort-Object Name)
    $browserTests = @(Get-ChildItem -LiteralPath (Join-Path $repository 'Integrations\Browser\tests') -Filter '*.test.cjs' | Sort-Object Name)
    if ($zoteroTests.Count -eq 0 -or $browserTests.Count -eq 0) { throw 'Zotero or Browser integration test suites are missing.' }
    $tests = $zoteroTests + $browserTests
    foreach ($test in $tests) {
        Write-Output ('Running ' + $test.Name)
        & node $test.FullName
        if ($LASTEXITCODE -ne 0) { throw ('Integration test failed: ' + $test.Name) }
    }
    Write-Output ('PASS integration suites: ' + $tests.Count)
} finally {
    foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
}
