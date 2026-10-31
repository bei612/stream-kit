package component

import (
	"bytes"
	"strings"
)

const maxComponentLogLine = 1024 * 1024

// lineLogWriter is owned by one exec copy worker. It always drains input, even
// after a line exceeds the retained size. flush runs only after Cmd.Wait joins
// the workers. The ring buffer synchronizes stdout/stderr and subscribers.
type lineLogWriter struct {
	buffer    *RingBuffer
	prefix    string
	partial   []byte
	truncated bool
}

func (w *lineLogWriter) Write(data []byte) (int, error) {
	n := len(data)
	for len(data) > 0 {
		end := bytes.IndexByte(data, '\n')
		chunk := data
		if end >= 0 {
			chunk = data[:end]
		}
		remaining := maxComponentLogLine - len(w.partial)
		if len(chunk) > remaining {
			w.truncated = true
			chunk = chunk[:remaining]
		}
		w.partial = append(w.partial, chunk...)
		if end < 0 {
			break
		}
		w.emit()
		data = data[end+1:]
	}
	return n, nil
}

func (w *lineLogWriter) emit() {
	line := w.prefix + strings.TrimRight(string(w.partial), "\r")
	if w.truncated {
		line += " [line truncated]"
	}
	w.buffer.Write(line)
	w.partial = w.partial[:0]
	w.truncated = false
}

func (w *lineLogWriter) flush() {
	if len(w.partial) != 0 || w.truncated {
		w.emit()
	}
}
