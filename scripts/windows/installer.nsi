Unicode True
!include "MUI2.nsh"
!include "x64.nsh"
Name "Ask for GPT Windows Preview"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\Ask for GPT Windows Preview"
InstallDirRegKey HKCU "Software\AskGPTWindowsPreview" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma
VIProductVersion "0.1.0.0"
VIAddVersionKey /LANG=1033 "ProductName" "Ask for GPT Windows Preview"
VIAddVersionKey /LANG=1033 "FileDescription" "Ask for GPT Windows reading preview installer"
VIAddVersionKey /LANG=1033 "FileVersion" "0.1.0-preview.1"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Ask for GPT contributors; component licenses included"
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "Ask for GPT Windows Preview requires Windows x64."
    Abort
  ${EndIf}
FunctionEnd

Section "Install"
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  File /r "${BUNDLE_DIR}\*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\Ask for GPT Windows Preview"
  CreateShortcut "$SMPROGRAMS\Ask for GPT Windows Preview\Ask for GPT.lnk" "$INSTDIR\AskGPT.Windows.exe"
  CreateShortcut "$SMPROGRAMS\Ask for GPT Windows Preview\安装与配置说明.lnk" "$INSTDIR\安装与配置说明.txt"
  WriteRegStr HKCU "Software\AskGPTWindowsPreview" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AskGPTWindowsPreview" "DisplayName" "Ask for GPT Windows Preview"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AskGPTWindowsPreview" "DisplayVersion" "0.1.0-preview.1"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AskGPTWindowsPreview" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AskGPTWindowsPreview" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AskGPTWindowsPreview" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AskGPTWindowsPreview" "NoRepair" 1
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  !include "${UNINSTALL_INCLUDE}"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\Ask for GPT Windows Preview\Ask for GPT.lnk"
  Delete "$SMPROGRAMS\Ask for GPT Windows Preview\安装与配置说明.lnk"
  RMDir "$SMPROGRAMS\Ask for GPT Windows Preview"
  DeleteRegKey HKCU "Software\AskGPTWindowsPreview"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AskGPTWindowsPreview"
SectionEnd
