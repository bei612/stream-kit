// Package limits defines allocation ceilings for the integrated archive decoder.
package limits

import "errors"

// DictionaryBytes matches the platform's RAR, XZ and Zstandard decoder ceiling.
// This bounds each decoder dictionary, not aggregate archive metadata or RSS.
const DictionaryBytes uint64 = 128 << 20

// HeaderBytes bounds both stored metadata and decoded header input. It does not
// bound allocations implied by counts inside that input.
const HeaderBytes uint64 = 64 << 20

var ErrHeader = errors.New("sevenzip: header exceeds resource limit")

var ErrDictionary = errors.New("sevenzip: decoder dictionary exceeds resource limit")

// Dictionary checks untrusted sizes before conversion to int or allocation.
func Dictionary(size uint64) error {
	if size > DictionaryBytes {
		return ErrDictionary
	}
	return nil
}
