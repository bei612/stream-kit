package sevenzip_test

import (
	"errors"
	"github.com/bodgit/sevenzip/internal/limits"
	"github.com/bodgit/sevenzip/internal/lzma"
	"github.com/bodgit/sevenzip/internal/lzma2"
	"github.com/bodgit/sevenzip/internal/ppmd"
	"io"
	"testing"
)

type unreadableDictionarySource struct{ t *testing.T }

func (r unreadableDictionarySource) Read([]byte) (int, error) {
	r.t.Error("oversized dictionary reached compressed input")
	return 0, io.EOF
}
func (r unreadableDictionarySource) Close() error { return nil }

func TestDecoderDictionaryRejectedBeforeReading(t *testing.T) {
	for _, test := range []struct {
		name  string
		props []byte
		open  func([]byte, uint64, []io.ReadCloser) (io.ReadCloser, error)
	}{
		{"lzma", []byte{0x5d, 0xff, 0xff, 0xff, 0xff}, lzma.NewReader},
		{"lzma2", []byte{40}, lzma2.NewReader},
		{"lzma2_above_limit", []byte{31}, lzma2.NewReader},
		{"ppmd", []byte{6, 0xff, 0xff, 0xff, 0xff}, ppmd.NewReader},
	} {
		t.Run(test.name, func(t *testing.T) {
			r, err := test.open(test.props, 1, []io.ReadCloser{unreadableDictionarySource{t}})
			if r != nil || !errors.Is(err, limits.ErrDictionary) {
				t.Fatalf("reader=%v error=%v", r, err)
			}
		})
	}
	if limits.Dictionary(limits.DictionaryBytes) != nil || !errors.Is(limits.Dictionary(limits.DictionaryBytes+1), limits.ErrDictionary) {
		t.Fatal("incorrect dictionary boundary")
	}
}
