package server

import (
	"net/http"
	"net/url"
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
		if origin != "" {
			set[origin] = struct{}{}
		}
	}
	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		_, permitted := set[origin]
		if !permitted {
			permitted = sameHostOrigin(origin, c.Request.Host, allowed)
		}
		if origin != "" {
			if permitted {
				c.Header("Access-Control-Allow-Origin", origin)
				c.Header("Vary", "Origin")
				c.Header("Access-Control-Allow-Headers", "Authorization, Content-Type")
				c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
			}
		}
		if c.Request.Method == http.MethodOptions {
			if origin == "" {
				c.AbortWithStatus(http.StatusNoContent)
				return
			}
			if !permitted {
				c.AbortWithStatus(http.StatusForbidden)
				return
			}
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}

// {host} represents only the request's hostname, never an arbitrary origin.
// Scheme and gateway port remain explicitly configured. Forwarded headers are
// deliberately not trusted to expand the browser-origin allow list.
func sameHostOrigin(origin, host string, allowed []string) bool {
	u, err := url.Parse("//" + host)
	if err != nil || u.Hostname() == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	name := u.Hostname()
	if strings.Contains(name, ":") {
		name = "[" + name + "]"
	}
	for _, template := range allowed {
		if !strings.Contains(template, "{host}") {
			continue
		}
		parsed, err := url.Parse(strings.ReplaceAll(template, "{host}", "stream-kit.invalid"))
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Hostname() != "stream-kit.invalid" || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
			continue
		}
		if origin == strings.ReplaceAll(template, "{host}", name) {
			return true
		}
	}
	return false
}
