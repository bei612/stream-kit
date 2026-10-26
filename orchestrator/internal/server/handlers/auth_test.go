package handlers

import (
	"testing"
	"time"
)

func TestResolveJWTSecret(t *testing.T) {
	t.Run("dedicated secret", func(t *testing.T) {
		s1 := ResolveJWTSecret("my-secret-key", "password")
		s2 := ResolveJWTSecret("my-secret-key", "different-password")
		if string(s1) != string(s2) {
			t.Error("same jwt_secret should produce same key regardless of password")
		}
	})

	t.Run("empty secret uses password", func(t *testing.T) {
		s1 := ResolveJWTSecret("", "password1")
		s2 := ResolveJWTSecret("", "password2")
		if string(s1) == string(s2) {
			t.Error("different passwords should produce different keys")
		}
	})

	t.Run("key is 32 bytes", func(t *testing.T) {
		s := ResolveJWTSecret("test", "test")
		if len(s) != 32 {
			t.Errorf("expected 32 bytes, got %d", len(s))
		}
	})
}

func TestJWT_SignVerifyRoundTrip(t *testing.T) {
	secret := ResolveJWTSecret("test-secret", "")
	now := time.Now()
	claims := Claims{
		Sub: "admin",
		Iat: now.Unix(),
		Exp: now.Add(1 * time.Hour).Unix(),
	}

	token := signJWT(claims, secret)
	got, err := VerifyJWT(token, secret)
	if err != nil {
		t.Fatalf("verify failed: %v", err)
	}
	if got.Sub != "admin" {
		t.Errorf("Sub: want admin, got %s", got.Sub)
	}
	if got.Iat != claims.Iat {
		t.Errorf("Iat mismatch")
	}
	if got.Exp != claims.Exp {
		t.Errorf("Exp mismatch")
	}
}

func TestJWT_Expired(t *testing.T) {
	secret := ResolveJWTSecret("test", "")
	claims := Claims{Sub: "admin", Iat: time.Now().Add(-2 * time.Hour).Unix(), Exp: time.Now().Add(-1 * time.Hour).Unix()}
	token := signJWT(claims, secret)
	_, err := VerifyJWT(token, secret)
	if err == nil {
		t.Error("expected expiry error")
	}
}

func TestJWT_WrongSecret(t *testing.T) {
	s1 := ResolveJWTSecret("secret1", "")
	s2 := ResolveJWTSecret("secret2", "")
	claims := Claims{Sub: "admin", Iat: time.Now().Unix(), Exp: time.Now().Add(time.Hour).Unix()}
	token := signJWT(claims, s1)
	_, err := VerifyJWT(token, s2)
	if err == nil {
		t.Error("expected invalid signature error")
	}
}

func TestJWT_TamperedPayload(t *testing.T) {
	secret := ResolveJWTSecret("test", "")
	claims := Claims{Sub: "admin", Iat: time.Now().Unix(), Exp: time.Now().Add(time.Hour).Unix()}
	token := signJWT(claims, secret)
	// Flip a character in the payload (second segment)
	bytes := []byte(token)
	for i := len(bytes) / 2; i < len(bytes); i++ {
		if bytes[i] == '.' {
			break
		}
		bytes[i] = 'X'
		break
	}
	_, err := VerifyJWT(string(bytes), secret)
	if err == nil {
		t.Error("expected error for tampered token")
	}
}

func TestJWT_Malformed(t *testing.T) {
	secret := ResolveJWTSecret("test", "")
	cases := []string{"", "onlyone", "two.parts", "a.b.c.d"}
	for _, tc := range cases {
		_, err := VerifyJWT(tc, secret)
		if err == nil {
			t.Errorf("expected error for malformed token %q", tc)
		}
	}
}

func TestRateLimiter(t *testing.T) {
	t.Run("within limit", func(t *testing.T) {
		rl := newRateLimiter(3, 5*time.Minute)
		for i := 0; i < 3; i++ {
			if !rl.allow("1.2.3.4") {
				t.Errorf("request %d should be allowed", i+1)
			}
		}
	})

	t.Run("exceeds limit", func(t *testing.T) {
		rl := newRateLimiter(3, 5*time.Minute)
		for i := 0; i < 3; i++ {
			rl.allow("1.2.3.4")
		}
		if rl.allow("1.2.3.4") {
			t.Error("4th request should be rejected")
		}
	})

	t.Run("different IPs independent", func(t *testing.T) {
		rl := newRateLimiter(1, 5*time.Minute)
		rl.allow("1.1.1.1")
		if !rl.allow("2.2.2.2") {
			t.Error("different IP should have independent counter")
		}
	})

	t.Run("window reset", func(t *testing.T) {
		rl := newRateLimiter(1, 50*time.Millisecond)
		rl.allow("1.2.3.4")
		if rl.allow("1.2.3.4") {
			t.Error("should be rejected before window reset")
		}
		time.Sleep(60 * time.Millisecond)
		if !rl.allow("1.2.3.4") {
			t.Error("should be allowed after window reset")
		}
	})
}
