package audiodevice

import (
	"fmt"
	"strings"
)

// WindowsIdentity is the native provider identity, not an endpoint ID or a
// deployment profile. The native owner supplies its effective configuration.
type WindowsIdentity struct {
	VendorID  uint16 `json:"vendor_id"`
	ProductID uint16 `json:"product_id"`
	Serial    string `json:"serial"`
}

func (id WindowsIdentity) Validate() error {
	if id.VendorID == 0 || id.ProductID == 0 || len(id.Serial) == 0 || len(id.Serial) > 126 {
		return fmt.Errorf("explicit bounded virtual audio identity required")
	}
	for _, c := range id.Serial {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("._@:+-", c)) {
			return fmt.Errorf("invalid virtual audio serial")
		}
	}
	return nil
}

func (id WindowsIdentity) parent() string {
	return fmt.Sprintf(`USB\VID_%04X&PID_%04X\%s`, id.VendorID, id.ProductID, id.Serial)
}
