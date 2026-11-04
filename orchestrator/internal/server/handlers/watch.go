package handlers

import (
	"github.com/gin-gonic/gin"
	"github.com/stream-kit/orchestrator/internal/store"
	"net/url"
	"strconv"
	"time"
)

type WatchLauncher interface{ LaunchApp(string) (string, error) }

// WatchHandler exchanges a durable application capability for the existing
// short-lived viewing authority. It never grants management or control rights.
type WatchHandler struct {
	store    *store.Store
	launcher WatchLauncher
	clients  *ClientSessionHandler
	limiter  *rateLimiter
}

func NewWatchHandler(st *store.Store, launcher WatchLauncher, clients *ClientSessionHandler) *WatchHandler {
	return &WatchHandler{st, launcher, clients, newRateLimiter(60, time.Minute)}
}

func (h *WatchHandler) Manage(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	id := c.Param("app_id")
	app, err := h.store.GetApp(id)
	if err != nil {
		errResponse(c, 404, "APP_NOT_FOUND", "应用不存在")
		return
	}
	token := ""
	if app.WatchToken != nil {
		token = *app.WatchToken
	}
	switch c.Request.Method {
	case "POST", "PUT":
		token, err = h.store.PublishWatchLink(id, c.Request.Method == "PUT")
	case "DELETE":
		err = h.store.DisableWatchLink(id)
		token = ""
	}
	if err != nil {
		errResponse(c, 500, "WATCH_LINK_FAILED", "无法保存固定观看链接")
		return
	}
	if c.Request.Method != "GET" {
		h.store.CreateLog("app", id, "watch_link_"+c.Request.Method, "success", "固定观看链接配置已更新", nil)
	}
	path := ""
	if token != "" {
		path = "/watch#key=" + token
	}
	okResponse(c, gin.H{"enabled": token != "", "path": path})
}

func (h *WatchHandler) Open(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	if !h.limiter.allow(c.RemoteIP()) {
		errResponse(c, 429, "RATE_LIMITED", "打开过于频繁，请稍后重试")
		return
	}
	app, err := h.store.AppForWatchToken(bearer(c))
	if err != nil {
		errResponse(c, 401, "WATCH_LINK_INVALID", "观看链接已失效或未启用，请向管理员获取新链接")
		return
	}
	if h.clients.sessions.SyncMedia == nil || len(h.clients.sessions.TicketSecret) == 0 {
		errResponse(c, 503, "MEDIA_CONTROL_UNAVAILABLE", "媒体服务尚未就绪")
		return
	}
	// Uses the app's stored executable, working directory, capture mode and args.
	// Viewer query strings cannot override the command or its arguments.
	path, err := h.launcher.LaunchApp(app.ID)
	if err != nil {
		errResponse(c, 503, "APP_UNAVAILABLE", "应用暂时无法启动，请联系管理员或稍后重试")
		return
	}
	uri, err := url.Parse("http://localhost:" + path)
	if err != nil {
		errResponse(c, 503, "APP_UNAVAILABLE", "应用串流地址无效")
		return
	}
	hostID, e1 := strconv.ParseInt(uri.Query().Get("hostId"), 10, 64)
	appID, e2 := strconv.ParseInt(uri.Query().Get("appId"), 10, 64)
	if e1 != nil || e2 != nil || hostID <= 0 || appID <= 0 || uri.Port() == "" {
		errResponse(c, 503, "APP_UNAVAILABLE", "应用串流地址无效")
		return
	}
	// Resolve again after the potentially slow launch lookup so a rotated link
	// cannot finish its pending admission using an obsolete capability.
	if _, err := h.store.AppForWatchToken(bearer(c)); err != nil {
		errResponse(c, 401, "WATCH_LINK_INVALID", "观看链接已失效")
		return
	}
	c.Header("X-Stream-Port", uri.Port())
	c.Set("username", "watch:"+app.ID)
	h.clients.invite(c, hostID, appID)
}
