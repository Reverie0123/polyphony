# Builds Polyphony-Setup-<version>.exe with Inno Setup 6. Needs build\node\node.exe (portable Node 22 x64) and
# build\lang\ChineseSimplified.isl; both are kept out of git. Inno output goes to %LOCALAPPDATA% first because the
# project folder may be synced by OneDrive.
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$stage = Join-Path $root "build\stage"
$nodeExe = Join-Path $root "build\node\node.exe"
if (-not (Test-Path $nodeExe)) { throw "build\node\node.exe missing: download node-v22-win-x64.zip and copy node.exe there" }
if (-not (Test-Path "build\lang\ChineseSimplified.isl")) { throw "build\lang\ChineseSimplified.isl missing" }
if (-not (Test-Path "resources\polyphony.ico")) { & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "make-icon.ps1") }

npm run build --silent
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $stage | Out-Null
Copy-Item package.json $stage
Copy-Item dist $stage\dist -Recurse
Copy-Item web $stage\web -Recurse
New-Item -ItemType Directory -Force $stage\resources | Out-Null
Copy-Item resources\polyphony.ico, resources\icon.png, resources\ocr.ps1 $stage\resources
Copy-Item README.md, README.zh.md, LICENSE, CHANGELOG.md $stage
Copy-Item $nodeExe $stage\node.exe
# package.json has Chinese text; Windows PowerShell 5.1 needs the encoding spelled out.
$version = (Get-Content package.json -Raw -Encoding UTF8 | ConvertFrom-Json).version
@{ kind = "setup"; version = $version; installedAt = (Get-Date).ToString("o") } | ConvertTo-Json -Compress | Set-Content (Join-Path $stage "setup-install.json") -Encoding ASCII
# launch.vbs starts the server without a console window; the server opens the Edge app window itself.
@'
Set sh = CreateObject("WScript.Shell")
dir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
sh.Run """" & dir & "node.exe"" """ & dir & "dist\index.js""", 0, False
'@ | Set-Content (Join-Path $stage "launch.vbs") -Encoding ASCII
"@echo off`r`n""%~dp0node.exe"" ""%~dp0dist\index.js"" %*" | Set-Content (Join-Path $stage "polyphony.cmd") -Encoding ASCII

# Inno reads UTF-8 only with a BOM; Set-Content -Encoding UTF8 writes one, which also keeps the Chinese messages intact.
(Get-Content installer\polyphony.iss -Raw -Encoding UTF8) -replace '#define AppVersion ".*"', "#define AppVersion `"$version`"" | Set-Content installer\polyphony.iss -Encoding UTF8 -NoNewline
$iscc = @("$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe", "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { throw "Inno Setup 6 not found (winget install JRSoftware.InnoSetup --scope user)" }
$tmpOut = Join-Path $env:LOCALAPPDATA "polyphony\installer-out"
New-Item -ItemType Directory -Force $tmpOut | Out-Null
& $iscc /Q "/O$tmpOut" "installer\polyphony.iss"
if ($LASTEXITCODE -ne 0) { throw "ISCC failed" }
New-Item -ItemType Directory -Force dist-installer | Out-Null
Copy-Item "$tmpOut\*.exe" dist-installer -Force
Get-ChildItem dist-installer\*.exe | Select-Object Name, @{n = "MB"; e = { [math]::Round($_.Length / 1MB, 1) } }
Get-FileHash dist-installer\*.exe -Algorithm SHA256 | Select-Object Hash
