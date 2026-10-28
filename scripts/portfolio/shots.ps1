# Portfolio screenshots taken on a real Windows PC: real console windows running
# the real commands, and the real app in your own Chrome (or Edge).
# Nothing is drawn or mocked.
#
# Run from the project folder, in Windows PowerShell:
#   powershell -ExecutionPolicy Bypass -File scripts\portfolio\shots.ps1
#
# Output: portfolio-shots\*.png   (do not touch the mouse while it runs, ~3 min)
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Out  = Join-Path $Root 'portfolio-shots'
$Work = Join-Path $env:TEMP ('ic-shots-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force $Out, $Work | Out-Null
Set-Location $Root

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js is not installed. Install the LTS version from https://nodejs.org and run this again.'; exit 1
}
if (-not (Test-Path 'node_modules')) { npm install }
if (-not (Test-Path 'node_modules\playwright-core')) { npm install --no-save playwright-core@1.47.2 }

# ---------- window capture (Win32) ----------
Add-Type -ReferencedAssemblies System.Drawing @'
using System; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices;
public static class WinShot {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int size);
  // Asks the window to draw itself (works even if something covers it), then
  // trims the invisible resize border so only the visible window remains.
  public static void Save(IntPtr h, string path) {
    ShowWindow(h, 9); SetForegroundWindow(h); System.Threading.Thread.Sleep(800);
    RECT wr, fr;
    GetWindowRect(h, out wr);
    if (DwmGetWindowAttribute(h, 9, out fr, Marshal.SizeOf(typeof(RECT))) != 0) fr = wr;
    int w = wr.R - wr.L, ht = wr.B - wr.T;
    Rectangle crop = new Rectangle(fr.L - wr.L, fr.T - wr.T, fr.R - fr.L, fr.B - fr.T);
    using (Bitmap full = new Bitmap(w, ht)) {
      bool ok;
      using (Graphics g = Graphics.FromImage(full)) {
        IntPtr hdc = g.GetHdc();
        ok = PrintWindow(h, hdc, 2);
        g.ReleaseHdc(hdc);
      }
      if (!ok) using (Graphics g = Graphics.FromImage(full)) g.CopyFromScreen(wr.L, wr.T, 0, 0, full.Size);
      using (Bitmap outBmp = full.Clone(crop, PixelFormat.Format32bppArgb)) outBmp.Save(path, ImageFormat.Png);
    }
  }
}
'@
[WinShot]::SetProcessDPIAware() | Out-Null

# Opens a real console window, runs the commands in it (each shown with its
# prompt line), waits for them to finish, and saves a picture of that window.
function Take-ConsoleShot([string]$name, [int]$cols, [int]$rows, [string[]]$commands) {
  $marker = Join-Path $Work "$name.done"
  $title  = "Inventory Control - $name"
  $lines  = @(
    "`$Host.UI.RawUI.WindowTitle = '$title'",
    "mode con: cols=$cols lines=$rows",
    "Set-Location -LiteralPath '$Root'",
    'Clear-Host'
  )
  foreach ($c in $commands) {
    $shown = $c -replace "'", "''"
    $lines += "Write-Host ('PS ' + (Get-Location).Path + '> ' + '$shown')"
    $lines += $c
    $lines += "Write-Host ''"
  }
  $lines += "New-Item -ItemType File -Path '$marker' | Out-Null"
  $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes(($lines -join "`n")))
  $proc = Start-Process conhost.exe -ArgumentList "powershell.exe -NoProfile -NoExit -EncodedCommand $enc" -PassThru
  $deadline = (Get-Date).AddMinutes(10)
  while (-not (Test-Path $marker)) {
    if ((Get-Date) -gt $deadline) { throw "Timed out waiting for: $name" }
    Start-Sleep -Seconds 1
  }
  Start-Sleep -Seconds 1
  $win = Get-Process | Where-Object { $_.MainWindowTitle -eq $title } | Select-Object -First 1
  if (-not $win) { throw "Could not find the console window for $name" }
  [WinShot]::Save($win.MainWindowHandle, (Join-Path $Out "$name.png"))
  Write-Host "saved portfolio-shots\$name.png"
  # Close only the console this script opened, never a Windows Terminal you already had open.
  if ($win.ProcessName -in 'conhost', 'powershell') { Stop-Process -Id $win.Id -ErrorAction SilentlyContinue }
  if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -ErrorAction SilentlyContinue }
}

# ---------- 1. terminal screenshots ----------
# Demo data for the audit trace: a messy CSV fixed by a reviewer, the same file
# re-sent and blocked, and a wrong import undone (docs/figures/src/demo_trace.js).
$traceDb = Join-Path $Work 'trace'
$env:DATA_DIR = $traceDb
node scripts/seed.js | Out-Null
node docs/figures/src/demo_trace.js (Join-Path $Work 'ids.json') | Out-Null
Remove-Item Env:DATA_DIR

Take-ConsoleShot 'terminal-1-tests' 120 40 @('node --test --test-reporter=spec tests/guard.test.js')

# The evaluation report needs Python with matplotlib. The results folder is
# backed up first and restored afterwards, so your edited REPORT.md is kept.
function Test-Py([string]$exe, [string]$code) {   # $true if `exe -c code` succeeds
  $ErrorActionPreference = 'Continue'
  try { & $exe -c $code *> $null; return ($LASTEXITCODE -eq 0) } catch { return $false }
}
$py = $null
foreach ($cand in 'python', 'py') {
  if ((Get-Command $cand -ErrorAction SilentlyContinue) -and (Test-Py $cand 'import sys')) { $py = $cand; break }
}
if ($py) {
  if (-not (Test-Py $py 'import matplotlib')) { & $py -m pip install --user matplotlib }
  $backup = Join-Path $Work 'results-backup'
  Copy-Item -Recurse 'eval\results' $backup
  try {
    Take-ConsoleShot 'terminal-2-eval' 120 40 @('node eval/run.js', "$py eval/report.py")
  } finally {
    Remove-Item -Recurse -Force 'eval\results'
    Copy-Item -Recurse $backup 'eval\results'
  }
} else {
  Write-Host 'Python not found: skipping the evaluation screenshot (install Python from python.org to include it).'
}

Take-ConsoleShot 'terminal-3-trace' 160 46 @(
  "`$env:DATA_DIR = '$traceDb'",
  'node scripts/trace.js --batch 1',
  'node scripts/trace.js --batch 2',
  'node scripts/trace.js BA325MT1GCM12X035F'
)

# ---------- 2. the real app in your browser ----------
$env:DATA_DIR = Join-Path $Work 'app'
$env:PORT = '3311'
node scripts/seed.js | Out-Null
$server = Start-Process node -ArgumentList 'server/index.js' -PassThru -WindowStyle Hidden
try {
  $up = $false
  for ($i = 0; $i -lt 60 -and -not $up; $i++) {
    try { Invoke-WebRequest -UseBasicParsing 'http://localhost:3311/' | Out-Null; $up = $true } catch { Start-Sleep -Milliseconds 500 }
  }
  if (-not $up) { throw 'The app did not start.' }
  node scripts/portfolio/browser_shots.js $Out 'http://localhost:3311'
} finally {
  Stop-Process -Id $server.Id -ErrorAction SilentlyContinue
  Remove-Item Env:DATA_DIR, Env:PORT -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host "Done. Screenshots are in $Out"
Invoke-Item $Out
