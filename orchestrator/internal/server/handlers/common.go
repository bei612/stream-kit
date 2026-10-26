package handlers

import (
	"strings"

	"github.com/gin-gonic/gin"
)

func contains(s, substr string) bool {
	return strings.Contains(s, substr)
}

const requestIDKey = "request_id"

func getRequestID(c *gin.Context) string {
	if id, ok := c.Get(requestIDKey); ok {
		return id.(string)
	}
	return ""
}

func errResponse(c *gin.Context, httpStatus int, code, message string) {
	c.JSON(httpStatus, gin.H{
		"status":     "error",
		"code":       code,
		"message":    message,
		"request_id": getRequestID(c),
	})
}

func okResponse(c *gin.Context, data interface{}) {
	c.JSON(200, gin.H{
		"status":     "ok",
		"data":       data,
		"request_id": getRequestID(c),
	})
}
