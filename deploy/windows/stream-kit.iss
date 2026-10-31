; Unified first-install wizard. Both interactive and silent paths invoke the
; same native deployment commands. Existing deployments require migration.
#ifndef PayloadRoot
  #error PayloadRoot is required
#endif
#ifndef SourceCommit
  #error SourceCommit is required
#endif
#ifndef ArtifactDir
  #error ArtifactDir is required
#endif

[Setup]
AppId={{E7FD370E-32FD-4989-8FE8-C5F9D56187BC}
AppName=Stream-Kit
AppVersion=0.1.0-preview.{#Copy(SourceCommit, 1, 12)}
VersionInfoVersion=0.1.0.0
DefaultDirName={autopf}\StreamKit
DefaultGroupName=Stream-Kit
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
DisableProgramGroupPage=yes
DisableWelcomePage=yes
DisableReadyPage=yes
ShowLanguageDialog=no
UsePreviousAppDir=no
UsePreviousTasks=no
CloseApplications=no
RestartApplications=no
RestartIfNeededByRun=no
Compression=lzma2
SolidCompression=yes
OutputDir={#ArtifactDir}
OutputBaseFilename=stream-kit-preview-{#Copy(SourceCommit, 1, 12)}-windows-amd64-setup
UninstallDisplayIcon={app}\orchestrator\orchestrator.exe
SetupLogging=yes

[Languages]
Name: "zhcn"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
Name: "en"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "{#PayloadRoot}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Registry]
Root: HKLM; Subkey: "Software\StreamKit"; ValueType: string; ValueName: "DataDirectory"; ValueData: "{code:DataDirectory}"; Flags: uninsdeletevalue

[Icons]
Name: "{group}\Stream-Kit 管理控制台"; Filename: "{code:ControlURL}"

[Run]
Filename: "{code:ControlURL}"; Description: "打开 Stream-Kit 管理控制台"; Flags: postinstall shellexec skipifsilent unchecked

[Code]
const
  HexDigits = '0123456789ABCDEF';
var
  DataPage: TInputDirWizardPage;
  AdminPage: TInputQueryWizardPage;

function ControlURL(Param: String): String;
begin
  Result := 'http://127.0.0.1:' + ExpandConstant('{param:CONTROLPORT|9000}');
end;

function DataDirectory(Param: String): String;
begin
  Result := DataPage.Values[0];
end;

function Quoted(Value: String): String;
begin
  if Pos('"', Value) <> 0 then RaiseException('路径不得包含双引号。');
  Result := '"' + Value + '"';
end;

function JSONString(Value: String): String;
var I: Integer;
begin
  Result := '"';
  for I := 1 to Length(Value) do begin
    if (Value[I] = '"') or (Value[I] = '\') then
      Result := Result + '\' + Value[I]
    else if Ord(Value[I]) < 32 then
      Result := Result + '\u00' + HexDigits[(Ord(Value[I]) div 16) + 1] + HexDigits[(Ord(Value[I]) mod 16) + 1]
    else
      Result := Result + Value[I];
  end;
  Result := Result + '"';
end;

procedure InitializeWizard;
begin
  DataPage := CreateInputDirPage(wpSelectDir, '运行数据目录',
    '程序与运行数据分别保存',
    '选择新的数据目录。配置、应用和录音设备设置在卸载时保留。父目录必须已经存在。', False, '');
  DataPage.Add('数据目录：');
  DataPage.Values[0] := ExpandConstant('{param:DATADIR|{commonappdata}\StreamKit}');
  AdminPage := CreateInputQueryPage(DataPage.ID, '唯一管理员',
    '设置平台管理员账号', '密码至少 12 个字符。媒体组件的内部凭据由安装程序自动生成。');
  AdminPage.Add('用户名：', False);
  AdminPage.Add('密码：', True);
  AdminPage.Add('确认密码：', True);
  AdminPage.Values[0] := 'admin';
  WizardForm.FinishedLabel.Caption := '安装完成后，请在统一管理页面添加渲染应用、选择音频设备并配置访问地址。初始服务仅监听本机；远程麦克风需要 HTTPS。';
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = AdminPage.ID then begin
    Result := (Trim(AdminPage.Values[0]) <> '') and (Length(UTF8Encode(AdminPage.Values[0])) <= 128) and
      (Length(AdminPage.Values[1]) >= 12) and (Length(UTF8Encode(AdminPage.Values[1])) <= 1024) and
      (AdminPage.Values[1] = AdminPage.Values[2]);
    if not Result then MsgBox('请填写用户名、至少 12 个字符的密码，并确认两次密码一致。', mbError, MB_OK);
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if RegKeyExists(HKLM, 'SYSTEM\CurrentControlSet\Services\StreamKitOrchestrator') then
    Result := '已存在 Stream-Kit 服务。此安装器用于首次安装，不会覆盖运行中的部署。'
  else if DirExists(ExpandConstant('{app}')) or FileExists(ExpandConstant('{app}')) then
    Result := '程序目录已存在，请选择新的空位置。'
  else if DirExists(DataDirectory('')) or FileExists(DataDirectory('')) then
    Result := '数据目录已存在，不会覆盖现有配置和应用。'
  else if not DirExists(ExtractFileDir(DataDirectory(''))) then
    Result := '数据父目录不存在。'
  else if WizardSilent and (ExpandConstant('{param:ADMINFILE|}') <> '') and not FileExists(ExpandConstant('{param:ADMINFILE|}')) then
    Result := '/ADMINFILE 指定的管理员 JSON 文件不存在。';
end;

function NativeCommand(Arguments: String): Boolean;
var ExitCode: Integer;
begin
  Result := Exec(ExpandConstant('{app}\orchestrator\orchestrator.exe'), Arguments,
    ExpandConstant('{app}\orchestrator'), SW_HIDE, ewWaitUntilTerminated, ExitCode);
  Result := Result and (ExitCode = 0);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var AdminFile, Arguments, ConfigFile: String;
begin
  if CurStep <> ssPostInstall then Exit;
  AdminFile := ExpandConstant('{param:ADMINFILE|}');
  if not WizardSilent then begin
    AdminFile := ExpandConstant('{tmp}\administrator.json');
    if not SaveStringToFile(AdminFile, UTF8Encode('{"name":' + JSONString(AdminPage.Values[0]) +
      ',"password":' + JSONString(AdminPage.Values[1]) + '}'), False) then
      RaiseException('无法准备管理员配置。');
  end;
  try
    Arguments := 'init-platform --root ' + Quoted(ExpandConstant('{app}')) +
      ' --data-dir ' + Quoted(DataDirectory('')) +
      ' --control-port ' + Quoted(ExpandConstant('{param:CONTROLPORT|9000}')) +
      ' --gateway-port ' + Quoted(ExpandConstant('{param:GATEWAYPORT|8080}')) +
      ' --renderer-port ' + Quoted(ExpandConstant('{param:RENDERERPORT|47989}'));
    if AdminFile <> '' then Arguments := Arguments + ' --admin-file ' + Quoted(AdminFile);
    if ExpandConstant('{param:SESSIONID|}') <> '' then
      Arguments := Arguments + ' --session-id ' + Quoted(ExpandConstant('{param:SESSIONID|}'));
    if ExpandConstant('{param:USERSID|}') <> '' then
      Arguments := Arguments + ' --user-sid ' + Quoted(ExpandConstant('{param:USERSID|}'));
    if not NativeCommand(Arguments) then RaiseException('平台初始化失败，未启动服务。请检查安装目录、数据目录、登录会话和组件版本。');
  finally
    if not WizardSilent then DeleteFile(AdminFile);
  end;
  ConfigFile := Quoted(AddBackslash(DataDirectory('')) + 'orchestrator.json');
  if not NativeCommand('service install --config ' + ConfigFile) then
    RaiseException('服务注册失败，配置已保留。');
  if not NativeCommand('service start --config ' + ConfigFile) then begin
    if not NativeCommand('service remove --config ' + ConfigFile) then
      RaiseException('服务启动和清理均失败，请查看数据目录中的日志。');
    RaiseException('服务启动失败，已移除本次注册的服务，数据及日志已保留。');
  end;
end;

function InitializeUninstall: Boolean;
var DataPath: String; ExitCode: Integer;
begin
  Result := False;
  if not RegQueryStringValue(HKLM, 'Software\StreamKit', 'DataDirectory', DataPath) then Exit;
  Result := Exec(ExpandConstant('{app}\orchestrator\orchestrator.exe'),
    'service remove --config ' + Quoted(AddBackslash(DataPath) + 'orchestrator.json'),
    ExpandConstant('{app}\orchestrator'), SW_HIDE, ewWaitUntilTerminated, ExitCode);
  Result := Result and (ExitCode = 0);
  if not Result then MsgBox('无法停止并移除对应服务，已取消卸载以保留运行文件。', mbError, MB_OK);
end;
