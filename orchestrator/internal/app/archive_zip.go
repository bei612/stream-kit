package app

import (
	"archive/zip"
	"bufio"
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"math"
)

const (
	zipEndSize        = 22
	zip64LocatorSize  = 20
	zip64EndSize      = 56
	zipFileHeaderSize = 46
	zipIndexMaxBytes  = 64 << 20

	zip64LocatorSignature = 0x07064b50
	zip64EndSignature     = 0x06064b50
	zipFileSignature      = 0x02014b50
	zipDirectorySignature = 0x05054b50
)

var errZIPIndexBudget = errors.New("ZIP 目录元数据超过大小上限")

type zipDirectory struct {
	end                       int64
	length, offset, fileCount uint64
}

// Check the framing and count records before archive/zip allocates its index.
// Payload decoding, extra fields and integrity checks stay in the standard library.
func openArchiveZIP(source io.ReaderAt, size int64, maxFiles int) (*zip.Reader, error) {
	directory, err := readZIPDirectory(source, size)
	if err != nil {
		return nil, err
	}
	if directory.fileCount > uint64(maxFiles) {
		return nil, errArchiveEntryCount
	}
	if directory.length > zipIndexMaxBytes {
		return nil, errZIPIndexBudget
	}
	if directory.length > uint64(directory.end) {
		return nil, zip.ErrFormat
	}
	start := directory.end - int64(directory.length)
	if directory.offset > uint64(start) {
		return nil, zip.ErrFormat
	}
	if directory.offset < uint64(start) {
		// archive/zip may prefer the unadjusted offset when it also points to
		// a valid record. Reject ambiguous starts before handing off the reader.
		var signature [4]byte
		if _, err = source.ReadAt(signature[:], int64(directory.offset)); err != nil {
			return nil, err
		}
		if binary.LittleEndian.Uint32(signature[:]) == zipFileSignature {
			return nil, zip.ErrFormat
		}
	}
	if err := scanZIPDirectory(io.NewSectionReader(source, start, int64(directory.length)), directory, maxFiles); err != nil {
		return nil, err
	}
	reader, err := zip.NewReader(source, size)
	if err != nil {
		return nil, err
	}
	if uint64(len(reader.File)) != directory.fileCount {
		return nil, zip.ErrFormat
	}
	return reader, nil
}

// Locate the same last footer as archive/zip, within its bounded search window.
func readZIPDirectory(source io.ReaderAt, size int64) (zipDirectory, error) {
	if size < zipEndSize {
		return zipDirectory{}, zip.ErrFormat
	}
	little := binary.LittleEndian
	tail := make([]byte, min(size, 65<<10))
	if _, err := source.ReadAt(tail, size-int64(len(tail))); err != nil {
		return zipDirectory{}, err
	}
	i := bytes.LastIndex(tail[:len(tail)-zipEndSize+4], []byte{'P', 'K', 5, 6})
	if i < 0 || int(little.Uint16(tail[i+20:])) > len(tail)-i-zipEndSize {
		return zipDirectory{}, zip.ErrFormat
	}
	footer := tail[i:]
	d := zipDirectory{
		end:       size - int64(len(tail)-i),
		fileCount: uint64(little.Uint16(footer[10:])),
		length:    uint64(little.Uint32(footer[12:])),
		offset:    uint64(little.Uint32(footer[16:])),
	}
	disk, directoryDisk := uint32(little.Uint16(footer[4:])), uint32(little.Uint16(footer[6:]))
	filesOnDisk := uint64(little.Uint16(footer[8:]))
	if d.end >= zip64LocatorSize && (d.fileCount == math.MaxUint16 || d.length == math.MaxUint32 || d.offset == math.MaxUint32) {
		var locator [zip64LocatorSize]byte
		locatorOffset := d.end - zip64LocatorSize
		if _, err := source.ReadAt(locator[:], locatorOffset); err != nil {
			return zipDirectory{}, err
		}
		if little.Uint32(locator[:]) == zip64LocatorSignature {
			end := little.Uint64(locator[8:])
			if little.Uint32(locator[4:]) != 0 || little.Uint32(locator[16:]) != 1 || end > uint64(locatorOffset) || uint64(locatorOffset)-end < zip64EndSize {
				return zipDirectory{}, zip.ErrFormat
			}
			var footer64 [zip64EndSize]byte
			if _, err := source.ReadAt(footer64[:], int64(end)); err != nil {
				return zipDirectory{}, err
			}
			if little.Uint32(footer64[:]) != zip64EndSignature || little.Uint64(footer64[4:]) != uint64(locatorOffset)-end-12 {
				return zipDirectory{}, zip.ErrFormat
			}
			disk, directoryDisk = little.Uint32(footer64[16:]), little.Uint32(footer64[20:])
			filesOnDisk = little.Uint64(footer64[24:])
			d = zipDirectory{end: int64(end), fileCount: little.Uint64(footer64[32:]), length: little.Uint64(footer64[40:]), offset: little.Uint64(footer64[48:])}
		}
	}
	if disk != 0 || directoryDisk != 0 || filesOnDisk != d.fileCount {
		return zipDirectory{}, zip.ErrFormat
	}
	return d, nil
}

func scanZIPDirectory(source io.Reader, directory zipDirectory, maxFiles int) error {
	reader := bufio.NewReaderSize(source, 32<<10)
	little := binary.LittleEndian
	remaining, files := int64(directory.length), uint64(0)
	var header [zipFileHeaderSize]byte
	for remaining > 0 {
		if _, err := io.ReadFull(reader, header[:4]); err != nil {
			return err
		}
		switch little.Uint32(header[:]) {
		case zipDirectorySignature:
			if _, err := io.ReadFull(reader, header[4:6]); err != nil {
				return err
			}
			if remaining != 6+int64(little.Uint16(header[4:])) || files != directory.fileCount {
				return zip.ErrFormat
			}
			return nil
		case zipFileSignature:
			if _, err := io.ReadFull(reader, header[4:]); err != nil {
				return err
			}
		default:
			return zip.ErrFormat
		}
		files++
		if files > uint64(maxFiles) {
			return errArchiveEntryCount
		}
		if files > directory.fileCount {
			return zip.ErrFormat
		}
		variable := int(little.Uint16(header[28:])) + int(little.Uint16(header[30:])) + int(little.Uint16(header[32:]))
		remaining -= int64(len(header) + variable)
		if remaining < 0 {
			return zip.ErrFormat
		}
		if _, err := reader.Discard(variable); err != nil {
			return err
		}
	}
	if files != directory.fileCount {
		return zip.ErrFormat
	}
	return nil
}
