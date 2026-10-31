package handlers

import (
	"context"
	"encoding/json"
	"github.com/gin-gonic/gin"
	"github.com/stream-kit/orchestrator/internal/mediacontrol"
	"io"
	"net/http"
	"strings"
)

type AudioPairChecker interface {
	CheckAudioPair(context.Context, mediacontrol.AudioEndpointPair) (mediacontrol.PairCheckResult, error)
}

func AudioPairCheck(client AudioPairChecker) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		var pair mediacontrol.AudioEndpointPair
		decoder := json.NewDecoder(http.MaxBytesReader(c.Writer, c.Request.Body, 65536))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&pair) != nil || decoder.Decode(new(any)) != io.EOF || pair.RenderDeviceID == pair.CaptureDeviceID {
			errResponse(c, 400, "AUDIO_PAIR_INVALID", "请选择不同的输出和输入设备")
			return
		}
		for _, id := range []string{pair.RenderDeviceID, pair.CaptureDeviceID} {
			if id == "" || len(id) > 4096 || strings.TrimSpace(id) != id || strings.ContainsAny(id, "\r\n\x00") {
				errResponse(c, 400, "AUDIO_PAIR_INVALID", "音频设备标识无效")
				return
			}
		}
		if client == nil {
			errResponse(c, 503, "AUDIO_PAIR_UNAVAILABLE", "尚未配置媒体网关")
			return
		}
		result, err := client.CheckAudioPair(c.Request.Context(), pair)
		if err != nil {
			errResponse(c, 503, "AUDIO_PAIR_UNAVAILABLE", "无法完成检查，请确认设备空闲、端点方向及网关版本")
			return
		}
		okResponse(c, result)
	}
}
