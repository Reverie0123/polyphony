# Draws the Polyphony icon (blue rounded square, three overlapping white circles) as .ico (256/48/32/16) and .png.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent
$out = Join-Path $root "resources"
New-Item -ItemType Directory -Force $out | Out-Null

function Draw([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $radius = [int]($size * 0.22)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $radius * 2
  $path.AddArc(0, 0, $d, $d, 180, 90)
  $path.AddArc($size - $d - 1, 0, $d, $d, 270, 90)
  $path.AddArc($size - $d - 1, $size - $d - 1, $d, $d, 0, 90)
  $path.AddArc(0, $size - $d - 1, $d, $d, 90, 90)
  $path.CloseFigure()
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 59, 110, 245))
  $g.FillPath($brush, $path)
  $r = $size * 0.26
  $circles = @(@(0.36, 0.42, 255), @(0.64, 0.42, 200), @(0.5, 0.66, 150))
  foreach ($c in $circles) {
    $b = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb($c[2], 255, 255, 255))
    $g.FillEllipse($b, [float]($size * $c[0] - $r / 2), [float]($size * $c[1] - $r / 2), [float]$r, [float]$r)
  }
  $g.Dispose()
  return $bmp
}

$png = Draw 256
$png.Save((Join-Path $out "icon.png"), [System.Drawing.Imaging.ImageFormat]::Png)

# Build a multi-size .ico by hand: header + directory + PNG-compressed images.
$sizes = @(256, 48, 32, 16)
$images = @()
foreach ($s in $sizes) {
  $b = Draw $s
  $ms = New-Object System.IO.MemoryStream
  $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $images += ,@($s, $ms.ToArray())
  $b.Dispose()
}
$fs = [System.IO.File]::Create((Join-Path $out "polyphony.ico"))
$bw = New-Object System.IO.BinaryWriter $fs
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$images.Count)
$offset = 6 + 16 * $images.Count
foreach ($img in $images) {
  $s = $img[0]; $bytes = $img[1]
  $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
  $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
  $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([uint16]1); $bw.Write([uint16]32)
  $bw.Write([uint32]$bytes.Length); $bw.Write([uint32]$offset)
  $offset += $bytes.Length
}
foreach ($img in $images) { $bw.Write($img[1]) }
$bw.Close()
Write-Output "icon written: $out\polyphony.ico, $out\icon.png"
