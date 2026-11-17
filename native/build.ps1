param([switch]$SkipTests)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$nativeManifest = Join-Path $PSScriptRoot 'Cargo.toml'
$target = Join-Path $projectRoot 'build/rust-target'
$release = Join-Path $projectRoot 'releases/0.6.0/OPlusStudio'
Push-Location $projectRoot
try {
    & npm.cmd --prefix native/ui ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
    if (-not $SkipTests) {
        & npm.cmd --prefix native/ui run test:web
        if ($LASTEXITCODE -ne 0) { throw 'Web driver tests failed' }
    }
    & npm.cmd --prefix native/ui run build
    if ($LASTEXITCODE -ne 0) { throw 'UI build failed' }
    if (-not $SkipTests) {
        & cargo test --locked --manifest-path $nativeManifest --workspace --target-dir $target
        if ($LASTEXITCODE -ne 0) { throw 'Native tests failed' }
    }
    & cargo build --locked --manifest-path $nativeManifest -p oplus-studio --release --target-dir $target
    if ($LASTEXITCODE -ne 0) { throw 'Rust build failed' }
    New-Item -ItemType Directory -Path $release -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $target 'release/oplus-studio.exe') -Destination (Join-Path $release 'OPlusStudio.Native.exe')
    Copy-Item -LiteralPath (Join-Path $projectRoot 'LICENSE'),(Join-Path $projectRoot 'NOTICE.md') -Destination $release
    Copy-Item -LiteralPath (Join-Path $projectRoot 'docs/native-user-guide.md') -Destination (Join-Path $release 'README.md')
    Write-Output $release
} finally { Pop-Location }
