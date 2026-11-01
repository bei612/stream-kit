#include "StreamKitCaptureCommandlet.h"
#include "AudioCaptureCore.h"
#include "Dom/JsonObject.h"
#include "HAL/PlatformProcess.h"
#include "Misc/EngineVersion.h"
#include "Misc/FileHelper.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "Modules/ModuleManager.h"
#include "Serialization/JsonSerializer.h"
#include <atomic>
#include <cmath>

IMPLEMENT_PRIMARY_GAME_MODULE(FDefaultGameModuleImpl, StreamKitAudioProbe, "StreamKitAudioProbe");
DEFINE_LOG_CATEGORY_STATIC(LogStreamKitAudioProbe, Log, All);

namespace
{
FString SerializeJson(const TSharedRef<FJsonObject>& Object)
{
    FString Text;
    const auto Writer = TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Text);
    FJsonSerializer::Serialize(Object, Writer);
    return Text;
}

void Emit(const TSharedRef<FJsonObject>& Object)
{
    const FString Text = SerializeJson(Object);
    UE_LOG(LogStreamKitAudioProbe, Display, TEXT("STREAM_KIT_AUDIO:%s"), *Text);
}

TSharedRef<FJsonObject> DeviceJson(const Audio::FCaptureDeviceInfo& Info)
{
    const auto Object = MakeShared<FJsonObject>();
    Object->SetStringField(TEXT("id"), Info.DeviceId);
    Object->SetStringField(TEXT("name"), Info.DeviceName);
    Object->SetNumberField(TEXT("input_channels"), Info.InputChannels);
    Object->SetNumberField(TEXT("preferred_sample_rate"), Info.PreferredSampleRate);
    return Object;
}

TSharedRef<FJsonObject> Tone(const TArray<float>& Samples, int32 Count, int32 Rate, double Frequency)
{
    // Same offline 100 ms Hann/Goertzel measurement as audio-target analysis.rs.
    const int32 Window = Rate / 10;
    const double Angle = 2.0 * PI * Frequency / Rate;
    const double Coefficient = 2.0 * std::cos(Angle);
    double Peak = 0.0, Sum = 0.0;
    int32 Windows = 0;
    for (int32 Begin = 0; Begin + Window <= Count; Begin += Window)
    {
        double Previous = 0.0, Older = 0.0, WeightSum = 0.0;
        for (int32 I = 0; I < Window; ++I)
        {
            const double Weight = 0.5 - 0.5 * std::cos(2.0 * PI * I / (Window - 1));
            const double Current = Samples[Begin + I] * Weight + Coefficient * Previous - Older;
            Older = Previous;
            Previous = Current;
            WeightSum += Weight;
        }
        const double Power = FMath::Max(0.0, Previous * Previous + Older * Older - Coefficient * Previous * Older);
        const double Amplitude = 2.0 * std::sqrt(Power) / WeightSum;
        Peak = FMath::Max(Peak, Amplitude);
        Sum += Amplitude;
        ++Windows;
    }
    const auto Result = MakeShared<FJsonObject>();
    Result->SetNumberField(TEXT("frequency_hz"), Frequency);
    Result->SetNumberField(TEXT("sample_rate"), Rate);
    Result->SetNumberField(TEXT("analyzed_frames"), Windows * Window);
    Result->SetNumberField(TEXT("windows"), Windows);
    Result->SetNumberField(TEXT("peak_amplitude"), Peak);
    Result->SetNumberField(TEXT("mean_amplitude"), Windows ? Sum / Windows : 0.0);
    return Result;
}
}

UStreamKitCaptureCommandlet::UStreamKitCaptureCommandlet()
{
    IsClient = false;
    IsServer = false;
    IsEditor = true;
    LogToConsole = false;
    ShowErrorCount = false;
    UseCommandletResultAsExitCode = true;
}

