package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/stream-kit/orchestrator/internal/sunshine"
)

type EncoderConfigurationClient interface {
	ReadConfiguration(context.Context) (sunshine.EncoderConfiguration, error)
	PatchConfiguration(context.Context, string, map[string]json.RawMessage) (string, error)
}

// Unknown fields are write-only until classified. This also protects credentials
// in extensions, command arrays and future native configuration keys.
var encoderVisibleKeys = func() map[string]bool {
	keys := make(map[string]bool)
	for _, key := range strings.Fields(`sunshine_name capture encoder adapter_name output_name audio_sink virtual_sink stream_audio max_bitrate mouse keyboard controller native_pen_touch high_resolution_scrolling always_send_scancodes system_tray min_log_level`) {
		keys[key] = true
	}
	return keys
}()

func EncoderConfiguration(client EncoderConfigurationClient) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		if client == nil {
			errResponse(c, 503, "ENCODER_CONFIGURATION_UNAVAILABLE", "尚未配置编码器连接")
			return
		}
		fail := func(err error) {
			switch {
			case errors.Is(err, sunshine.ErrConfigurationConflict):
				errResponse(c, 409, "CONFIGURATION_CONFLICT", "编码器配置已变化，请重新读取后保存")
			case errors.Is(err, sunshine.ErrConfigurationInvalid):
				errResponse(c, 400, "CONFIGURATION_INVALID", "配置版本、字段或内容无效")
			default:
				errResponse(c, 503, "ENCODER_CONFIGURATION_UNAVAILABLE", "无法确认编码器配置，请重新读取后再操作")
			}
		}
		if c.Request.Method == http.MethodPatch {
			var edit struct {
				Revision string                     `json:"revision"`
				Changes  map[string]json.RawMessage `json:"changes"`
			}
			decoder := json.NewDecoder(http.MaxBytesReader(c.Writer, c.Request.Body, 256*1024))
			decoder.DisallowUnknownFields()
			if decoder.Decode(&edit) != nil || decoder.Decode(new(any)) != io.EOF || edit.Revision == "" || len(edit.Changes) == 0 || len(edit.Changes) > 256 {
				fail(sunshine.ErrConfigurationInvalid)
				return
			}
			revision, err := client.PatchConfiguration(c.Request.Context(), edit.Revision, edit.Changes)
			if err != nil {
				fail(err)
				return
			}
			// Do not report a later read as this transaction's committed revision.
			okResponse(c, gin.H{"revision": revision, "apply_policy": "encoder_restart", "runtime_verified": false})
			return
		}
		snapshot, err := client.ReadConfiguration(c.Request.Context())
		if err != nil {
			fail(err)
			return
		}
		values := make(map[string]json.RawMessage, len(snapshot.Values))
		redacted := make([]string, 0)
		for key, value := range snapshot.Values {
			if encoderVisibleKeys[key] {
				values[key] = value
			} else {
				values[key] = json.RawMessage("null")
				redacted = append(redacted, key)
			}
		}
		sort.Strings(redacted)
		okResponse(c, gin.H{"revision": snapshot.Revision, "values": values, "redacted_keys": redacted, "apply_policy": "encoder_restart", "runtime_verified": false})
	}
}
