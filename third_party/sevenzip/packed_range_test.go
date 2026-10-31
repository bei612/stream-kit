package sevenzip

import (
	"bytes"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"math"
	"testing"
)

func TestPackedRangeBounds(t *testing.T) {
	for _, tc := range []struct {
		name      string
		available int64
		position  uint64
		sizes     []uint64
		valid     bool
	}{
		{"exact", 10, 2, []uint64{3, 5}, true},
		{"unused trailing bytes", 11, 2, []uint64{3, 5}, true},
		{"last stream truncated", 9, 2, []uint64{3, 5}, false},
		{"offset outside data", 9, 10, nil, false},
		{"empty at end", 9, 9, []uint64{0}, true},
		{"unsigned offset", 9, math.MaxUint64, nil, false},
		{"unsigned size", 9, 0, []uint64{math.MaxUint64}, false},
		{"sum overflow", math.MaxInt64, 0, []uint64{math.MaxInt64, 1}, false},
		{"negative extent", -1, 0, nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			si := &streamsInfo{packInfo: &packInfo{position: tc.position, size: tc.sizes}}
			if err := si.validatePackedRange(tc.available); (err == nil) != tc.valid {
				t.Fatalf("valid=%v error=%v", tc.valid, err)
			}
		})
	}
}

func TestReaderRejectsMissingPackedDataBeforeDecoder(t *testing.T) {
	for _, encoded := range []bool{false, true} {
		t.Run(map[bool]string{false: "plain", true: "encoded"}[encoded], func(t *testing.T) {
			// A valid Copy stream declares one packed byte but the data region
			// is empty. Both ordinary and compressed headers must be rejected
			// by NewReader, without waiting for File.Open or decoder I/O.
			header := []byte{idHeader, idMainStreamsInfo}
			if encoded {
				header = []byte{idEncodedHeader}
			}
			header = append(header, idPackInfo, 0, 1, idSize, 1, idEnd,
				idUnpackInfo, idFolder, 1, 0, 1, 1, 0, idCodersUnpackSize, 1, idEnd, idEnd)
			if !encoded {
				header = append(header, idEnd)
			}
			data := make([]byte, 32)
			copy(data, []byte{'7', 'z', 0xbc, 0xaf, 0x27, 0x1c, 0, 4})
			binary.LittleEndian.PutUint64(data[20:28], uint64(len(header)))
			binary.LittleEndian.PutUint32(data[28:32], crc32.ChecksumIEEE(header))
			binary.LittleEndian.PutUint32(data[8:12], crc32.ChecksumIEEE(data[12:]))
			data = append(data, header...)
			if _, err := NewReader(bytes.NewReader(data), int64(len(data))); !errors.Is(err, errFormat) {
				t.Fatalf("expected range rejection, got %v", err)
			}
		})
	}
}
