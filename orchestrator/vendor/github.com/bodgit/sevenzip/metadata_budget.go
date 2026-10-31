package sevenzip

import (
	"io"
	"reflect"

	"github.com/bodgit/sevenzip/internal/limits"
	"github.com/bodgit/sevenzip/internal/util"
)

// metadataBudget is shared by the outer header, decoded header and bounded
// property readers. Reservations are cumulative (including temporary arrays),
// not refunded when parsing moves on. This is not a process RSS limit.
type metadataBudget struct{ remaining uint64 }

type metadataReader struct {
	util.Reader
	budget *metadataBudget
}

func withMetadataBudget(r util.Reader, budget *metadataBudget) util.Reader {
	return &metadataReader{Reader: r, budget: budget}
}

func inheritMetadataBudget(r util.Reader, parent util.Reader) util.Reader {
	if source, ok := parent.(*metadataReader); ok {
		return withMetadataBudget(r, source.budget)
	}
	return r
}

func reserveMetadataBytes(r io.ByteReader, count, width uint64) error {
	reader, ok := r.(*metadataReader)
	if !ok {
		return nil
	} // Internal parsers also support isolated unit tests.
	if width != 0 && count > reader.budget.remaining/width {
		return limits.ErrMetadataBudget
	}
	reader.budget.remaining -= count * width
	return nil
}

// Account for slice growth and temporary backing arrays conservatively. Heap
// allocator overhead and decoder dictionaries are outside this reservation.
func reserveMetadata[T any](r io.ByteReader, count uint64) error {
	return reserveMetadataBytes(r, count, 2*uint64(reflect.TypeFor[T]().Size()))
}
