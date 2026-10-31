package sevenzip

import (
	"bytes"
	"errors"
	"math"
	"reflect"
	"testing"
)

func TestFolderBindingIndicesValidatedDuringParsing(t *testing.T) {
	for _, tc := range []struct {
		name  string
		pairs []byte
		valid bool
	}{
		{"chain", []byte{1, 0, 2, 1}, true},
		{"input outside folder", []byte{3, 0, 2, 1}, false},
		{"output outside folder", []byte{1, 3, 2, 1}, false},
		{"duplicate input", []byte{1, 0, 1, 1}, false},
		{"duplicate output", []byte{1, 0, 2, 0}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Three single-input/single-output Copy coders, then two bindings.
			data := append([]byte{3, 1, 0, 1, 0, 1, 0}, tc.pairs...)
			f, err := readFolder(bytes.NewReader(data))
			if tc.valid {
				if err != nil || !reflect.DeepEqual(f.packed, []uint64{0}) {
					t.Fatalf("folder=%+v error=%v", f, err)
				}
			} else if !errors.Is(err, errInvalidBindPair) {
				t.Fatalf("invalid binding accepted: %v", err)
			}
		})
	}
}

func TestPackedInputsCannotEscapeOrOverlap(t *testing.T) {
	for _, tc := range []struct {
		name   string
		header []byte
		packed []uint64
		valid  bool
	}{
		{"permuted inputs", []byte{1, 0x11, 0, 3, 1}, []uint64{2, 0, 1}, true},
		{"out of range", []byte{1, 0x11, 0, 3, 1}, []uint64{0, 1, 3}, false},
		{"integer overflow", []byte{1, 0x11, 0, 3, 1}, []uint64{0, 1, math.MaxUint64}, false},
		{"duplicate packed input", []byte{1, 0x11, 0, 3, 1}, []uint64{0, 0, 2}, false},
		{"bound input reused", []byte{2, 0x11, 0, 2, 1, 1, 0, 2, 0}, []uint64{2, 0}, false},
		{"distinct bound and packed", []byte{2, 0x11, 0, 2, 1, 1, 0, 2, 0}, []uint64{0, 1}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			data := append([]byte{}, tc.header...)
			for _, index := range tc.packed {
				data = append(data, metadataUint64(index)...)
			}
			f, err := readFolder(bytes.NewReader(data))
			if tc.valid {
				if err != nil || !reflect.DeepEqual(f.packed, tc.packed) {
					t.Fatalf("folder=%+v error=%v", f, err)
				}
			} else if !errors.Is(err, errInvalidBindPair) {
				t.Fatalf("invalid packed inputs accepted: %v", err)
			}
		})
	}
}
