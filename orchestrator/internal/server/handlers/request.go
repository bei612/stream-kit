package handlers

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/gin-gonic/gin/binding"
)

var errTrailingJSON = errors.New("request must contain one JSON document")

// decodeRequestJSON consumes exactly one document before a handler may mutate
// state. The router supplies the outer budget; endpoint limits may only tighten
// it. Reading through EOF also applies the budget to trailing whitespace/data.
// Validation stays compatible with Gin's binding tags. Empty bodies return EOF
// so the one endpoint that explicitly allows empty metadata can retain that API.
func decodeRequestJSON(c *gin.Context, target any, limit int64, strict bool) error {
	if limit > 0 {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, limit)
	}
	decoder := json.NewDecoder(c.Request.Body)
	if strict || binding.EnableDecoderDisallowUnknownFields {
		decoder.DisallowUnknownFields()
	}
	if binding.EnableDecoderUseNumber {
		decoder.UseNumber()
	}
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		if err != nil {
			return err
		}
		return errTrailingJSON
	}
	if binding.Validator != nil {
		return binding.Validator.ValidateStruct(target)
	}
	return nil
}

// Preserve endpoint-specific validation messages while giving every bounded
// reader (including chunked requests) the same transport-level size response.
func requestError(c *gin.Context, err error, code, message string) {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		errResponse(c, http.StatusRequestEntityTooLarge, "REQUEST_TOO_LARGE", "request body exceeds the allowed size")
		return
	}
	errResponse(c, http.StatusBadRequest, code, message)
}
