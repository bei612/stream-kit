{ Included in the same elevated setup process. No extra elevation, helper
  supervisor, online download or automatic driver removal is introduced. }
#ifdef AudioDriverRoot
function ExistingAudioDriver: Boolean;
var Locator, Services, Devices: Variant;
begin
  Result := False;
  if not RegKeyExists(HKLM, 'SYSTEM\CurrentControlSet\Services\VBAudioVACMME') then Exit;
  Locator := CreateOleObject('WbemScripting.SWbemLocator');
  Services := Locator.ConnectServer('', 'root\CIMV2');
  Devices := Services.ExecQuery('SELECT PNPDeviceID FROM Win32_PnPEntity WHERE Service=''VBAudioVACMME'' AND ConfigManagerErrorCode=0');
  if Devices.Count = 0 then
    RaiseException('VB-CABLE 已有安装记录，但设备尚不可用。请先重启电脑并检查设备状态；安装器不会覆盖现有驱动。');
  Result := True;
end;

procedure InstallBundledAudioDriver;
var ExitCode: Integer;
begin
  if ExistingAudioDriver then begin
    Log('Existing VB-CABLE device reused; driver installation skipped.');
    Exit;
  end;
  Log('Installing bundled VB-CABLE by VB-Audio using the elevated setup process.');
  if not Exec(ExpandConstant('{app}\drivers\VB-CABLE\VBCABLE_Setup_x64.exe'), '-i -h',
    ExpandConstant('{app}\drivers\VB-CABLE'), SW_HIDE, ewWaitUntilTerminated, ExitCode) then
    RaiseException('无法启动内嵌音频驱动安装程序。');
  if (ExitCode <> 0) and (ExitCode <> 3010) then
    RaiseException('音频驱动安装失败，退出码：' + IntToStr(ExitCode));
  if not RegKeyExists(HKLM, 'SYSTEM\CurrentControlSet\Services\VBAudioVACMME') then
    RaiseException('音频驱动安装程序已退出，但未找到设备驱动登记；不能视为安装成功。');
  { Vendor documentation requires restart after a fresh installation. Signal it
    with 3010 and defer startup. Never reboot or alter audio defaults here. }
  AudioDriverRestartRequired := True;
end;
#endif

#ifdef UsbAudioDriverRoot
procedure InstallBundledAudioDriver;
var ExitCode, I: Integer; Output: TExecOutput; Line: String;
begin
  if not ExecAndCaptureOutput(ExpandConstant('{app}\orchestrator\orchestrator.exe'),
    'audio-driver install ' + Quoted(ExpandConstant('{app}\drivers\usbip')),
    ExpandConstant('{app}\orchestrator'), SW_HIDE, ewWaitUntilTerminated, ExitCode, Output) then
    RaiseException('无法启动内置音频设备部署。');
  if (ExitCode <> 0) and (ExitCode <> 3010) then begin
    for I := 0 to GetArrayLength(Output.StdErr) - 1 do begin
      Line := Output.StdErr[I];
      if (Length(Line) <= 1024) and (Pos('audio driver operation failed:', Line) = 1) then Log(Line);
    end;
    RaiseException('音频设备部署失败，退出码：' + IntToStr(ExitCode));
  end;
  AudioDriverRestartRequired := ExitCode = 3010;
end;
#endif
