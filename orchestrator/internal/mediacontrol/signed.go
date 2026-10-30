package mediacontrol

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
)

const controlSignatureHeader = "X-Stream-Control-Signature"

// Each operation supplies a distinct protocol domain; signatures cannot be
// reused between configuration, device inventory or their responses.
func controlSignature(secret []byte, domain string, body []byte) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(domain))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}
