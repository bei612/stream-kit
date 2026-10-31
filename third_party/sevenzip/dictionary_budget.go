package sevenzip

import (
	"fmt"

	"github.com/bodgit/sevenzip/internal/limits"
	"github.com/bodgit/sevenzip/internal/lzma"
	"github.com/bodgit/sevenzip/internal/lzma2"
	"github.com/bodgit/sevenzip/internal/ppmd"
)

// validateDictionaryBudget checks all declared dictionaries before any coder
// reads input or allocates a dictionary. This is per folder, not a process RSS
// limit: other codecs, custom decompressors and cached folders are excluded.
func (f *folder) validateDictionaryBudget() error {
	remaining := limits.DictionaryBytes
	for i, c := range f.coder {
		var size uint64
		var err error
		switch string(c.id) {
		case "\x03\x01\x01":
			size, err = lzma.DictionarySize(c.properties)
		case "\x21":
			size, err = lzma2.DictionarySize(c.properties)
		case "\x03\x04\x01":
			size, err = ppmd.DictionarySize(c.properties)
		}
		if err != nil {
			return fmt.Errorf("sevenzip: coder %d: %w", i, err)
		}
		if size > remaining {
			return limits.ErrDictionaryBudget
		}
		remaining -= size
	}
	return nil
}
