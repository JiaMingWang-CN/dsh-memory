!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

!ifndef SHORTCUT_NAME
  !define SHORTCUT_NAME "${PRODUCT_NAME}"
!endif

Name "${PRODUCT_NAME}"
BrandingText "${PRODUCT_NAME} ${VERSION}"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\${PRODUCT_FILENAME}"
InstallDirRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "InstallLocation"
ShowInstDetails nevershow
ShowUninstDetails nevershow

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${PRODUCT_FILENAME}.exe"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

!insertmacro addLangs

LangString x64Required ${LANG_SIMPCHINESE} "Memloom Desktop 仅支持 64 位 Windows 系统。"
LangString x64Required ${LANG_ENGLISH} "Memloom Desktop requires 64-bit Windows."

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(x64Required)"
    Quit
  ${EndIf}
  SetRegView 64
  SetShellVarContext current
FunctionEnd

Section "Install" SEC_INSTALL
  InitPluginsDir
  SetShellVarContext current
  SetRegView 64
  SetOutPath "$INSTDIR"

  !ifdef APP_64
    !ifdef COMPRESS
      SetCompress off
    !endif
    File "/oname=$PLUGINSDIR\app-64.7z" "${APP_64}"
    !ifdef COMPRESS
      SetCompress "${COMPRESS}"
    !endif
    Nsis7z::Extract "$PLUGINSDIR\app-64.7z"
  !endif

  WriteUninstaller "$INSTDIR\Uninstall ${PRODUCT_FILENAME}.exe"

  CreateShortcut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$INSTDIR\${PRODUCT_FILENAME}.exe"
  CreateShortcut "$SMPROGRAMS\${SHORTCUT_NAME}.lnk" "$INSTDIR\${PRODUCT_FILENAME}.exe"

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "DisplayName" "${PRODUCT_NAME} ${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "DisplayIcon" "$INSTDIR\${PRODUCT_FILENAME}.exe,0"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "UninstallString" '"$INSTDIR\Uninstall ${PRODUCT_FILENAME}.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall ${PRODUCT_FILENAME}.exe" /S'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "NoRepair" 1

  !ifdef ESTIMATED_SIZE
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "EstimatedSize" ${ESTIMATED_SIZE}
  !endif
  !ifdef COMPANY_NAME
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "Publisher" "${COMPANY_NAME}"
  !endif
SectionEnd

Function un.onInit
  SetRegView 64
  SetShellVarContext current
FunctionEnd

Section "Uninstall"
  SetRegView 64
  SetShellVarContext current

  Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
  Delete "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}"

  SetOutPath "$TEMP"
  Delete "$INSTDIR\Uninstall ${PRODUCT_FILENAME}.exe"
  RMDir /r "$INSTDIR"
SectionEnd
