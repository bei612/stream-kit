using UnrealBuildTool;

public class StreamKitAudioProbe : ModuleRules
{
    public StreamKitAudioProbe(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
        PrivateDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine", "AudioCaptureCore", "Json" });
    }
}
