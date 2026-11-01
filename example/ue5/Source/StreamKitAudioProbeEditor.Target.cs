using UnrealBuildTool;

public class StreamKitAudioProbeEditorTarget : TargetRules
{
    public StreamKitAudioProbeEditorTarget(TargetInfo Target) : base(Target)
    {
        Type = TargetType.Editor;
        DefaultBuildSettings = BuildSettingsVersion.V2;
        ExtraModuleNames.Add("StreamKitAudioProbe");
    }
}
