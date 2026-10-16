; Inno Setup script for Polyphony. Built by scripts/make-installer.ps1, which stages dist/, web/, resources/ and a
; portable node.exe under build/stage first. Installs per user, no admin rights needed.
#define AppName "Polyphony"
#define AppVersion "0.1.0"
#define AppPublisher "Reverie0123"
#define AppURL "https://github.com/Reverie0123/polyphony"
#define Stage "..\build\stage"

[Setup]
AppId={{B5A1E7D2-4C3F-4E8A-9D21-7F0C2A6B9E55}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}/issues
AppUpdatesURL={#AppURL}/releases
DefaultDirName={localappdata}\Programs\Polyphony
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist-installer
OutputBaseFilename=Polyphony-Setup-{#AppVersion}
SetupIconFile=..\resources\polyphony.ico
UninstallDisplayIcon={app}\resources\polyphony.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ShowLanguageDialog=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"
Name: "zh"; MessagesFile: "..\build\lang\ChineseSimplified.isl"

[CustomMessages]
en.RunApp=Open Polyphony now
en.DesktopIcon=Create a desktop shortcut
zh.RunApp=现在打开复调
zh.DesktopIcon=创建桌面快捷方式

[Tasks]
Name: "desktopicon"; Description: "{cm:DesktopIcon}"; Flags: unchecked

[Files]
Source: "{#Stage}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Polyphony 复调"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\launch.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\resources\polyphony.ico"
Name: "{autodesktop}\Polyphony 复调"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\launch.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\resources\polyphony.ico"; Tasks: desktopicon

[Run]
Filename: "{sys}\wscript.exe"; Parameters: """{app}\launch.vbs"""; Description: "{cm:RunApp}"; Flags: postinstall nowait skipifsilent

[UninstallRun]
; The server runs as a hidden node.exe without a window, so it is stopped through its own instance.json / pid.
Filename: "{app}\polyphony.cmd"; Parameters: "--stop"; Flags: runhidden waituntilterminated; RunOnceId: "stopapp"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\node_modules"
Type: dirifempty; Name: "{app}"
