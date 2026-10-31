package sevenzip

import (
	"bytes"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"math"
	"reflect"
	"testing"

	"github.com/bodgit/sevenzip/internal/limits"
)

func TestMetadataBudgetAccumulatesAcrossReaders(t *testing.T) {
	budget := &metadataBudget{remaining: 24}
	outer := withMetadataBudget(bytes.NewReader([]byte{1}), budget)
	if _, err := readOptionalBool(outer, 8); err != nil {
		t.Fatal(err)
	}
	decoded := withMetadataBudget(bytes.NewReader([]byte{1}), budget)
	if _, err := readOptionalBool(decoded, 8); !errors.Is(err, limits.ErrMetadataBudget) {
		t.Fatalf("decoded header did not share budget: %v", err)
	}
	if budget.remaining != 8 {
		t.Fatalf("failed reservation consumed budget: %d", budget.remaining)
	}
	independent := withMetadataBudget(bytes.NewReader([]byte{1}), &metadataBudget{remaining: 16})
	if _, err := readOptionalBool(independent, 8); err != nil {
		t.Fatal(err)
	}
	if err := reserveMetadataBytes(outer, math.MaxUint64, 2); !errors.Is(err, limits.ErrMetadataBudget) {
		t.Fatal(err)
	}
}

func TestFilePropertyInheritsMetadataBudget(t *testing.T) {
	// File headers fit, but the nested empty-stream bitmap does not. A new
	// property buffer must not discard the parent's reservation state.
	remaining := 2*uint64(reflect.TypeFor[FileHeader]().Size())*8 + 15
	r := withMetadataBudget(bytes.NewReader([]byte{8, idEmptyStream, 1, 0xff, idEnd}), &metadataBudget{remaining: remaining})
	if _, err := readFilesInfo(r); !errors.Is(err, limits.ErrMetadataBudget) {
		t.Fatalf("got %v", err)
	}
}

func TestNewReaderRejectsMetadataAllocationBeforePayload(t *testing.T) {
	// This count is legal per collection but exceeds the cumulative byte
	// reservation. No huge file table or payload is needed for the test.
	count := limits.MetadataBytes/(2*uint64(reflect.TypeFor[FileHeader]().Size())) + 1
	if count > limits.MetadataItems {
		t.Fatal("fixture must stay within collection limit")
	}
	header := append([]byte{idHeader, idFilesInfo}, metadataUint64(count)...)
	header = append(header, idEnd, idEnd)
	data := make([]byte, 32)
	copy(data, []byte{'7', 'z', 0xbc, 0xaf, 0x27, 0x1c, 0, 4})
	binary.LittleEndian.PutUint64(data[20:28], uint64(len(header)))
	binary.LittleEndian.PutUint32(data[28:32], crc32.ChecksumIEEE(header))
	binary.LittleEndian.PutUint32(data[8:12], crc32.ChecksumIEEE(data[12:]))
	data = append(data, header...)
	if _, err := NewReader(bytes.NewReader(data), int64(len(data))); !errors.Is(err, limits.ErrMetadataBudget) {
		t.Fatalf("got %v", err)
	}
}
