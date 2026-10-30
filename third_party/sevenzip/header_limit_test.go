package sevenzip

import (
	"bytes"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"math"
	"testing"

	"github.com/bodgit/sevenzip/internal/limits"
)

func TestHeaderRangeRejectedBeforeParsing(t *testing.T) {
	for _, c := range []struct {
		name         string
		offset, size uint64
		want         error
	}{
		{"over_budget", 0, limits.HeaderBytes + 1, limits.ErrHeader},
		{"offset_overflow", math.MaxUint64, 1, errFormat},
		{"offset_outside_input", 1, 1, errFormat},
		{"size_outside_input", 0, 1, errFormat},
	} {
		t.Run(c.name, func(t *testing.T) {
			data := make([]byte, 32)
			copy(data, []byte{'7', 'z', 0xbc, 0xaf, 0x27, 0x1c, 0, 4})
			binary.LittleEndian.PutUint64(data[12:20], c.offset)
			binary.LittleEndian.PutUint64(data[20:28], c.size)
			binary.LittleEndian.PutUint32(data[8:12], crc32.ChecksumIEEE(data[12:]))
			if _, err := NewReader(bytes.NewReader(data), int64(len(data))); !errors.Is(err, c.want) {
				t.Fatalf("got %v want %v", err, c.want)
			}
		})
	}
}

func TestEncodedHeaderBudgetRejectedBeforeDecode(t *testing.T) {
	// A Copy coder declares an oversized decoded header without supplying any
	// packed bytes. The resource error must precede opening that decoder.
	header := []byte{idEncodedHeader, idPackInfo, 0, 1, idSize, 0, idEnd,
		idUnpackInfo, idFolder, 1, 0, 1, 1, 0, idCodersUnpackSize, 0xff}
	header = binary.LittleEndian.AppendUint64(header, limits.HeaderBytes+1)
	header = append(header, idEnd, idEnd)
	data := make([]byte, 32)
	copy(data, []byte{'7', 'z', 0xbc, 0xaf, 0x27, 0x1c, 0, 4})
	binary.LittleEndian.PutUint64(data[20:28], uint64(len(header)))
	binary.LittleEndian.PutUint32(data[28:32], crc32.ChecksumIEEE(header))
	binary.LittleEndian.PutUint32(data[8:12], crc32.ChecksumIEEE(data[12:]))
	data = append(data, header...)
	if _, err := NewReader(bytes.NewReader(data), int64(len(data))); !errors.Is(err, limits.ErrHeader) {
		t.Fatalf("got %v want header resource error", err)
	}
}
