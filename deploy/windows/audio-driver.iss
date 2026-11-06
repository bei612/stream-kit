{ Included in the same elevated setup process. No extra elevation, helper
  supervisor, online download or automatic driver removal is introduced. }
#ifdef UsbAudioDriverRoot
procedure RunAudioSetupCommand(Arguments: String);
var ExitCode, I: Integer; Output: TExecOutput; Line: String;
begin
  if not ExecAndCaptureOutput(ExpandConstant('{app}\orchestrator\orchestrator.exe'),
    'audio-driver ' + Arguments,
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

procedure InstallBundledAudioDriver;
begin
  RunAudioSetupCommand('install ' + Quoted(ExpandConstant('{app}\drivers\usbip')));
end;

procedure PrepareBundledAudioDevice(ConfigFile: String);
begin
  if not AudioDriverRestartRequired then
    RunAudioSetupCommand('prepare --config ' + ConfigFile);
end;
#endif
