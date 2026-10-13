param([Parameter(Mandatory=$true)][int]$GamePid,[Parameter(Mandatory=$true)][string]$GameDirectory)
$ErrorActionPreference='Stop'
$game=Get-Process -Id $GamePid -ErrorAction SilentlyContinue
if(-not $game){exit 0}
if($game.ProcessName -notmatch '^java(w)?$'){throw 'Close target must be the owned Java game process'}
$process=Get-CimInstance Win32_Process -Filter "ProcessId=$GamePid"
$directory=[System.IO.Path]::GetFullPath($GameDirectory).Replace('\','/').ToLowerInvariant()
$commandLine=([string]$process.CommandLine).Replace('\','/').ToLowerInvariant()
if(-not $commandLine.Contains($directory)){throw 'Game process does not use the diagnostic directory'}
$window=$game.MainWindowHandle
if($window -eq [IntPtr]::Zero){throw 'Owned game has no main window to close'}
Add-Type @'
using System;using System.Runtime.InteropServices;
public static class OwnedGameClose {
 [DllImport("user32.dll")]public static extern bool PostMessage(IntPtr window,uint message,IntPtr wParam,IntPtr lParam);
}
'@
if(-not [OwnedGameClose]::PostMessage($window,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)){throw 'Owned game close request failed'}
