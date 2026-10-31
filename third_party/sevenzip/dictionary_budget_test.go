package sevenzip

import (
	"errors"
	"io"
	"testing"

	"github.com/bodgit/sevenzip/internal/limits"
)

type forbiddenDictionaryInput struct{ t *testing.T }

func (r forbiddenDictionaryInput) ReadAt([]byte, int64) (int, error) {
	r.t.Fatal("dictionary admission read compressed input")
	return 0, io.EOF
}

func TestFolderDictionaryBudget(t *testing.T) {
	lzma64 := &coder{id: []byte{3, 1, 1}, properties: []byte{0x5d, 0, 0, 0, 4}}
	lzma2_64 := &coder{id: []byte{0x21}, properties: []byte{28}}
	ppmd64 := &coder{id: []byte{3, 4, 1}, properties: []byte{6, 0, 0, 0, 4}}
	for _, tc := range []struct {
		name   string
		coders []*coder
		want   error
	}{
		{"exact_limit_mixed", []*coder{lzma64, lzma2_64}, nil},
		{"exact_limit_ppmd", []*coder{ppmd64, ppmd64}, nil},
		{"mixed_over_limit", []*coder{lzma64, lzma2_64, ppmd64}, limits.ErrDictionaryBudget},
		{"repeated_over_limit", []*coder{lzma2_64, lzma2_64, lzma2_64}, limits.ErrDictionaryBudget},
		{"minimum_lzma_counts", []*coder{lzma64, ppmd64, {id: []byte{3, 1, 1}, properties: []byte{0x5d, 0, 0, 0, 0}}}, limits.ErrDictionaryBudget},
		{"single_over_limit", []*coder{{id: []byte{0x21}, properties: []byte{40}}}, limits.ErrDictionary},
		{"filters", []*coder{{id: []byte{0}}, {id: []byte{3}}}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &folder{coder: tc.coders}
			if err := f.validateDictionaryBudget(); !errors.Is(err, tc.want) {
				t.Fatalf("got %v, want %v", err, tc.want)
			}
			if tc.want != nil {
				// Deliberately omit stream geometry: admission must precede
				// both stream setup and construction of the first decoder.
				si := &streamsInfo{unpackInfo: &unpackInfo{folder: []*folder{f}}}
				r, _, _, err := si.folderReader(forbiddenDictionaryInput{t}, 0, "")
				if r != nil || !errors.Is(err, tc.want) {
					t.Fatalf("reader=%v error=%v", r, err)
				}
			}
		})
	}
}

func TestFolderRejectsMalformedDictionaryProperties(t *testing.T) {
	for _, id := range [][]byte{{3, 1, 1}, {0x21}, {3, 4, 1}} {
		si := &streamsInfo{unpackInfo: &unpackInfo{folder: []*folder{{coder: []*coder{{id: id}}}}}}
		if r, _, _, err := si.folderReader(forbiddenDictionaryInput{t}, 0, ""); err == nil || r != nil {
			t.Fatalf("id=%x reader=%v error=%v", id, r, err)
		}
	}
}
