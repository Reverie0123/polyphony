# Installs Polyphony for the current user without admin rights: uses Node 20+ from PATH or downloads a portable copy,
# installs the npm package under %LOCALAPPDATA%\polyphony, and creates a Start Menu shortcut.
#   powershell -ExecutionPolicy Bypass -File install.ps1
$ErrorActionPreference = "Stop"
$zh = (Get-Culture).Name -like "zh*"
function Say($en, $cn) { Write-Host ($(if ($zh) { $cn } else { $en })) }
$home_ = Join-Path $env:LOCALAPPDATA "polyphony"
$nodeDir = Join-Path $home_ "node"
New-Item -ItemType Directory -Force $home_ | Out-Null
function NodeOk($exe) { try { $v = & $exe -v 2>$null; return ($v -match "^v(\d+)" -and [int]$Matches[1] -ge 20) } catch { return $false } }
$node = $null
$sys = Get-Command node -ErrorAction SilentlyContinue
if ($sys -and (NodeOk $sys.Source)) { $node = $sys.Source; Say "Using Node.js $(& $node -v) from PATH" "使用系统已装的 Node.js $(& $node -v)" }
elseif (Test-Path (Join-Path $nodeDir "node.exe")) { $node = Join-Path $nodeDir "node.exe"; Say "Using portable Node.js in $nodeDir" "使用 $nodeDir 里的便携版 Node.js" }
else {
  Say "Node.js 20+ not found; downloading a portable copy (about 30 MB)..." "没有找到 Node.js 20 以上版本，下载便携版（约 30 MB）..."
  $ver = "v22.12.0"
  $mirrors = @("https://npmmirror.com/mirrors/node/$ver/node-$ver-win-x64.zip", "https://nodejs.org/dist/$ver/node-$ver-win-x64.zip")
  $zip = Join-Path $env:TEMP "node-$ver-win-x64.zip"
  $got = $false
  foreach ($u in $mirrors) { try { Invoke-WebRequest $u -OutFile $zip -TimeoutSec 120; $got = $true; break } catch { Say "  $u failed, trying next" "  $u 失败，换下一个" } }
  if (-not $got) { throw "download failed" }
  Expand-Archive $zip -DestinationPath $env:TEMP -Force
  Move-Item (Join-Path $env:TEMP "node-$ver-win-x64") $nodeDir -Force
  Remove-Item $zip -Force
  $node = Join-Path $nodeDir "node.exe"
}
$npm = Join-Path (Split-Path $node) "npm.cmd"
if (-not (Test-Path $npm)) { $npm = "npm" }
$registry = "https://registry.npmjs.org"
try { $t = Measure-Command { Invoke-WebRequest "https://registry.npmmirror.com/polyphony-chat" -TimeoutSec 5 | Out-Null }; if ($t.TotalSeconds -lt 3) { $registry = "https://registry.npmmirror.com" } } catch {}
Say "Installing polyphony-chat from $registry ..." "从 $registry 安装 polyphony-chat ..."
$pkgDir = Join-Path $home_ "app"
New-Item -ItemType Directory -Force $pkgDir | Out-Null
Push-Location $pkgDir
try {
  if (-not (Test-Path "package.json")) { '{"name":"polyphony-install","private":true}' | Set-Content package.json }
  & $npm install polyphony-chat@latest --registry $registry --no-audit --no-fund --loglevel error
} finally { Pop-Location }
$entry = Join-Path $pkgDir "node_modules\polyphony-chat\dist\index.js"
if (-not (Test-Path $entry)) { throw "install failed: $entry missing" }
$bin = Join-Path $home_ "bin"; New-Item -ItemType Directory -Force $bin | Out-Null
"@echo off`r`n""$node"" ""$entry"" %*" | Set-Content (Join-Path $bin "polyphony.cmd") -Encoding ASCII
$vbs = Join-Path $bin "launch.vbs"
"Set sh = CreateObject(""WScript.Shell"")`r`nsh.Run """"""$node"""" """"$entry"""""", 0, False" | Set-Content $vbs -Encoding ASCII
$programs = [Environment]::GetFolderPath("Programs")
$lnk = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $programs "Polyphony 复调.lnk"))
$lnk.TargetPath = "$env:SystemRoot\System32\wscript.exe"
$lnk.Arguments = """$vbs"""
$lnk.WorkingDirectory = $bin
$ico = Join-Path $pkgDir "node_modules\polyphony-chat\resources\polyphony.ico"
if (Test-Path $ico) { $lnk.IconLocation = $ico }
$lnk.Save()
Say "Done. Start Polyphony from the Start Menu, or run: $bin\polyphony.cmd" "装好了。从开始菜单打开「Polyphony 复调」，或运行：$bin\polyphony.cmd"
