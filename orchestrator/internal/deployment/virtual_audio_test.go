package deployment

import (
	"encoding/json"
	"runtime"
	"testing"
)

func TestVirtualAudioConfigurationRequiresSupportedGatewayAndFreshSerial(t *testing.T) {
	identity := &VirtualAudioIdentity{VendorID: 65534, ProductID: 1}
	if err := configureVirtualAudio(map[string]any{}, identity); err == nil {
		t.Fatal("older gateway silently accepted virtual audio")
	}
	serials := map[string]bool{}
	for range 2 {
		gateway := map[string]any{"virtual_audio": nil}
		if err := configureVirtualAudio(gateway, identity); err != nil {
			t.Fatal(err)
		}
		first, err := json.Marshal(gateway["virtual_audio"])
		if err != nil {
			t.Fatal(err)
		}
		var device struct {
			VirtualAudioIdentity
			Serial string `json:"serial"`
		}
		if err := json.Unmarshal(first, &device); err != nil || device.VirtualAudioIdentity != *identity || len(device.Serial) != 15 || serials[device.Serial] {
			t.Fatal("installation identity was not preserved/uniquely generated", err)
		}
		for _, ch := range device.Serial {
			if !((ch >= 'A' && ch <= 'Z') || (ch >= '2' && ch <= '7')) {
				t.Fatal("serial is not a bounded USB-safe identifier")
			}
		}
		serials[device.Serial] = true
		if err := configureVirtualAudio(gateway, nil); err != nil {
			t.Fatal(err)
		}
		second, _ := json.Marshal(gateway["virtual_audio"])
		if string(first) != string(second) {
			t.Fatal("default initialization replaced explicit audio configuration")
		}
	}
}

func TestVirtualAudioDeploymentRejectsInvalidOrUnsupportedIdentities(t *testing.T) {
	if err := (Options{}).validateVirtualAudio(); err != nil {
		t.Fatal(err)
	}
	options := Options{VirtualAudio: &VirtualAudioIdentity{VendorID: 65534, ProductID: 1}}
	if (options.validateVirtualAudio() == nil) != (runtime.GOOS == "windows") {
		t.Fatal("platform policy differs from native provider")
	}
	for _, pair := range [][2]int{{0, 1}, {1, 0}, {-1, 1}, {65535, 1}, {1, 65536}} {
		options.VirtualAudio = &VirtualAudioIdentity{VendorID: pair[0], ProductID: pair[1]}
		if options.validateVirtualAudio() == nil {
			t.Fatal("invalid deployment identity accepted")
		}
	}
}
