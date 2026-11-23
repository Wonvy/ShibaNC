$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$win7TargetDir = Join-Path $repoRoot "target\win7"
$yyDir = Join-Path $repoRoot "target\yy-thunks"
$yyObj = Join-Path $yyDir "x64\YY_Thunks_for_Win7.obj"

if (-not (Test-Path $yyObj)) {
    Write-Host "==> Downloading YY-Thunks v1.2.3 for Windows 7 SP1 x64..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path $yyDir | Out-Null
    $zipPath = Join-Path $yyDir "YY-Thunks-Objs.zip"
    Invoke-WebRequest -Uri "https://github.com/Chuyu-Team/YY-Thunks/releases/download/v1.2.3/YY-Thunks-Objs.zip" -OutFile $zipPath
    Expand-Archive -Force -Path $zipPath -DestinationPath $yyDir
    if (Test-Path (Join-Path $yyDir "objs\x64\YY_Thunks_for_Win7.obj")) {
        New-Item -ItemType Directory -Force -Path (Join-Path $yyDir "x64") | Out-Null
        Copy-Item -Force (Join-Path $yyDir "objs\x64\YY_Thunks_for_Win7.obj") $yyObj
    }
}

$env:SHIBANC_WIN7 = "1"
$env:SHIBANC_YY_THUNKS_OBJ = (Resolve-Path $yyObj).Path
$env:CARGO_TARGET_DIR = $win7TargetDir
$env:RUSTFLAGS = "-C target-feature=+crt-static"

Write-Host "==> Building Win7 3D Thumbnail Shell Extension & CLI..." -ForegroundColor Cyan
Push-Location $repoRoot
try {
    cargo build --release --features win7 -p shibanc-thumb-win -p shibanc-cli
} finally {
    Pop-Location
}

function Redirect-CombaseToWin7Ole32([string]$pePath) {
    node -e '
      const fs = require("fs");
      const p = process.argv[1];
      const b = fs.readFileSync(p);
      const peOff = b.readUInt32LE(0x3c);
      const numSec = b.readUInt16LE(peOff + 6);
      const optSize = b.readUInt16LE(peOff + 20);
      const optOff = peOff + 24;
      const impRva = b.readUInt32LE(optOff + 112 + 8);
      const secOff = optOff + optSize;
      const secs = [];
      for (let i = 0; i < numSec; i++) {
        const o = secOff + i * 40;
        secs.push({ va: b.readUInt32LE(o + 12), vs: b.readUInt32LE(o + 8), rawOff: b.readUInt32LE(o + 20), rawSize: b.readUInt32LE(o + 16) });
      }
      const rva2off = (rva) => {
        for (const s of secs) if (rva >= s.va && rva < s.va + Math.max(s.vs, s.rawSize)) return s.rawOff + (rva - s.va);
        return -1;
      };
      let cur = rva2off(impRva), patched = 0;
      while (cur >= 0 && cur + 20 <= b.length) {
        const nameRva = b.readUInt32LE(cur + 12);
        if (!nameRva) break;
        const noff = rva2off(nameRva);
        let end = noff;
        while (b[end]) end++;
        const dll = b.slice(noff, end).toString("ascii");
        if (dll.toLowerCase() === "combase.dll") {
          b.fill(0, noff, end + 1);
          b.write("ole32.dll", noff, "ascii");
          patched++;
        }
        cur += 20;
      }
      if (patched > 0) {
        fs.writeFileSync(p, b);
        console.log(`    Redirected combase.dll -> ole32.dll in ${p}`);
      }
    ' $pePath
}

Redirect-CombaseToWin7Ole32 (Join-Path $win7TargetDir "release\shibanc_thumb_win.dll")
Redirect-CombaseToWin7Ole32 (Join-Path $win7TargetDir "release\shibanc-cli.exe")

