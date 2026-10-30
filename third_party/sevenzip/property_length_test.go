package sevenzip

import (
	"bytes"
	"errors"
	"math"
	"testing"
)

func TestFilePropertiesRespectDeclaredPayload(t *testing.T) {
	for _, test := range []struct {
		name  string
		data  []byte
		valid bool
	}{
		{"name", []byte{1, idName, 5, 0, 'a', 0, 0, 0, idEnd}, true},
		{"unterminated_name", []byte{1, idName, 5, 0, 'a', 0, 'b', 0, idEnd}, false},
		{"short_name", []byte{1, idName, 4, 0, 'a', 0, 0, 0, idEnd}, false},
		{"name_consumes_end", []byte{1, idName, 6, 0, 'a', 0, 0, 0, idEnd}, false},
		{"empty_stream", []byte{1, idEmptyStream, 1, 0x80, idEnd}, true},
		{"empty_stream_zero_payload", []byte{1, idEmptyStream, 0, 0x80, idEnd}, false},
		{"empty_stream_extra_payload", []byte{1, idEmptyStream, 2, 0x80, 0, idEnd}, false},
		{"dummy_truncated", []byte{1, idDummy, 3, 0}, false},
		{"empty_dummy", []byte{1, idDummy, 0, idEnd}, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := readFilesInfo(bytes.NewReader(test.data))
			if (err == nil) != test.valid {
				t.Fatalf("valid=%v error=%v", test.valid, err)
			}
		})
	}
}

func TestFilenameLengthCannotUnderflowOrOverflow(t *testing.T) {
	for _, length := range []uint64{0, math.MaxUint64} {
		if _, err := readNames(bytes.NewReader(nil), 1, length); !errors.Is(err, errPropertyLength) {
			t.Fatal(err)
		}
	}
}
