package audiodevice

import (
	"strings"
	"testing"
)

func TestNativeWindowsIdentityBoundary(t *testing.T) {
	for _, serial := range []string{"owner@example.org:Device123", strings.Repeat("a", 126)} {
		if err := (WindowsIdentity{VendorID: 5824, ProductID: 10208, Serial: serial}).Validate(); err != nil {
			t.Fatal(err)
		}
	}
	for _, serial := range []string{"", "设备", "bad/serial", "bad\\serial", "bad,serial", strings.Repeat("a", 127)} {
		if (WindowsIdentity{VendorID: 5824, ProductID: 10208, Serial: serial}).Validate() == nil {
			t.Fatalf("accepted invalid serial %q", serial)
		}
	}
	if (WindowsIdentity{Serial: "valid"}).Validate() == nil {
		t.Fatal("missing VID/PID accepted")
	}
}