$dllAbs = (Resolve-Path (Join-Path $win7TargetDir "release\shibanc_thumb_win.dll")).Path.Replace("\", "/")
$tauriOverride = @{
    bundle = @{
        resources = @{
            $dllAbs = "shibanc_thumb_win.dll"
        }
        windows = @{
            webviewInstallMode = @{
                type = "downloadBootstrapper"
                silent = $false
            }
        }
    }
} | ConvertTo-Json -Depth 6 -Compress

Write-Host "==> Building ShibaNC Windows 7 Edition NSIS Installer..." -ForegroundColor Cyan
Push-Location (Join-Path $repoRoot "app")
try {
    # Build release binary first, redirect combase.dll -> ole32.dll on both exe & dll, then bundle NSIS installer
    npx tauri build --no-bundle --features win7 --config $tauriOverride
    Redirect-CombaseToWin7Ole32 (Join-Path $win7TargetDir "release\shibanc-app.exe")
    Redirect-CombaseToWin7Ole32 (Join-Path $win7TargetDir "release\shibanc_thumb_win.dll")
    npx tauri bundle --bundles nsis --features win7 --config $tauriOverride
} finally {
    Pop-Location
}

$ver = (Get-Content (Join-Path $repoRoot "app\package.json") | ConvertFrom-Json).version
$builtSetup = Join-Path $win7TargetDir "release\bundle\nsis\ShibaNC_${ver}_x64-setup.exe"
$win7Setup = Join-Path $win7TargetDir "ShibaNC_${ver}_x64-win7-setup.exe"
Copy-Item -Force $builtSetup $win7Setup

# Also package a zero-install Portable Win7 ZIP for air-gapped CNC shop-floor PCs
$stageDir = Join-Path $win7TargetDir "portable-stage\ShibaNC-Win7-x64"
if (Test-Path $stageDir) { Remove-Item -Recurse -Force $stageDir }
New-Item -ItemType Directory -Force -Path $stageDir | Out-Null

Copy-Item -Force (Join-Path $win7TargetDir "release\shibanc-app.exe") (Join-Path $stageDir "ShibaNC.exe")
Copy-Item -Force (Join-Path $win7TargetDir "release\shibanc_thumb_win.dll") (Join-Path $stageDir "shibanc_thumb_win.dll")
Copy-Item -Force (Join-Path $win7TargetDir "release\shibanc-cli.exe") (Join-Path $stageDir "shibanc-cli.exe")

$win7Note = @"
ShibaNC v$ver — Windows 7 SP1 (64-bit) Dedicated Edition
=========================================================

1. System Requirements:
   - Windows 7 SP1 x64 (with KB2533623 / KB3063858 security updates)
   - Microsoft Edge WebView2 Runtime v109.0.1518.140 (last official Win7 release)

2. Rendering Engine:
   - Automatically uses ShibaNC's WebGL 2.0 (DirectX 11 ANGLE / SwiftShader) 3D Studio Engine
     on Windows 7 WebView2 109, and upgrades to WebGPU automatically on Windows 10/11.

3. Offline CNC Shop-Floor PCs:
   - If the PC has internet, running ShibaNC_${ver}_x64-win7-setup.exe will prompt to install
     WebView2 109 automatically if missing.
   - For air-gapped (offline) Win7 PCs without Edge/WebView2 109 installed, install Microsoft's
     fixed WebView2 v109.0.1518.140 x64 offline installer once, then run ShibaNC.exe directly.
"@
Set-Content -Path (Join-Path $stageDir "README-WIN7.txt") -Value $win7Note -Encoding UTF8

$portableZip = Join-Path $win7TargetDir "ShibaNC_${ver}_x64-win7-portable.zip"
if (Test-Path $portableZip) { Remove-Item -Force $portableZip }
Compress-Archive -Path $stageDir -DestinationPath $portableZip

Write-Host "==> Win7 artifacts ready:" -ForegroundColor Green
Write-Host "    Installer : $win7Setup"
Write-Host "    Portable  : $portableZip"
