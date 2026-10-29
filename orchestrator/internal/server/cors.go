package server

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// CORSMiddleware permits only explicitly configured browser origins. An empty
// list keeps the management API same-origin, which is the safe production
// default. Credentials are not enabled because media control uses bearer
// tickets rather than cookies.
func CORSMiddleware(allowed []string) gin.HandlerFunc {
	set := make(map[string]struct{}, len(allowed))
	for _, origin := range allowed {
		origin = strings.TrimSpace(origin)
		if origin != "" { set[origin] = struct{}{} }
	}
	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		if origin != "" {
			if _, ok := set[origin]; ok {
				c.Header("Access-Control-Allow-Origin", origin)
				c.Header("Vary", "Origin")
				c.Header("Access-Control-Allow-Headers", "Authorization, Content-Type")
				c.Header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
			}
		}
		if c.Request.Method == http.MethodOptions {
			if origin == "" { c.AbortWithStatus(http.StatusNoContent); return }
			if _, ok := set[origin]; !ok { c.AbortWithStatus(http.StatusForbidden); return }
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}
