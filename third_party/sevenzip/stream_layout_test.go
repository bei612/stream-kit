package sevenzip

import (
	"bytes"
	"math"
	"testing"
)

func TestStreamLayoutValidatedBeforeDecoding(t *testing.T) {
	for _, tc := range []struct {
		name                        string
		position                    uint64
		packed                      []uint64
		unpacked                    uint64
		omitPack, omitUnpack, valid bool
	}{
		{name: "copy", packed: []uint64{4}, unpacked: 4, valid: true},
		{name: "empty", omitPack: true, omitUnpack: true, valid: true},
		{name: "missing pack", omitPack: true, unpacked: 4},
		{name: "missing unpack", packed: []uint64{4}, omitUnpack: true},
		{name: "missing packed stream", packed: nil, unpacked: 4},
		{name: "extra packed stream", packed: []uint64{4, 4}, unpacked: 4},
		{name: "signed position overflow", position: math.MaxUint64, packed: []uint64{0}},
		{name: "signed size overflow", packed: []uint64{math.MaxUint64}},
		{name: "offset plus size overflow", position: math.MaxInt64, packed: []uint64{1}},
		{name: "signed unpack size overflow", packed: []uint64{4}, unpacked: math.MaxUint64},
		{name: "signed boundary", position: math.MaxInt64 - 4, packed: []uint64{4}, unpacked: math.MaxInt64, valid: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var data []byte
			if !tc.omitPack {
				data = append(data, idPackInfo)
				data = append(data, metadataUint64(tc.position)...)
				data = append(data, metadataUint64(uint64(len(tc.packed)))...)
				data = append(data, idSize)
				for _, size := range tc.packed {
					data = append(data, metadataUint64(size)...)
				}
				data = append(data, idEnd)
			}
			if !tc.omitUnpack {
				// One folder with one Copy coder and its output size.
				data = append(data, idUnpackInfo, idFolder, 1, 0, 1, 1, 0, idCodersUnpackSize)
				data = append(data, metadataUint64(tc.unpacked)...)
				data = append(data, idEnd)
			}
			data = append(data, idEnd)
			_, err := readStreamsInfo(bytes.NewReader(data))
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%v error=%v", tc.valid, err)
			}
		})
	}
}
