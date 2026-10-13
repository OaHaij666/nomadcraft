param([Parameter(Mandatory=$true)][int]$GamePid,[Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;using System.Runtime.InteropServices;
public static class OwnedGameCapture {
 [StructLayout(LayoutKind.Sequential)] public struct Rect {public int Left,Top,Right,Bottom;}
 [DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr window,out Rect rect);
 [DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr window);
 [DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr window,int command);
 [DllImport("user32.dll")]public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
}
'@
[OwnedGameCapture]::SetProcessDpiAwarenessContext([IntPtr](-4))|Out-Null
$game=Get-Process -Id $GamePid
if($game.ProcessName -notmatch '^java(w)?$'){throw 'Capture target must be the owned Java game process'}
$window=$game.MainWindowHandle
if($window -eq [IntPtr]::Zero){throw 'Owned game has no visible main window'}
$previous=[OwnedGameCapture]::GetForegroundWindow()
[OwnedGameCapture]::ShowWindow($window,9)|Out-Null
[OwnedGameCapture]::SetForegroundWindow($window)|Out-Null
Start-Sleep -Milliseconds 350
if([OwnedGameCapture]::GetForegroundWindow() -ne $window){throw 'Owned game did not become foreground; refusing to capture another window'}
$rect=New-Object OwnedGameCapture+Rect
[OwnedGameCapture]::GetWindowRect($window,[ref]$rect)|Out-Null
$bitmap=New-Object System.Drawing.Bitmap(($rect.Right-$rect.Left),($rect.Bottom-$rect.Top))
$graphics=[System.Drawing.Graphics]::FromImage($bitmap)
try{$graphics.CopyFromScreen($rect.Left,$rect.Top,0,0,$bitmap.Size);$bitmap.Save($OutputPath,[System.Drawing.Imaging.ImageFormat]::Png)}
finally{$graphics.Dispose();$bitmap.Dispose();if($previous -ne [IntPtr]::Zero){[OwnedGameCapture]::SetForegroundWindow($previous)|Out-Null}}
