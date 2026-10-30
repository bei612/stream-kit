package pool

import (
	"bytes"
	"errors"
	"testing"
)

type ownedReader struct {
	*bytes.Reader
	closes int
	err    error
}

func (r *ownedReader) Close() error { r.closes++; return r.err }

func TestCloseReleasesCacheAndLateReturns(t *testing.T) {
	p, _ := NewPool()
	first := &ownedReader{Reader: bytes.NewReader([]byte("first"))}
	duplicate := &ownedReader{Reader: bytes.NewReader(nil)}
	if _, err := p.Put(0, first); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Put(0, duplicate); err != nil {
		t.Fatal(err)
	}
	if duplicate.closes != 1 || first.closes != 0 {
		t.Fatal("duplicate ownership leaked")
	}
	checked, ok := p.Get(0)
	if !ok || checked != first {
		t.Fatal("missing checked out reader")
	}
	cached := &ownedReader{Reader: bytes.NewReader(nil)}
	if _, err := p.Put(1, cached); err != nil {
		t.Fatal(err)
	}
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	if cached.closes != 1 || first.closes != 0 {
		t.Fatal("incorrect pool ownership")
	}
	if _, err := p.Put(0, checked); err != nil {
		t.Fatal(err)
	}
	if first.closes != 1 {
		t.Fatal("late return leaked")
	}
	if r, ok := p.Get(1); ok || r != nil {
		t.Fatal("closed pool returned a reader")
	}
}

func TestCloseContinuesAfterDecoderFailure(t *testing.T) {
	p, _ := NewPool()
	p.(*pool).size = 2
	failure := errors.New("close failed")
	a := &ownedReader{Reader: bytes.NewReader(nil), err: failure}
	b := &ownedReader{Reader: bytes.NewReader(nil)}
	_, _ = p.Put(0, a)
	_, _ = p.Put(1, b)
	if err := p.Close(); !errors.Is(err, failure) {
		t.Fatal(err)
	}
	if a.closes != 1 || b.closes != 1 {
		t.Fatal("cleanup stopped early")
	}
}
