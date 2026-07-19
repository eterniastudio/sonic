!macro NSIS_HOOK_PREINSTALL
  Delete "$INSTDIR\yt-dlp.exe"
  Delete "$INSTDIR\deno.exe"
  Delete "$INSTDIR\ffmpeg.exe"
  Delete "$INSTDIR\ffprobe.exe"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\install-media-engine.ps1" -ManifestPath "$INSTDIR\tool-manifest.json" -InstallDirectory "$LOCALAPPDATA\studio.eternia.sonic\media-engine" -Remove'
!macroend
