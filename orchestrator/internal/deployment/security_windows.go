//go:build windows

package deployment

import (
	"fmt"
	"golang.org/x/sys/windows"
	"os"
	"unsafe"
)

var querySessionInformation = windows.NewLazySystemDLL("wtsapi32.dll").NewProc("WTSQuerySessionInformationW")

func sessionValue(session, class uint32) ([]byte, error) {
	var pointer *byte
	var size uint32
	ok, _, err := querySessionInformation.Call(0, uintptr(session), uintptr(class), uintptr(unsafe.Pointer(&pointer)), uintptr(unsafe.Pointer(&size)))
	if ok == 0 {
		return nil, fmt.Errorf("query interactive session: %w", err)
	}
	defer windows.WTSFreeMemory(uintptr(unsafe.Pointer(pointer)))
	if pointer == nil || size == 0 || size > 65536 {
		return nil, fmt.Errorf("invalid interactive session information")
	}
	return append([]byte(nil), unsafe.Slice(pointer, size)...), nil
}

func sessionString(session, class uint32) (string, error) {
	data, err := sessionValue(session, class)
	if err != nil {
		return "", err
	}
	if len(data)%2 != 0 {
		return "", fmt.Errorf("invalid session string")
	}
	text := make([]uint16, len(data)/2)
	for i := range text {
		text[i] = uint16(data[2*i]) | uint16(data[2*i+1])<<8
	}
	return windows.UTF16ToString(text), nil
}

func renderSID(session uint32) (string, error) {
	if session == 0 || session == ^uint32(0) {
		return "", fmt.Errorf("a logged-in interactive session is required")
	}
	state, err := sessionValue(session, 8) // WTSConnectState
	if err != nil {
		return "", err
	}
	if len(state) != 4 || state[0] != 0 || state[1] != 0 || state[2] != 0 || state[3] != 0 {
		return "", fmt.Errorf("render session must be active")
	}
	name, err := sessionString(session, 5) // WTSUserName
	if err != nil {
		return "", err
	}
	domain, err := sessionString(session, 7) // WTSDomainName
	if err != nil {
		return "", err
	}
	if name == "" {
		return "", fmt.Errorf("render session has no user")
	}
	if domain != "" {
		name = domain + `\` + name
	}
	sid, _, kind, err := windows.LookupSID("", name)
	if err != nil {
		return "", err
	}
	if kind != windows.SidTypeUser {
		return "", fmt.Errorf("render identity is not a user account")
	}
	return sid.String(), nil
}

func validateRenderUser(session uint32, expected string) error {
	sid, err := renderSID(session)
	if err != nil {
		return err
	}
	if sid != expected {
		return fmt.Errorf("selected SID does not own the active render session")
	}
	return nil
}

// CurrentRenderIdentity resolves the desktop user, not the elevated installer's
// account. This also handles elevation with another administrator's credentials.
func CurrentRenderIdentity() (uint32, string, error) {
	var session uint32
	if err := windows.ProcessIdToSessionId(uint32(os.Getpid()), &session); err != nil {
		return 0, "", err
	}
	sid, err := renderSID(session)
	return session, sid, err
}

func requireAdministrator() error {
	if !windows.GetCurrentProcessToken().IsElevated() {
		return fmt.Errorf("platform setup requires the installer's administrator elevation")
	}
	return nil
}

func protectDirectory(directory, sid string, media bool) error {
	user, err := windows.StringToSid(sid)
	if err != nil {
		return err
	}
	permission := "(A;;0x20;;;" + user.String() + ")" // traverse only, not inherited
	if media {
		permission = "(A;OICI;FA;;;" + user.String() + ")"
	}
	descriptor, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)" + permission)
	if err != nil {
		return err
	}
	dacl, _, err := descriptor.DACL()
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(directory, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil)
}
