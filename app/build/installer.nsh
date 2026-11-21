!macro badgeClearUnpacked
  ${if} $installMode != "all"
    RMDir /r "$LOCALAPPDATA\BadgeMaximizer"
  ${endif}
!macroend

!macro customInstall
  !insertmacro badgeClearUnpacked
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    !insertmacro badgeClearUnpacked
    ${if} $installMode != "all"
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete your saved logins, totals and the log file?$\r$\n$\r$\nChoose No to keep them for the next install." /SD IDNO IDNO badgeKeepData
        RMDir /r "$APPDATA\Badge Maximizer"
      badgeKeepData:
    ${endif}
  ${endIf}
!macroend
