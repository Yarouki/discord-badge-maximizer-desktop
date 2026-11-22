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

!macro badgeWizardLook
  !ifndef MUI_BGCOLOR
    !define MUI_BGCOLOR "14142E"
  !endif
  !ifndef MUI_TEXTCOLOR
    !define MUI_TEXTCOLOR "FFFFFF"
  !endif
!macroend

!macro customWelcomePage
  !insertmacro badgeWizardLook
  !define MUI_WELCOMEPAGE_TITLE "Badge Maximizer ${VERSION}"
  !define MUI_WELCOMEPAGE_TEXT "This puts Badge Maximizer on this PC for your Windows user. It needs no administrator rights, and Python and FFmpeg come with it.$\r$\n$\r$\nUsing the app breaks Discord's Terms of Service. Discord can restrict or ban an account for it.$\r$\n$\r$\nClick Next to go on."
  !insertmacro MUI_PAGE_WELCOME
  !define MUI_FINISHPAGE_TITLE "Badge Maximizer is installed"
  !define MUI_FINISHPAGE_TEXT "Log in with Discord on the first screen to start.$\r$\n$\r$\nYour logins are saved on this PC only, encrypted for your Windows user."
  !define MUI_FINISHPAGE_RUN_TEXT "Start Badge Maximizer"
!macroend

!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW badgeProgressShow
!macroend

!macro customFinishPage
  !ifndef HIDE_RUN_AFTER_FINISH
    Function StartApp
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd

    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"

    !define MUI_PAGE_CUSTOMFUNCTION_SHOW badgeFinishShow
  !endif
  !insertmacro MUI_PAGE_FINISH
  Function badgeProgressShow
    FindWindow $0 "#32770" "" $HWNDPARENT
    GetDlgItem $1 $0 1004
    System::Call 'uxtheme::SetWindowTheme(p $1, w " ", w " ")'
    SendMessage $1 0x0409 0 0x002AA5F0
    SendMessage $1 0x2001 0 0x0066242A
  FunctionEnd
  !ifndef HIDE_RUN_AFTER_FINISH
    Function badgeFinishShow
      System::Call 'uxtheme::SetWindowTheme(p $mui.FinishPage.Run, w " ", w " ")'
      SetCtlColors $mui.FinishPage.Run "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"
    FunctionEnd
  !endif
!macroend

!macro customUnWelcomePage
  !insertmacro badgeWizardLook
  !define MUI_WELCOMEPAGE_TITLE "Remove Badge Maximizer"
  !define MUI_WELCOMEPAGE_TEXT "This removes the app from this PC.$\r$\n$\r$\nYou'll be asked whether to keep your saved logins, your totals and the log file."
  !insertmacro MUI_UNPAGE_WELCOME
!macroend
