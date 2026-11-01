package deployment

import (
	"crypto/rand"
	"fmt"
	"runtime"
)

// VirtualAudioIdentity is supplied by the product's deployment profile. A
// customer installation generates its own stable serial, never a test identity.
type VirtualAudioIdentity struct {
	VendorID  int `json:"vendor_id"`
	ProductID int `json:"product_id"`
}

func (o Options) validateVirtualAudio() error {
	if o.VirtualAudio == nil {
		return nil
	}
	if runtime.GOOS != "windows" {
		return fmt.Errorf("USB virtual audio provisioning requires Windows")
	}
	if o.VirtualAudio.VendorID < 1 || o.VirtualAudio.VendorID > 65534 || o.VirtualAudio.ProductID < 1 || o.VirtualAudio.ProductID > 65534 {
		return fmt.Errorf("virtual audio requires explicit vendor and product IDs in 1..65534")
	}
	return nil
}

func configureVirtualAudio(gateway map[string]any, identity *VirtualAudioIdentity) error {
	if identity == nil {
		return nil
	}
	if _, supported := gateway["virtual_audio"]; !supported {
		return fmt.Errorf("gateway does not support managed virtual audio configuration")
	}
	gateway["virtual_audio"] = struct {
		VirtualAudioIdentity
		Serial string `json:"serial"`
	}{*identity, rand.Text()[:15]}
	return nil
}
