param(
    [switch]$SkipTests,
    [string]$ExpectedTag = ''
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$nativeManifest = Join-Path $PSScriptRoot 'Cargo.toml'
$tauriConfPath = Join-Path $PSScriptRoot 'app/tauri.conf.json'
$winManifestPath = Join-Path $PSScriptRoot 'app/windows.manifest'
$uiPkgPath = Join-Path $PSScriptRoot 'ui/package.json'
$target = Join-Path $projectRoot 'build/rust-target'

$cargoText = Get-Content -LiteralPath $nativeManifest -Raw
if ($cargoText -notmatch '(?m)^version\s*=\s*"(\d+\.\d+\.\d+)"') {
    throw 'Unable to parse workspace version from native/Cargo.toml'
}
$version = $Matches[1]

if ($ExpectedTag -and $ExpectedTag -ne "v$version") {
    throw "Release tag '$ExpectedTag' does not match Cargo workspace version 'v$version'"
}

$tauriConf = Get-Content -LiteralPath $tauriConfPath -Raw | ConvertFrom-Json
if ($tauriConf.version -ne $version) {
    throw "tauri.conf.json version '$($tauriConf.version)' != '$version'"
}
if ($tauriConf.app.windows[0].title -ne "O+ Studio $version") {
    throw "tauri.conf.json window title '$($tauriConf.app.windows[0].title)' != 'O+ Studio $version'"
}

$uiPkg = Get-Content -LiteralPath $uiPkgPath -Raw | ConvertFrom-Json
if ($uiPkg.version -ne $version) {
    throw "native/ui/package.json version '$($uiPkg.version)' != '$version'"
}

$winManifest = Get-Content -LiteralPath $winManifestPath -Raw
if ($winManifest -notmatch [regex]::Escape("version=`"$version.0`"")) {
    throw "windows.manifest assemblyIdentity version does not match '$version.0'"
}

$release = Join-Path $projectRoot "releases/$version/OPlusStudio"
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
    $exeOut = Join-Path $release 'OPlusStudio.Native.exe'
    Copy-Item -LiteralPath (Join-Path $target 'release/oplus-studio.exe') -Destination $exeOut -Force
    Copy-Item -LiteralPath (Join-Path $projectRoot 'LICENSE'), (Join-Path $projectRoot 'NOTICE.md') -Destination $release -Force
    Copy-Item -LiteralPath (Join-Path $projectRoot 'docs/native-user-guide.md') -Destination (Join-Path $release 'README.md') -Force

    $verInfo = (Get-Item -LiteralPath $exeOut).VersionInfo
    if (-not $verInfo.ProductVersion.StartsWith($version) -or -not $verInfo.FileVersion.StartsWith($version)) {
        throw "Built executable version mismatch: ProductVersion='$($verInfo.ProductVersion)', FileVersion='$($verInfo.FileVersion)', expected '$version'"
    }

    Write-Output $release
} finally {
    Pop-Location
}
