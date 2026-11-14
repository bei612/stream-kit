package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// Native HTTP exercises known-length and chunked bodies against the shared
// decoder. Successful validation is the only path to the mutation counter.
func TestRequestJSONBoundary(t *testing.T) {
	for _, strict := range []bool{false, true} {
		for _, tc := range []struct {
			name, body string
			status     int
		}{
			{"valid", `{"name":"viewer"}`, 200},
			{"validation", `{}`, 400},
			{"empty", ``, 400},
			{"truncated", `{"name":`, 400},
			{"second-document", `{"name":"viewer"}{}`, 400},
			{"trailing-garbage", `{"name":"viewer"}x`, 400},
			{"large-field", `{"name":"` + strings.Repeat("x", 2048) + `"}`, 413},
			{"large-tail", `{"name":"viewer"}` + strings.Repeat(" ", 2048), 413},
		} {
			for _, chunked := range []bool{false, true} {
				t.Run(tc.name+map[bool]string{true: "/strict", false: "/compatible"}[strict]+map[bool]string{true: "/chunked", false: "/length"}[chunked], func(t *testing.T) {
					mutations := 0
					router := gin.New()
					router.POST("/", func(c *gin.Context) {
						var value struct {
							Name string `json:"name" binding:"required"`
						}
						if err := decodeRequestJSON(c, &value, 1024, strict); err != nil {
							requestError(c, err, "CONFIG_INVALID", "invalid request")
							return
						}
						mutations++
						okResponse(c, value)
					})
					server := httptest.NewServer(router)
					defer server.Close()
					req, _ := http.NewRequest(http.MethodPost, server.URL, strings.NewReader(tc.body))
					if chunked {
						req.ContentLength = -1
					}
					response, err := server.Client().Do(req)
					if err != nil {
						t.Fatal(err)
					}
					var body struct {
						Code string `json:"code"`
					}
					err = json.NewDecoder(response.Body).Decode(&body)
					response.Body.Close()
					if err != nil || response.StatusCode != tc.status {
						t.Fatalf("HTTP %d, error %v", response.StatusCode, err)
					}
					if tc.status == 413 && body.Code != "REQUEST_TOO_LARGE" {
						t.Fatalf("size code %q", body.Code)
					}
					if (tc.status == 200) != (mutations == 1) {
						t.Fatalf("unexpected mutation count %d", mutations)
					}
				})
			}
		}
	}
}
