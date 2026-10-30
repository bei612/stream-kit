package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/stream-kit/orchestrator/internal/mediacontrol"
)

type GatewayConfigurationClient interface {
	GatewayConfiguration(context.Context, string, map[string]json.RawMessage) (*mediacontrol.GatewayConfiguration, error)
}

func GatewayConfiguration(client GatewayConfigurationClient) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		if client == nil {
			errResponse(c, 503, "GATEWAY_CONFIGURATION_UNAVAILABLE", "尚未配置媒体网关连接")
			return
		}
		var edit struct {
			Revision string                     `json:"revision"`
			Changes  map[string]json.RawMessage `json:"changes"`
		}
		if c.Request.Method == http.MethodPatch {
			decoder := json.NewDecoder(http.MaxBytesReader(c.Writer, c.Request.Body, 256*1024))
			decoder.DisallowUnknownFields()
			if decoder.Decode(&edit) != nil || decoder.Decode(new(any)) != io.EOF || edit.Revision == "" || len(edit.Changes) == 0 || len(edit.Changes) > 256 {
				errResponse(c, 400, "CONFIGURATION_INVALID", "请提交配置版本和修改字段")
				return
			}
		}
		view, err := client.GatewayConfiguration(c.Request.Context(), edit.Revision, edit.Changes)
		switch {
		case errors.Is(err, mediacontrol.ErrConfigurationConflict):
			errResponse(c, 409, "CONFIGURATION_CONFLICT", "网关配置已被修改，请重新读取后保存")
		case errors.Is(err, mediacontrol.ErrConfigurationInvalid):
			errResponse(c, 400, "CONFIGURATION_INVALID", "网关拒绝配置，请检查字段类型、范围和部署覆盖")
		case err != nil:
			errResponse(c, 503, "GATEWAY_CONFIGURATION_UNAVAILABLE", "无法管理网关配置，请检查连接、版本和文件权限")
		default:
			okResponse(c, view)
		}
	}
}
