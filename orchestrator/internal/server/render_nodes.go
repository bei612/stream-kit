package server

import (
	"net/http"
	"sort"

	"github.com/gin-gonic/gin"
	"github.com/stream-kit/orchestrator/internal/mediacontrol"
)

type renderNodeView struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	BaseURL string `json:"base_url"`
}

// The immutable registry is built from running configuration, not from an
// address supplied by an inventory request. Saved changes require a restart.
func (s *Server) registerRenderNodes(authed *gin.RouterGroup) {
	clients := map[string]*mediacontrol.NodeClient{}
	views := []renderNodeView{}
	if s.MediaControl != nil {
		clients["primary"] = s.MediaControl.NodeClient
		views = append(views, renderNodeView{"primary", "主媒体网关", s.Config.MoonlightWeb.BaseURL})
	}
	for id, node := range s.Config.RenderNodes {
		clients[id] = mediacontrol.NewNodeClient(node.BaseURL, node.ControlSecret)
		views = append(views, renderNodeView{id, node.Name, node.BaseURL})
	}
	sort.Slice(views, func(i, j int) bool { return views[i].ID < views[j].ID })
	authed.GET("/render-nodes", func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		c.JSON(http.StatusOK, gin.H{"status": "ok", "data": gin.H{"apply_policy": "service_restart", "nodes": views}})
	})
	authed.GET("/render-nodes/:node_id/audio-devices", func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		id := c.Param("node_id")
		client, ok := clients[id]
		if !ok || client == nil {
			c.JSON(http.StatusNotFound, gin.H{"status": "error", "code": "render_node_not_found", "message": "节点未配置或尚未重启生效"})
			return
		}
		inventory, err := client.AudioDevices(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"status": "error", "code": "node_inventory_unavailable", "message": "无法验证节点音频设备目录，请检查连接、证书和节点密钥"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"status": "ok", "data": gin.H{"node_id": id, "inventory": inventory}})
	})
}
