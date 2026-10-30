package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stream-kit/orchestrator/internal/component"
	"github.com/stream-kit/orchestrator/internal/sunshine"
)

type EncoderStateClient interface {
	ConfigurationState(context.Context) (*sunshine.EncoderConfigurationState, error)
}

// EncoderConfigurationApply verifies local process ownership before stopping,
// then verifies the replacement loaded the requested file revision.
func EncoderConfigurationApply(client EncoderStateClient, manager ComponentRestarter, baseURL string) gin.HandlerFunc {
	u, err := url.Parse(baseURL)
	local := false
	if err == nil && u.User == nil && (u.Scheme == "http" || u.Scheme == "https") {
		addr, e := netip.ParseAddr(u.Hostname())
		local = e == nil && addr.IsLoopback()
	}
	return func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		var edit struct {
			Revision string `json:"revision"`
			Instance string `json:"instance_id"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(c.Writer, c.Request.Body, 1024))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&edit) != nil || decoder.Decode(new(any)) != io.EOF || len(edit.Revision) != 66 || edit.Revision[0] != '"' || edit.Revision[65] != '"' || !hexSize(edit.Revision[1:65], 32) || !hexSize(edit.Instance, 32) {
			errResponse(c, 400, "CONFIGURATION_INVALID", "请提交已保存配置版本和编码器启动实例")
			return
		}
		if client == nil || manager == nil || !local {
			errResponse(c, 409, "ENCODER_NOT_MANAGED", "仅支持应用本机受管编码器的配置")
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 80*time.Second)
		defer cancel()
		state, err := client.ConfigurationState(ctx)
		if err != nil || state == nil {
			errResponse(c, 503, "ENCODER_CONFIGURATION_UNAVAILABLE", "无法读取编码器状态，未执行重启")
			return
		}
		matches := func(s *sunshine.EncoderConfigurationState, pid int, managed string) bool {
			return s != nil && s.RuntimeAvailable && s.Revision == edit.Revision && s.InstanceID == edit.Instance && s.ProcessID == pid && s.ManagedInstanceID == managed && hexSize(managed, 16)
		}
		if !matches(state, state.ProcessID, state.ManagedInstanceID) {
			errResponse(c, 409, "CONFIGURATION_CONFLICT", "编码器配置、启动实例或受管归属已变化，请重新读取")
			return
		}
		var applied *sunshine.EncoderConfigurationState
		err = manager.RestartVerified(ctx, "sunshine", state.ProcessID, state.ManagedInstanceID,
			func(ctx context.Context, pid int, managed string) error {
				current, e := client.ConfigurationState(ctx)
				if e != nil {
					return e
				}
				if !matches(current, pid, managed) {
					return sunshine.ErrConfigurationConflict
				}
				return nil
			}, func(ctx context.Context, pid int, managed string) error {
				ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
				defer cancel()
				ticker := time.NewTicker(200 * time.Millisecond)
				defer ticker.Stop()
				for {
					current, e := client.ConfigurationState(ctx)
					if e == nil && current != nil {
						if !current.RuntimeAvailable || current.ProcessID != pid || current.ManagedInstanceID != managed || current.InstanceID == edit.Instance {
							return component.ErrRestartOwnership
						}
						if current.Revision != edit.Revision || current.LoadedRevision != edit.Revision || current.RestartRequired == nil || *current.RestartRequired {
							return sunshine.ErrConfigurationConflict
						}
						applied = current
						return nil
					}
					select {
					case <-ctx.Done():
						return ctx.Err()
					case <-ticker.C:
					}
				}
			})
		switch {
		case errors.Is(err, component.ErrRestartConflict):
			errResponse(c, 409, "COMPONENT_OPERATION_CONFLICT", "编码器正在执行其他操作，请重新读取状态")
		case errors.Is(err, component.ErrRestartOwnership):
			errResponse(c, 409, "ENCODER_OWNERSHIP_MISMATCH", "编码器与受管进程不一致，未确认配置加载")
		case errors.Is(err, sunshine.ErrConfigurationConflict):
			errResponse(c, 409, "CONFIGURATION_CONFLICT", "配置或启动实例已变化，未确认目标版本加载")
		case err != nil || applied == nil:
			errResponse(c, 503, "ENCODER_APPLY_UNVERIFIED", "编码器配置加载未确认，请检查组件和连接配置；未执行自动回滚")
		default:
			okResponse(c, applied)
		}
	}
}
