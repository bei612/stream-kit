package sevenzip

import (
	"bytes"
	"errors"
	"io"
	"io/fs"
	"testing"

	"github.com/bodgit/sevenzip/internal/pool"
)

type closeTestReader struct {
	*bytes.Reader
	closes    int
	seekError error
}

func (r *closeTestReader) Close() error { r.closes++; return nil }
func (r *closeTestReader) Seek(offset int64, whence int) (int64, error) {
	if r.seekError != nil {
		return 0, r.seekError
	}
	return r.Reader.Seek(offset, whence)
}

func TestReaderCloseDrainsPoolAndRejectsFileOpen(t *testing.T) {
	p, _ := pool.NewPool()
	decoder := &closeTestReader{Reader: bytes.NewReader([]byte("abc"))}
	_, _ = p.Put(0, decoder)
	z := &Reader{pool: []pool.Pooler{p}}
	file := &File{zip: z, folder: 0}
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	if decoder.closes != 1 {
		t.Fatal("decoder not closed once")
	}
	if _, err := file.Open(); !errors.Is(err, fs.ErrClosed) {
		t.Fatal(err)
	}
}

func TestFileSeekFailuresReleaseDecoder(t *testing.T) {
	for _, opening := range []bool{false, true} {
		p, _ := pool.NewPool()
		failure := errors.New("seek failed")
		decoder := &closeTestReader{Reader: bytes.NewReader([]byte("abc")), seekError: failure}
		z := &Reader{pool: []pool.Pooler{p}}
		defer z.Close()
		file := &File{zip: z, folder: 0}
		var err error
		if opening {
			_, _ = p.Put(0, decoder)
			_, err = file.Open()
		} else {
			r := &fileReader{rc: decoder, f: file, n: 3}
			err = r.Close()
			if second := r.Close(); second != nil {
				t.Fatal(second)
			}
		}
		if !errors.Is(err, failure) || decoder.closes != 1 {
			t.Fatalf("opening=%v closes=%d error=%v", opening, decoder.closes, err)
		}
	}
}

func TestCheckedOutFileClosesAfterArchive(t *testing.T) {
	p, _ := pool.NewPool()
	decoder := &closeTestReader{Reader: bytes.NewReader([]byte("abc"))}
	z := &Reader{pool: []pool.Pooler{p}}
	file := &File{zip: z, folder: 0}
	r := &fileReader{rc: decoder, f: file, n: 3}
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	var b [1]byte
	if _, err := io.ReadFull(r, b[:]); err != nil {
		t.Fatal(err)
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	if decoder.closes != 1 {
		t.Fatal("late file return leaked")
	}
}
