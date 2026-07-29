!macro NSIS_HOOK_PREINSTALL
  Delete "$INSTDIR\yt-dlp.exe"
  Delete "$INSTDIR\deno.exe"
  Delete "$INSTDIR\ffmpeg.exe"
  Delete "$INSTDIR\ffprobe.exe"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Tauri runs the old uninstaller with /UPDATE while applying an update. Keep the
  ; shared, checksum-verified media engine in that case so the replacement app can
  ; inspect and export immediately. A deliberate uninstall still removes it.
  ${If} $UpdateMode <> 1
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\install-media-engine.ps1" -ManifestPath "$INSTDIR\tool-manifest.json" -InstallDirectory "$LOCALAPPDATA\studio.eternia.sonic\media-engine" -Remove'
  ${EndIf}
!macroend
