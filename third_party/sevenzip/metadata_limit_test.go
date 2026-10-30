package sevenzip

import (
	"bytes"
	"encoding/binary"
	"errors"
	"math"
	"testing"

	"github.com/bodgit/sevenzip/internal/limits"
)

func metadataUint64(value uint64) []byte {
	data := make([]byte, 9)
	data[0] = 0xff
	binary.LittleEndian.PutUint64(data[1:], value)
	return data
}

func TestMetadataCountsRejectedBeforeAllocation(t *testing.T) {
	count := limits.MetadataItems + 1
	if err := checkUint64(limits.MetadataItems, true); err != nil {
		t.Fatal(err)
	}
	for name, parse := range map[string]func() error{
		"files":      func() error { _, e := readFilesInfo(bytes.NewReader(metadataUint64(count))); return e },
		"bools":      func() error { _, e := readOptionalBool(bytes.NewReader([]byte{1}), count); return e },
		"crc":        func() error { _, e := readCRC(bytes.NewReader(nil), count); return e },
		"times":      func() error { _, e := readTimes(bytes.NewReader(nil), count); return e },
		"attributes": func() error { _, e := readAttributes(bytes.NewReader(nil), count); return e },
		"folders":    func() error { _, e := readFolder(bytes.NewReader(metadataUint64(count))); return e },
	} {
		t.Run(name, func(t *testing.T) {
			if err := parse(); !errors.Is(err, limits.ErrMetadata) {
				t.Fatal(err)
			}
		})
	}
}

func TestSubstreamCountCannotOverflowOrExceedMetadataLimit(t *testing.T) {
	for _, counts := range [][2]uint64{{math.MaxUint64, 2}, {limits.MetadataItems, 1}} {
		data := []byte{idNumUnpackStream}
		data = append(data, metadataUint64(counts[0])...)
		data = append(data, metadataUint64(counts[1])...)
		data = append(data, idEnd)
		if _, err := readSubStreamsInfo(bytes.NewReader(data), []*folder{{}, {}}); !errors.Is(err, limits.ErrMetadata) {
			t.Fatal(err)
		}
	}
}

func TestSubstreamSizesCannotUnderflowFolder(t *testing.T) {
	f := &folder{out: 1, size: []uint64{10}}
	for _, test := range []struct {
		sizes []byte
		valid bool
	}{
		{[]byte{4, 6}, true}, {[]byte{4, 7}, false}, {[]byte{11, 0}, false},
	} {
		data := []byte{idNumUnpackStream, 3, idSize}
		data = append(data, test.sizes...)
		data = append(data, idEnd)
		streams, err := readSubStreamsInfo(bytes.NewReader(data), []*folder{f})
		if test.valid {
			if err != nil || streams.size[2] != 0 {
				t.Fatalf("valid exact boundary: %+v %v", streams, err)
			}
		} else if !errors.Is(err, errSubstreamSize) {
			t.Fatalf("invalid sizes accepted: %v", err)
		}
	}
}
