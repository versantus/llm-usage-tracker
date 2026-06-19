' Launches the tray app with no PowerShell console window.
' Double-click this (or point a Startup shortcut at it).
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "\UsageTracker.ps1""", 0, False
