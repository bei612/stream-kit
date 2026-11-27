//go:build windows

package audiodevice

import "testing"

func TestEndpointPoliciesPreserveDefaultSelectionRoles(t *testing.T) {
	if LegacyRenderPolicy.mask() != 0x107 {
		t.Fatal("rollback must restore the exact render-only policy")
	}
	if CurrentEndpointPolicy.mask() != 0x307 {
		t.Fatal("the virtual device must be excluded for all input and output default roles")
	}
}
