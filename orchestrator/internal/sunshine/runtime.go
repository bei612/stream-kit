package sunshine

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// Runtime identifies the actual execution, including unmanaged applications.
// An empty AppID with a positive GameStreamID is occupied, never an idle host.
type Runtime struct {
	SchemaVersion int    `json:"schema_version"`
	AppID         string `json:"app_id"`
	InstanceID    string `json:"instance_id"`
	GameStreamID  int    `json:"gamestream_id"`
}

func validInstanceID(id string) bool {
	_, err := hex.DecodeString(id)
	return len(id) == 32 && err == nil && strings.ToLower(id) == id
}

func (c *Client) requireManagedRuntime(ctx context.Context) error {
	capabilities, err := c.Capabilities(ctx)
	if err != nil {
		return err
	}
	if capabilities.ManagedRuntimeVersion != 1 {
		return fmt.Errorf("编码器不支持按运行实例管理，请部署本项目编译的服务端版本")
	}
	return nil
}

func (c *Client) Runtime(ctx context.Context) (Runtime, error) {
	var result Runtime
	if err := c.requireManagedRuntime(ctx); err != nil {
		return result, err
	}
	var wire struct {
		SchemaVersion *int    `json:"schema_version"`
		AppID         *string `json:"app_id"`
		InstanceID    *string `json:"instance_id"`
		GameStreamID  *int    `json:"gamestream_id"`
	}
	if err := c.requestManagedJSON(ctx, http.MethodGet, "/api/stream-kit/runtime", nil, 4096, &wire); err != nil {
		return Runtime{}, err
	}
	if wire.SchemaVersion == nil || wire.AppID == nil || wire.InstanceID == nil || wire.GameStreamID == nil {
		return Runtime{}, fmt.Errorf("编码器运行状态字段缺失")
	}
	result = Runtime{SchemaVersion: *wire.SchemaVersion, AppID: *wire.AppID, InstanceID: *wire.InstanceID, GameStreamID: *wire.GameStreamID}
	if result.SchemaVersion != 1 || result.GameStreamID < 0 || result.GameStreamID > 2147483647 {
		return Runtime{}, fmt.Errorf("编码器运行身份或协议版本无效")
	}
	if result.GameStreamID == 0 {
		if result.AppID != "" || result.InstanceID != "" {
			return Runtime{}, fmt.Errorf("编码器空闲状态与运行身份矛盾")
		}
	} else {
		if !validInstanceID(result.InstanceID) {
			return Runtime{}, fmt.Errorf("编码器运行实例标识无效")
		}
		if result.AppID != "" {
			if err := validateManagedID(result.AppID); err != nil {
				return Runtime{}, err
			}
		}
	}
	return result, nil
}

// StopManagedApp acknowledges exactly one execution. A conflict or uncertain
// response is returned to the caller without claiming a successful stop.
func (c *Client) StopManagedApp(ctx context.Context, id, instance string) error {
	if err := validateManagedID(id); err != nil {
		return err
	}
	if !validInstanceID(instance) {
		return fmt.Errorf("无效的运行实例标识")
	}
	if err := c.requireManagedRuntime(ctx); err != nil {
		return err
	}
	payload, err := json.Marshal(map[string]string{"instance_id": instance})
	if err != nil {
		return err
	}
	var result struct {
		SchemaVersion int    `json:"schema_version"`
		AppID         string `json:"app_id"`
		InstanceID    string `json:"instance_id"`
		Stopped       bool   `json:"stopped"`
	}
	if err := c.requestManagedJSON(ctx, http.MethodPost, "/api/stream-kit/apps/"+id+"/stop", payload, 4096, &result); err != nil {
		return err
	}
	if result.SchemaVersion != 1 || result.AppID != id || result.InstanceID != instance || !result.Stopped {
		return fmt.Errorf("编码器停止确认与目标运行实例不一致")
	}
	return nil
}
