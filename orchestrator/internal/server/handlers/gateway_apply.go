package handlers

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stream-kit/orchestrator/internal/component"
	"github.com/stream-kit/orchestrator/internal/mediacontrol"
)

type GatewayRestarter interface {
	RestartVerified(context.Context, string, int, string, func(context.Context, int, string) error, func(context.Context, int, string) error) error
}

func GatewayConfigurationApply(client GatewayConfigurationClient, manager GatewayRestarter, baseURL string) gin.HandlerFunc {
	// Only literal loopback destinations can be matched to local owned PIDs.
	u, parseErr := url.Parse(baseURL)
	local := false
	if parseErr == nil && (u.Scheme == "http" || u.Scheme == "https") && u.User == nil {
		addr, err := netip.ParseAddr(u.Hostname())
		local = err == nil && addr.IsLoopback()
	}
	return func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		var request struct {
			Revision string `json:"revision"`
			Instance string `json:"instance_id"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(c.Writer, c.Request.Body, 1024))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&request) != nil || decoder.Decode(new(any)) != io.EOF || !hexSize(request.Revision, 32) || !hexSize(request.Instance, 16) {
			errResponse(c, 400, "CONFIGURATION_INVALID", "请提交已保存配置版本及当前网关实例")
			return
		}
		if client == nil || manager == nil || !local {
			errResponse(c, 409, "GATEWAY_NOT_MANAGED", "仅支持应用本机受管网关的配置，请核对组件及回环连接地址")
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 80*time.Second)
		defer cancel()
		view, err := client.GatewayConfiguration(ctx, "", nil)
		matches := func(view *mediacontrol.GatewayConfiguration, pid int) bool {
			return view != nil && view.Runtime != nil && view.Revision == request.Revision &&
				view.Runtime.InstanceID == request.Instance && int(view.Runtime.ProcessID) == pid
		}
		if err != nil || view == nil {
			errResponse(c, 503, "GATEWAY_CONFIGURATION_UNAVAILABLE", "无法读取网关签名状态，未执行重启")
			return
		}
		if view.Runtime == nil || !matches(view, int(view.Runtime.ProcessID)) {
			errResponse(c, 409, "CONFIGURATION_CONFLICT", "网关实例或配置已变化，请重新读取")
			return
		}
		if !view.RestartRequired && view.RunningRevision != nil && *view.RunningRevision == request.Revision {
			okResponse(c, view)
			return
		}
		var applied *mediacontrol.GatewayConfiguration
		err = manager.RestartVerified(ctx, "web_server", int(view.Runtime.ProcessID), request.Instance,
			func(ctx context.Context, pid int, instance string) error {
				current, err := client.GatewayConfiguration(ctx, "", nil)
				if err != nil {
					return err
				}
				if !matches(current, pid) || current.Runtime.InstanceID != instance {
					return mediacontrol.ErrConfigurationConflict
				}
				return nil
			}, func(ctx context.Context, pid int, instance string) error {
				ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
				defer cancel()
				ticker := time.NewTicker(200 * time.Millisecond)
				defer ticker.Stop()
				for {
					current, err := client.GatewayConfiguration(ctx, "", nil)
					if err == nil && current != nil {
						if current.Runtime == nil || int(current.Runtime.ProcessID) != pid || current.Runtime.InstanceID == request.Instance || current.Runtime.InstanceID != instance {
							return component.ErrRestartOwnership
						}
						if current.Revision != request.Revision || current.RunningRevision == nil || *current.RunningRevision != request.Revision || current.RestartRequired {
							return mediacontrol.ErrConfigurationConflict
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
			errResponse(c, 409, "COMPONENT_OPERATION_CONFLICT", "网关组件正在执行其他操作，请稍后重新读取状态")
		case errors.Is(err, component.ErrRestartOwnership):
			errResponse(c, 409, "GATEWAY_OWNERSHIP_MISMATCH", "签名网关与受管进程不一致，未确认配置生效，请检查组件状态")
		case errors.Is(err, mediacontrol.ErrConfigurationConflict):
			errResponse(c, 409, "CONFIGURATION_CONFLICT", "配置或运行实例发生变化，未确认目标版本生效，请重新读取状态")
		case err != nil || applied == nil:
			errResponse(c, 503, "GATEWAY_APPLY_UNVERIFIED", "网关配置应用未确认成功，请检查组件状态、预检及连接配置；未执行自动回滚")
		default:
			okResponse(c, applied)
		}
	}
}

func hexSize(value string, size int) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == size
}
