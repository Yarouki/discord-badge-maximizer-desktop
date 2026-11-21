$ErrorActionPreference = 'Stop'
$scripts = $PSScriptRoot
$buildDir = Join-Path $scripts '.nuitka-build'
$outDir = Join-Path (Split-Path $scripts -Parent) 'app\resources-backend'

$version = (Get-Content (Join-Path (Split-Path $scripts -Parent) 'app\package.json') -Raw | ConvertFrom-Json).version
$bridgeModules = @(Get-ChildItem (Join-Path $scripts 'bridge') -Filter '*.py' | Sort-Object Name -Culture '' | ForEach-Object { "bridge/$($_.Name)" })
if ($bridgeModules.Count -eq 0) { throw "No Python files in $(Join-Path $scripts 'bridge')" }
$sources = @('bridge_adapter.py', 'games.py', 'stream.py') + $bridgeModules
$sourceText = ($sources | ForEach-Object { "${_}:" + (Get-FileHash (Join-Path $scripts $_) -Algorithm SHA256).Hash }) -join ';'
$sourceHash = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::UTF8.GetBytes($sourceText))).Replace('-', '').Substring(0, 12).ToLowerInvariant()

New-Item -ItemType Directory -Force $outDir | Out-Null

$nuitkaArgs = @(
    '-m', 'nuitka',
    '--onefile',
    '--assume-yes-for-downloads',
    '--msvc=latest',
    '--include-package=dave',
    '--include-package=cryptography',
    '--include-module=games',
    '--include-module=stream',
    '--include-package=bridge',
    "--onefile-tempdir-spec={CACHE_DIR}/BadgeMaximizer/backend-$version-$sourceHash",
    '--product-name=Badge Maximizer',
    '--file-description=Badge Maximizer backend',
    "--product-version=$version",
    "--file-version=$version",
    "--output-dir=$buildDir",
    '--output-filename=badge-backend.exe',
    '--remove-output',
    (Join-Path $scripts 'bridge_adapter.py')
)

Push-Location $scripts
try {
    & py -3.11 @nuitkaArgs
    if ($LASTEXITCODE -ne 0) { throw "Nuitka failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

$exe = Join-Path $buildDir 'badge-backend.exe'
if (-not (Test-Path $exe)) { throw "Nuitka finished but $exe is missing" }
Copy-Item $exe (Join-Path $outDir 'badge-backend.exe') -Force
$size = [math]::Round((Get-Item (Join-Path $outDir 'badge-backend.exe')).Length / 1MB, 1)
Write-Host "Built $(Join-Path $outDir 'badge-backend.exe') ($size MB)"
