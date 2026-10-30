package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sort"

	"github.com/gin-gonic/gin"
	"github.com/stream-kit/orchestrator/internal/sunshine"
)

type EncoderConfigurationClient interface {
	ReadConfiguration(context.Context) (sunshine.EncoderConfiguration, error)
	PatchConfiguration(context.Context, string, map[string]json.RawMessage) (string, error)
}

// Unknown fields are write-only until classified. This also protects credentials
// in extensions, command arrays and future native configuration keys.
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
			for key, value := range edit.Changes {
				if !validEncoderField(key, value) {
					errResponse(c, 400, "CONFIGURATION_INVALID", "参数 "+key+" 的类型或范围无效")
					return
				}
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
			if _, visible := encoderFieldByKey[key]; visible {
				values[key] = value
			} else {
				values[key] = json.RawMessage("null")
				redacted = append(redacted, key)
			}
		}
		sort.Strings(redacted)
		view := gin.H{"revision": snapshot.Revision, "values": values, "redacted_keys": redacted, "apply_policy": "encoder_restart", "runtime_verified": false}
		view["fields"] = encoderFields
		if snapshot.State != nil && snapshot.State.RuntimeAvailable {
			view["loaded_revision"] = snapshot.State.LoadedRevision
			view["instance_id"] = snapshot.State.InstanceID
			view["process_id"] = snapshot.State.ProcessID
			view["managed_instance_id"] = snapshot.State.ManagedInstanceID
			view["overridden_keys"] = snapshot.State.OverriddenKeys
			view["restart_required"] = snapshot.State.RestartRequired
		}
		okResponse(c, view)
	}
}