int32 UStreamKitCaptureCommandlet::Main(const FString& Params)
{
    const auto Result = MakeShared<FJsonObject>();
    Result->SetNumberField(TEXT("schema_version"), 1);
    Result->SetStringField(TEXT("engine_version"), FEngineVersion::Current().ToString());
    Result->SetStringField(TEXT("backend"), TEXT("UE5 AudioCaptureCore"));
    Result->SetBoolField(TEXT("capture_success"), false);
    FString ResultFile;
    FParse::Value(*Params, TEXT("ResultFile="), ResultFile);
    if (ResultFile.IsEmpty() || FPaths::IsRelative(ResultFile) || IFileManager::Get().FileExists(*ResultFile)) return 2;
    auto Finish = [&](const FString& Error, int32 Code)
    {
        if (!Error.IsEmpty()) Result->SetStringField(TEXT("error"), Error);
        if (!FFileHelper::SaveStringToFile(SerializeJson(Result) + TEXT("\n"), *ResultFile,
            FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM, &IFileManager::Get(), FILEWRITE_NoReplaceExisting)) return 3;
        Emit(Result);
        return Code;
    };
    Audio::FAudioCapture Capture;
    TArray<Audio::FCaptureDeviceInfo> Devices;
    Capture.GetCaptureDevicesAvailable(Devices);
    TArray<TSharedPtr<FJsonValue>> Catalog;
    for (const auto& Info : Devices) Catalog.Add(MakeShared<FJsonValueObject>(DeviceJson(Info)));
    Result->SetArrayField(TEXT("devices"), Catalog);
    if (FParse::Param(*Params, TEXT("ListDevices"))) return Finish(TEXT(""), 0);
    FString RequestedId;
    FParse::Value(*Params, TEXT("CaptureDeviceId="), RequestedId);
    if (RequestedId.IsEmpty()) return Finish(TEXT("An explicit UE capture device ID is required; no default-device fallback"), 2);
    int32 DurationMs = 3000;
    FParse::Value(*Params, TEXT("DurationMs="), DurationMs);
    if (DurationMs < 100 || DurationMs > 10000) return Finish(TEXT("DurationMs must be between 100 and 10000"), 2);

    // UE 5.3 GetCaptureDeviceInfo indexes all devices; OpenAudioCaptureStream
    // indexes only capture devices. Resolve both by stable ID, never substitute
    // one index domain for the other or fall back to the default microphone.
    const int32 CaptureIndex = Devices.IndexOfByPredicate([&](const auto& Info) { return Info.DeviceId == RequestedId; });
    if (CaptureIndex == INDEX_NONE)
        return Finish(TEXT("The explicit capture endpoint is unavailable"), 2);
    Audio::FCaptureDeviceInfo Selected{};
    int32 BackendIndex = INDEX_NONE;
    for (int32 Index = 0; Index < 256; ++Index)
    {
        Audio::FCaptureDeviceInfo Info{};
        if (Capture.GetCaptureDeviceInfo(Info, Index) && Info.InputChannels > 0 && Info.DeviceId == RequestedId)
        {
            Selected = Info;
            BackendIndex = Index;
            break;
        }
    }
    if (BackendIndex == INDEX_NONE || Selected.PreferredSampleRate < 8000 || Selected.PreferredSampleRate > 192000 || Selected.InputChannels > 32)
        return Finish(TEXT("Capture backend identity or audio format could not be validated"), 2);
    Result->SetObjectField(TEXT("selected_device"), DeviceJson(Selected));
    Result->SetNumberField(TEXT("backend_device_index"), BackendIndex);
    Result->SetNumberField(TEXT("capture_device_index"), CaptureIndex);
    const int32 Rate = Selected.PreferredSampleRate;
    TArray<float> Samples;
    Samples.SetNumUninitialized(static_cast<int32>(static_cast<int64>(Rate) * (DurationMs + 500) / 1000));
    std::atomic<int32> Frames{0}, Overflows{0}, Dropped{0};
    std::atomic<int32> Phase{0}, StartupFrames{0}, StartupDiscontinuities{0};
    std::atomic<bool> BadFormat{false};
    Audio::FAudioCaptureDeviceParams StreamParams;
    StreamParams.DeviceIndex = CaptureIndex;
    StreamParams.NumInputChannels = Selected.InputChannels;
    StreamParams.SampleRate = Rate;
    StreamParams.PCMAudioEncoding = Audio::EPCMAudioEncoding::FLOATING_POINT_32;
    const bool Opened = Capture.OpenAudioCaptureStream(StreamParams,
        [&](const void* Buffer, int32 NumFrames, int32 Channels, int32 SampleRate, double, bool Overflow)
        {
            // A preallocated mono buffer; no lock, allocation, logging or file IO
            // on the native capture callback. Analysis runs after stream closure.
            if (!Buffer || Channels != Selected.InputChannels || SampleRate != Rate || NumFrames < 0)
            { BadFormat.store(true); return; }
            const int32 CurrentPhase = Phase.load();
            if (CurrentPhase == 0)
            {
                StartupFrames.fetch_add(NumFrames);
                if (Overflow) StartupDiscontinuities.fetch_add(1);
                return;
            }
            if (CurrentPhase != 1) return;
            if (Overflow) Overflows.fetch_add(1);
            const auto* Input = static_cast<const float*>(Buffer);
            const int32 Start = Frames.load();
            const int32 Take = FMath::Min(NumFrames, Samples.Num() - Start);
            for (int32 Frame = 0; Frame < Take; ++Frame)
            {
                double Sum = 0.0;
                for (int32 Channel = 0; Channel < Channels; ++Channel) Sum += Input[Frame * Channels + Channel];
                const double Mono = Sum / Channels;
                if (!std::isfinite(Mono)) { BadFormat.store(true); return; }
                Samples[Start + Frame] = static_cast<float>(Mono);
            }
            Frames.store(Start + Take);
            Dropped.fetch_add(NumFrames - Take);
        }, 480);
    if (!Opened) return Finish(TEXT("UE5 could not open the selected input stream"), 2);
    Audio::FCaptureDeviceInfo Current{};
    if (!Capture.GetCaptureDeviceInfo(Current, BackendIndex) || Current.DeviceId != RequestedId || !Capture.StartStream())
    { Capture.CloseStream(); return Finish(TEXT("Capture identity changed or native stream startup failed"), 2); }
    // Fixed acquisition warm-up, before the sender is told to emit its tone.
    // Preserve startup discontinuities separately; every discontinuity during
    // the measured interval still fails capture. No threshold/retry adjustment.
    FPlatformProcess::Sleep(0.25f);
    Phase.store(1);
    const auto Ready = MakeShared<FJsonObject>();
    Ready->SetStringField(TEXT("event"), TEXT("recording"));
    Ready->SetStringField(TEXT("device_id"), RequestedId);
    Emit(Ready);
    FPlatformProcess::Sleep(DurationMs / 1000.0f);
    Phase.store(2);
    const bool Stopped = Capture.StopStream();
    const bool Closed = Capture.CloseStream();
    const int32 Count = Frames.load();
    Result->SetNumberField(TEXT("captured_frames"), Count);
    Result->SetNumberField(TEXT("warmup_ms"), 250);
    Result->SetNumberField(TEXT("startup_frames"), StartupFrames.load());
    Result->SetNumberField(TEXT("startup_discontinuities"), StartupDiscontinuities.load());
    Result->SetNumberField(TEXT("sample_rate"), Rate);
    Result->SetNumberField(TEXT("overflow_callbacks"), Overflows.load());
    Result->SetNumberField(TEXT("dropped_frames"), Dropped.load());
    Result->SetBoolField(TEXT("stream_closed"), Closed && !Capture.IsStreamOpen());
    if (!Stopped || !Closed || BadFormat.load() || Count < Rate / 10 || Overflows.load() || Dropped.load())
        return Finish(TEXT("Native capture was incomplete, overflowed, or could not close cleanly"), 2);
    double Peak = 0.0, SquareSum = 0.0;
    for (int32 I = 0; I < Count; ++I) { const double Sample = Samples[I]; Peak = FMath::Max(Peak, std::abs(Sample)); SquareSum += Sample * Sample; }
    Result->SetNumberField(TEXT("peak"), Peak);
    Result->SetNumberField(TEXT("rms"), std::sqrt(SquareSum / Count));
    Result->SetObjectField(TEXT("program_tone"), Tone(Samples, Count, Rate, 997.0));
    Result->SetObjectField(TEXT("client_tone"), Tone(Samples, Count, Rate, 1499.0));
    Result->SetBoolField(TEXT("capture_success"), true);
    return Finish(TEXT(""), 0);
}
