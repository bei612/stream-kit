package deployment

import (
	"crypto/rand"
	"fmt"
	"regexp"
	"runtime"
)

// VirtualAudioIdentity is supplied by the product's deployment profile. A
// customer installation generates its own stable serial, never a test identity.
type VirtualAudioIdentity struct {
	VendorID     int    `json:"vendor_id"`
	ProductID    int    `json:"product_id"`
	SerialPrefix string `json:"serial_prefix,omitempty"`
}

var audioSerialPrefix = regexp.MustCompile(`^(?:[A-Za-z0-9._+-]+@)?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+:$`)

func (identity VirtualAudioIdentity) validate() error {
	if identity.VendorID < 1 || identity.VendorID > 65534 || identity.ProductID < 1 || identity.ProductID > 65534 {
		return fmt.Errorf("virtual audio requires explicit vendor and product IDs in 1..65534")
	}
	if identity.SerialPrefix != "" && (len(identity.SerialPrefix) > 111 || !audioSerialPrefix.MatchString(identity.SerialPrefix)) {
		return fmt.Errorf("virtual audio serial prefix requires a domain or email followed by a colon, up to 111 ASCII characters")
	}
	if identity.VendorID == 0x16c0 && identity.ProductID == 0x27e0 && identity.SerialPrefix == "" {
		return fmt.Errorf("shared Audio class identity requires an owner-controlled domain/email serial prefix")
	}
	return nil
}

func (o Options) validateVirtualAudio() error {
	if o.VirtualAudio == nil {
		return nil
	}
	if runtime.GOOS != "windows" {
		return fmt.Errorf("USB virtual audio provisioning requires Windows")
	}
	return o.VirtualAudio.validate()
}

func configureVirtualAudio(gateway map[string]any, identity *VirtualAudioIdentity) error {
	if identity == nil {
		return nil
	}
	if err := identity.validate(); err != nil {
		return err
	}
	if _, supported := gateway["virtual_audio"]; !supported {
		return fmt.Errorf("gateway does not support managed virtual audio configuration")
	}
	gateway["virtual_audio"] = struct {
		VendorID  int    `json:"vendor_id"`
		ProductID int    `json:"product_id"`
		Serial    string `json:"serial"`
	}{identity.VendorID, identity.ProductID, identity.SerialPrefix + rand.Text()[:15]}
	return nil
}
