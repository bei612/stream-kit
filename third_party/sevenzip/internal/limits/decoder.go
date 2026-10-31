// Package limits defines allocation ceilings for the integrated archive decoder.
package limits

import "errors"

// DictionaryBytes matches the platform's RAR, XZ and Zstandard decoder ceiling.
// This bounds each decoder dictionary, not aggregate archive metadata or RSS.
const DictionaryBytes uint64 = 128 << 20

// HeaderBytes bounds both stored metadata and decoded header input. It does not
// bound allocations implied by counts inside that input.
const HeaderBytes uint64 = 64 << 20

// MetadataItems limits any count/length used to allocate header structures.
// This is a per-collection ceiling, not a total archive memory guarantee.
const MetadataItems uint64 = 1 << 20

// MetadataBytes bounds cumulative parser reservations across nested headers.
// It excludes decoder dictionaries and runtime allocator overhead.
const MetadataBytes uint64 = 128 << 20

var ErrMetadataBudget = errors.New("sevenzip: cumulative metadata budget exceeded")

var ErrMetadata = errors.New("sevenzip: metadata count exceeds resource limit")

var ErrHeader = errors.New("sevenzip: header exceeds resource limit")

var ErrDictionary = errors.New("sevenzip: decoder dictionary exceeds resource limit")

var ErrDictionaryBudget = errors.New("sevenzip: folder dictionary budget exceeded")

// Dictionary checks untrusted sizes before conversion to int or allocation.
func Dictionary(size uint64) error {
	if size > DictionaryBytes {
		return ErrDictionary
	}
	return nil
}
