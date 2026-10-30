package identity

import (
	"strings"
	"testing"
	"time"
)

func TestCredentialKindsCannotBeSubstituted(t *testing.T) {
	now := time.Unix(1700000000, 0)
	key := []byte("test-secret")
	claims := Claims{Subject: "guest", SessionID: "s", ConnectionID: "c", IssuedAt: now.Unix(), ExpiresAt: now.Add(time.Minute).Unix()}
	for _, kind := range []string{Management, Invitation, Connection, Media} {
		token := Sign(kind, claims, key)
		for _, audience := range []string{Management, Invitation, Connection, Media} {
			var decoded Claims
			err := Decode(token, audience, key, &decoded)
			if (err == nil) != (kind == audience) {
				t.Fatalf("%s accepted as %s: %v", kind, audience, err)
			}
		}
	}
}

func TestConnectionValidationRejectsExpiredFutureLongLivedAndMalformed(t *testing.T) {
	now := time.Unix(1700000000, 0)
	key := DeriveKey([]byte("secret"), Connection)
	base := Claims{Subject: "guest", SessionID: "s", ConnectionID: "c", IssuedAt: now.Unix(), ExpiresAt: now.Add(time.Minute).Unix()}
	if _, err := Verify(Sign(Connection, base, key), Connection, key, now); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*Claims){
		func(c *Claims) { c.ExpiresAt = now.Unix() },
		func(c *Claims) { c.IssuedAt = now.Unix() + 6 },
		func(c *Claims) { c.ExpiresAt = now.Unix() + 901 },
		func(c *Claims) { c.Subject = "" },
		func(c *Claims) { c.ConnectionID = "" },
		func(c *Claims) { c.SessionID = "" },
	} {
		c := base
		mutate(&c)
		if _, err := Verify(Sign(Connection, c, key), Connection, key, now); err == nil {
			t.Fatal("invalid credential accepted")
		}
	}
	token := Sign(Connection, base, key)
	for _, bad := range []string{"", token + ".extra", strings.Repeat("x", 8193), token[:len(token)-3] + "xxx"} {
		if _, err := Verify(bad, Connection, key, now); err == nil {
			t.Fatal("malformed credential accepted")
		}
	}
	if _, err := Verify(token, Connection, DeriveKey([]byte("secret"), Invitation), now); err == nil {
		t.Fatal("other purpose key accepted")
	}
	if _, err := Verify(token, Connection, nil, now); err == nil {
		t.Fatal("empty key accepted")
	}
}
