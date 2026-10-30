package handlers

import (
	"encoding/json"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestEncoderFieldValidationBeforeNativeWrite(t *testing.T) {
	for _, tc := range []struct {
		key, value string
		valid      bool
	}{
		{"stream_audio", `true`, true}, {"stream_audio", `"enabled"`, true},
		{"stream_audio", `"false"`, true}, {"stream_audio", `"treu"`, false},
		{"stream_audio", `"TRUE"`, false}, {"stream_audio", `{}`, false},
		{"max_bitrate", `10000`, true}, {"max_bitrate", `"0"`, true},
		{"max_bitrate", `-1`, false}, {"max_bitrate", `1.5`, false},
		{"max_bitrate", `2147483648`, false}, {"max_bitrate", `true`, false},
		{"sunshine_name", `"Node"`, true}, {"sunshine_name", `false`, false},
		{"sunshine_name", `"line\nbreak"`, false},
		{"min_log_level", `"debug"`, true}, {"min_log_level", `"2"`, true},
		{"min_log_level", `"2debug"`, false}, {"min_log_level", `"7"`, false},
		{"stream_audio", ` null `, true}, {"stream_audio", `""`, true},
		{"extension", `{"custom":true}`, true},
	} {
		t.Run(tc.key+tc.value, func(t *testing.T) {
			fake := &encoderConfigurationFake{}
			r := gin.New()
			r.PATCH("/config", EncoderConfiguration(fake))
			w := httptest.NewRecorder()
			r.ServeHTTP(w, httptest.NewRequest("PATCH", "/config", strings.NewReader(`{"revision":"old","changes":{"`+tc.key+`":`+tc.value+`}}`)))
			if (w.Code == 200) != tc.valid || (fake.writes == 1) != tc.valid {
				t.Fatalf("status=%d writes=%d", w.Code, fake.writes)
			}
		})
	}
}

func TestEncoderCatalogUsesSameReviewedFieldsAsRedaction(t *testing.T) {
	r := gin.New()
	r.GET("/config", EncoderConfiguration(&encoderConfigurationFake{}))
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/config", nil))
	var response struct {
		Data struct {
			Fields []encoderField `json:"fields"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Data.Fields) != len(encoderFieldByKey) {
		t.Fatal("catalog missing or duplicate entries")
	}
	for _, field := range response.Data.Fields {
		if !reflect.DeepEqual(field, encoderFieldByKey[field.Key]) || field.Label == "" {
			t.Fatalf("invalid catalog field: %+v", field)
		}
	}
}
