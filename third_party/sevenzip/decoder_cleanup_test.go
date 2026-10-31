package sevenzip

import (
	"bytes"
	"errors"
	"io"
	"testing"
)

type trackedDecoder struct {
	io.ReadCloser
	closed        *int
	passwordError error
}

func (r *trackedDecoder) Close() error {
	*r.closed += 1
	return r.ReadCloser.Close()
}
func (r *trackedDecoder) Password(string) error { return r.passwordError }

func TestPartialDecoderGraphClosesOwnedNodesOnce(t *testing.T) {
	for _, mode := range []string{"constructor", "password", "binding", "success"} {
		counts := []int{0, 0, 0}
		failure := errors.New("decoder setup failed")
		methods := [][]byte{{0xff, 0x53, 0x4b, 1}, {0xff, 0x53, 0x4b, 2}, {0xff, 0x53, 0x4b, 3}}
		for i, method := range methods {
			index := i
			RegisterDecompressor(method, func(_ []byte, _ uint64, readers []io.ReadCloser) (io.ReadCloser, error) {
				if index == 2 && mode == "constructor" {
					return nil, failure
				}
				r := &trackedDecoder{ReadCloser: readers[0], closed: &counts[index]}
				if index == 2 && mode == "password" {
					r.passwordError = failure
				}
				return r, nil
			})
		}
		f := &folder{in: 3, out: 3, packedStreams: 1, packed: []uint64{0}, size: []uint64{1, 1, 1},
			bindPair: []*bindPair{{in: 1, out: 0}, {in: 2, out: 1}}}
		if mode == "binding" {
			f.bindPair = f.bindPair[:1]
		}
		for _, method := range methods {
			f.coder = append(f.coder, &coder{id: method, in: 1, out: 1})
		}
		si := &streamsInfo{packInfo: &packInfo{streams: 1, size: []uint64{1}}, unpackInfo: &unpackInfo{folder: []*folder{f}}}
		r, _, _, err := si.folderReader(bytes.NewReader([]byte{1}), 0, "")
		for _, method := range methods {
			decompressors.Delete(string(method))
		}
		if mode == "success" {
			if err != nil || r == nil {
				t.Fatalf("successful graph: %v", err)
			}
			data, readErr := io.ReadAll(r)
			if readErr != nil || !bytes.Equal(data, []byte{1}) {
				t.Fatalf("decoded bytes=%v error=%v", data, readErr)
			}
			if err := r.Close(); err != nil {
				t.Fatal(err)
			}
			if err := r.Close(); err != nil {
				t.Fatal(err)
			}
		} else if mode == "binding" {
			if r != nil || !errors.Is(err, errNoBoundStream) {
				t.Fatalf("binding failure: %v", err)
			}
		} else if r != nil || !errors.Is(err, failure) {
			t.Fatalf("reader=%v error=%v", r, err)
		}
		if counts[0] != 1 || counts[1] != 1 {
			t.Fatalf("upstream close counts: %v", counts)
		}
		want := 0
		if mode == "password" || mode == "success" {
			want = 1
		}
		if counts[2] != want {
			t.Fatalf("failed decoder close count: %v", counts)
		}
	}
}
