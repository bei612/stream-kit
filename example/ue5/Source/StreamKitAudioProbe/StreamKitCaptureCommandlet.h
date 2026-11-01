#pragma once

#include "Commandlets/Commandlet.h"
#include "StreamKitCaptureCommandlet.generated.h"

UCLASS()
class UStreamKitCaptureCommandlet : public UCommandlet
{
    GENERATED_BODY()
public:
    UStreamKitCaptureCommandlet();
    virtual int32 Main(const FString& Params) override;
};
