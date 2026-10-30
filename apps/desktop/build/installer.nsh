; Mini-Summa additions to electron-builder's NSIS installer. electron-builder.yml points `nsis.include` here, and calls these
; macros at fixed places:
;   customInit        at the start of the installer, after the install mode is known
;   customInstall     after the files, the shortcuts and the uninstall entry are written
;   customUnInstall   at the start of the uninstaller, before the program folder is deleted
; Keep this file plain ASCII. It was compiled by makensis (the build runs it), but the installer was never RUN on Windows;
; docs/audit/windows-desktop.md lists what only a Windows PC can confirm.

; ---------------------------------------------------------------------------------------------------------------------------
; Refuse to install where the program cannot run.
;
; electron-builder's own check only rejects Windows Vista and older ("Windows 7 and above is required"), but Electron 45 needs
; Windows 10, and the terminals use the pseudo console API, which first shipped in Windows 10 version 1809 (build 17763). Without
; this the installer finishes on Windows 7 or 8.1 and the program then fails to start with a loader error.
!macro customInit
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "Mini-Summa needs Windows 10 version 1809 or later, or Windows 11. This PC runs an older Windows, so Mini-Summa was not installed." /SD IDOK
    SetErrorLevel 3
    Quit
  ${EndIf}
  ${IfNot} ${AtLeastBuild} 17763
    MessageBox MB_OK|MB_ICONSTOP "Mini-Summa needs Windows 10 version 1809 (build 17763) or later. Update Windows, then run this installer again. Mini-Summa was not installed." /SD IDOK
    SetErrorLevel 3
    Quit
  ${EndIf}
!macroend

; ---------------------------------------------------------------------------------------------------------------------------
; The minisumma:// link handler.
;
; electron-builder's `protocols` setting is used for macOS, Linux and AppX packages and NOT by its NSIS target, so without this
; nothing registers the scheme until the program has run once. The program registers it again under HKCU on every start (so a
; moved install heals itself); this makes a link work straight after installing, and gives the uninstaller something to remove.
; The command is the same one Electron writes: "<exe>" "%1", so the link arrives in the second process's arguments.
!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Classes\minisumma" "" "URL:minisumma"
  WriteRegStr SHELL_CONTEXT "Software\Classes\minisumma" "URL Protocol" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\minisumma\DefaultIcon" "" "$appExe,0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\minisumma\shell\open\command" "" '"$appExe" "%1"'
!macroend

; ---------------------------------------------------------------------------------------------------------------------------
; Uninstall: remove only what this installation registered, and say what is kept.
;
; The program's data (projects, reports, settings, logs, the ChatGPT sign-in) lives in %APPDATA%\Mini-Summa and is deliberately
; NOT deleted (`deleteAppDataOnUninstall: false`). Someone who uninstalls to get rid of the program should be told that
; something is left, and where. An update (the old version is uninstalled silently first) and a silent uninstall say nothing.
!macro customUnInstall
  ; The link handler, but only while it still points at THIS installation: it may belong to another copy now.
  ; (NSIS string comparison is case-insensitive, which is what a Windows path needs.)
  ReadRegStr $R8 HKCU "Software\Classes\minisumma\shell\open\command" ""
  StrCmp $R8 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"' 0 +2
  DeleteRegKey HKCU "Software\Classes\minisumma"
  ReadRegStr $R8 SHELL_CONTEXT "Software\Classes\minisumma\shell\open\command" ""
  StrCmp $R8 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"' 0 +2
  DeleteRegKey SHELL_CONTEXT "Software\Classes\minisumma"

  ${IfNot} ${Silent}
  ${AndIfNot} ${isUpdated}
    MessageBox MB_OK|MB_ICONINFORMATION "Mini-Summa is being removed. Your data is NOT deleted. Your projects, reports, settings, logs and the ChatGPT sign-in stay in:$\r$\n$\r$\n    %APPDATA%\Mini-Summa$\r$\n$\r$\nDelete that folder yourself if you want it gone.$\r$\n$\r$\nIf you installed Mini-Summa's hooks into Claude Code, they are still listed in %USERPROFILE%\.claude\settings.json and Claude Code will keep trying to run them. To remove them, reinstall Mini-Summa and use Settings, Claude hooks, Remove hooks, or delete those entries by hand."
  ${EndIf}
!macroend
