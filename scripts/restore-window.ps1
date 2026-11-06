# Bring the DSH desktop window back when the previous run left it minimized.
#
# A forced restart (taskkill) can let the desktop app persist "minimized" as its
# remembered window state, so the next launch comes up in the taskbar only. This
# restores and focuses it, which is what makes the app look "not open" after a
# scripted restart.

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class DshWindow {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
}
'@

$deadline = (Get-Date).AddSeconds(30)
$proc = $null
while ((Get-Date) -lt $deadline) {
  $proc = Get-Process -Name "DeepSeek Harness" -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Select-Object -First 1
  if ($proc) { break }
  Start-Sleep -Milliseconds 500
}

if (-not $proc) {
  Write-Host "no DSH window after 30s - the app may have failed to start"
  exit 1
}

$handle = [IntPtr]$proc.MainWindowHandle
if ([DshWindow]::IsIconic($handle)) {
  [DshWindow]::ShowWindow($handle, 9) | Out-Null   # SW_RESTORE
  Start-Sleep -Milliseconds 400
  Write-Host "restored a minimized window"
}
[DshWindow]::BringWindowToTop($handle) | Out-Null
[DshWindow]::SetForegroundWindow($handle) | Out-Null
Start-Sleep -Milliseconds 300
Write-Host ("window ready: " + $proc.MainWindowTitle)