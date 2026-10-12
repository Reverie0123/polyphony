# One-shot OCR with the Windows.Media.Ocr engine that ships with Windows 10/11 (Windows PowerShell 5.1).
# Usage: powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ocr.ps1 -PathB64 <base64 utf8 path>
# Prints one JSON line: { ok, text, lang, ms } or { ok: false, error }.
param([string]$PathB64)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  function Await($op, $t) { $m = $asTask.MakeGenericMethod($t); $task = $m.Invoke($null, @($op)); $task.Wait(); $task.Result }
  $path = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PathB64))
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if (-not $engine) { throw "no OCR language pack installed" }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $stream.Dispose(); $bitmap.Dispose()
  $lines = @()
  foreach ($l in $result.Lines) { $lines += $l.Text }
  $out = @{ ok = $true; text = ($lines -join "`n"); lang = $engine.RecognizerLanguage.LanguageTag; ms = $sw.ElapsedMilliseconds } | ConvertTo-Json -Compress
} catch {
  $e = $_.Exception; $msgs = @()
  while ($e) { $msgs += $e.Message; if ($e -is [System.AggregateException] -and $e.InnerExceptions.Count -gt 0) { $e = $e.InnerExceptions[0] } else { $e = $e.InnerException } }
  $out = @{ ok = $false; error = ($msgs -join " <- ") } | ConvertTo-Json -Compress
}
[Console]::Out.WriteLine($out)
