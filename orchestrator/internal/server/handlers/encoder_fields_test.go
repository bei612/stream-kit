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
		{"min_threads", `1`, true}, {"min_threads", `"2"`, true},
		{"min_threads", `0`, false}, {"min_threads", `-1`, false},
		{"min_threads", `1.5`, false}, {"min_threads", `2147483648`, false},
		{"sw_preset", `"ultrafast"`, true}, {"sw_preset", `"veryslow"`, true},
		{"sw_preset", `"superfast"`, true}, {"sw_preset", `"fastest"`, false},
		{"sw_preset", `7`, false}, {"sw_preset", `null`, true},
		{"sw_tune", `"zerolatency"`, true}, {"sw_tune", `"animation"`, true},
		{"sw_tune", `"unknown"`, false}, {"sw_tune", `true`, false},
		{"sw_tune", `""`, true},
		{"stream_audio", `"false"`, true}, {"stream_audio", `"treu"`, false},
		{"stream_audio", `"TRUE"`, false}, {"stream_audio", `{}`, false},
		{"max_bitrate", `10000`, true}, {"max_bitrate", `"0"`, true},
		{"max_bitrate", `-1`, false}, {"max_bitrate", `1.5`, false},
		{"max_bitrate", `2147483648`, false}, {"max_bitrate", `true`, false},
		{"minimum_fps_target", `59.94`, true}, {"minimum_fps_target", `"59.94"`, true},
		{"minimum_fps_target", `"1e3"`, true}, {"minimum_fps_target", `1000`, true},
		{"minimum_fps_target", `0`, true}, {"minimum_fps_target", `1000.01`, false},
		{"minimum_fps_target", `-0.01`, false}, {"minimum_fps_target", `"NaN"`, false},
		{"minimum_fps_target", `"Infinity"`, false}, {"minimum_fps_target", `"1e309"`, false},
		{"minimum_fps_target", `"0x1p2"`, false}, {"minimum_fps_target", `"1_0"`, false},
		{"minimum_fps_target", `" 60 "`, false}, {"minimum_fps_target", `"60fps"`, false},
		{"minimum_fps_target", `false`, false}, {"minimum_fps_target", `[]`, false},
		{"minimum_fps_target", `null`, true}, {"minimum_fps_target", `""`, true},
		{"amd_max_au_size", `-1`, true}, {"amd_max_au_size", `-2`, false},
		{"vaapi_blbrc", `true`, true}, {"nvenc_latency_over_power", `"invalid"`, false},
		{"hevc_mode", `3`, true}, {"hevc_mode", `4`, false},
		{"av1_mode", `0`, true}, {"av1_mode", `-1`, false},
		{"nvenc_preset", `1`, true}, {"nvenc_preset", `7`, true},
		{"nvenc_preset", `0`, false}, {"nvenc_preset", `8`, false},
		{"nvenc_vbv_increase", `400`, true}, {"nvenc_vbv_increase", `401`, false},
		{"vk_tune", `0`, true}, {"vk_tune", `"3"`, true}, {"vk_tune", `4`, false},
		{"vk_rc_mode", `"0"`, true}, {"vk_rc_mode", `2`, true}, {"vk_rc_mode", `"4"`, true},
		{"vk_rc_mode", `3`, false}, {"vk_rc_mode", `5`, false}, {"vk_rc_mode", `true`, false},
		{"ping_timeout", `"-1"`, true}, {"ping_timeout", `-1`, true},
		{"ping_timeout", `-2`, false}, {"ping_timeout", `2147483648`, false},
		{"fec_percentage", `1`, true}, {"fec_percentage", `255`, true},
		{"fec_percentage", `0`, false}, {"fec_percentage", `256`, false},
		{"lan_encryption_mode", `2`, true}, {"lan_encryption_mode", `3`, false},
		{"wan_encryption_mode", `0`, true}, {"wan_encryption_mode", `-1`, false},
		{"amd_preanalysis", `false`, true}, {"amd_preanalysis", `"unknown"`, false},
		{"sunshine_name", `"Node"`, true}, {"sunshine_name", `false`, false},
		{"sunshine_name", `"line\nbreak"`, false},
		{"min_log_level", `"debug"`, true}, {"min_log_level", `"2"`, true},
		{"min_log_level", `"2debug"`, false}, {"min_log_level", `"7"`, false},
		{"stream_audio", ` null `, true}, {"stream_audio", `""`, true},
		{"key_repeat_delay", `0`, true}, {"key_repeat_delay", `"-1"`, true},
		{"key_repeat_delay", `-2`, false}, {"key_repeat_delay", `0.5`, false},
		{"key_repeat_frequency", `24.9`, true}, {"key_repeat_frequency", `"0"`, true},
		{"key_repeat_frequency", `-1`, false}, {"key_repeat_frequency", `"1e309"`, false},
		{"back_button_timeout", `-1`, true}, {"back_button_timeout", `2000`, true},
		{"back_button_timeout", `-2`, false}, {"back_button_timeout", `2147483648`, false},
		{"key_rightalt_to_key_win", `true`, true}, {"key_rightalt_to_key_win", `1`, false},
		{"ds4_back_as_touchpad_click", `false`, true}, {"ds4_back_as_touchpad_click", `[]`, false},
		{"motion_as_ds4", `"disabled"`, true}, {"motion_as_ds4", `"invalid"`, false},
		{"touchpad_as_ds4", `null`, true}, {"touchpad_as_ds4", `{}`, false},
		{"dd_manual_resolution", `"1920x1080"`, true}, {"dd_manual_resolution", `" 3840x2160 "`, true},
		{"dd_manual_resolution", `"1920X1080"`, false}, {"dd_manual_resolution", `"1920x"`, false},
		{"dd_manual_resolution", `"4294967296x1080"`, false}, {"dd_manual_resolution", `1080`, false},
		{"dd_manual_refresh_rate", `"59.94"`, true}, {"dd_manual_refresh_rate", `"60.000000000000"`, true},
		{"dd_manual_refresh_rate", `"00059.9400"`, true}, {"dd_manual_refresh_rate", `"0.000000001"`, true},
		{"dd_manual_refresh_rate", `"0.0000000001"`, false}, {"dd_manual_refresh_rate", `"429496729.6"`, false},
		{"dd_manual_refresh_rate", `"60Hz"`, false}, {"dd_manual_refresh_rate", `"6e1"`, false},
		{"dd_manual_refresh_rate", `"60."`, false}, {"dd_manual_refresh_rate", `59.94`, false},
		{"dd_config_revert_delay", `0`, true}, {"dd_config_revert_delay", `-1`, false},
		{"dd_wa_hdr_toggle_delay", `3000`, true}, {"dd_wa_hdr_toggle_delay", `3001`, false},
		{"dd_config_revert_on_disconnect", `false`, true}, {"dd_config_revert_on_disconnect", `"bad"`, false},
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

func TestVulkanEncoderChoicesBeforeNativeWrite(t *testing.T) {
	for _, tc := range []struct {
		value string
		valid bool
	}{{`"4"`, true}, {`2`, true}, {`3`, false}, {`"99"`, false}} {
		fake := &encoderConfigurationFake{}
		router := gin.New()
		router.PATCH("/config", EncoderConfiguration(fake))
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest("PATCH", "/config", strings.NewReader(`{"revision":"old","changes":{"vk_rc_mode":`+tc.value+`}}`)))
		if (response.Code == 200) != tc.valid || (fake.writes == 1) != tc.valid {
			t.Fatalf("value=%s status=%d writes=%d", tc.value, response.Code, fake.writes)
		}
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

// Native config.cpp accepts text enumerators, including the entropy-coder
// aliases, even where its helper is named int_f. Reject numeric substitutes
// before writing a config that the native parser would silently ignore.
func TestEncoderNativeEnumConfiguration(t *testing.T) {
	cases := map[string][]string{
		"dd_configuration_option": {"disabled", "verify_only", "ensure_active", "ensure_primary", "ensure_only_display"},
		"dd_resolution_option":    {"disabled", "auto", "manual"},
		"dd_refresh_rate_option":  {"disabled", "auto", "manual"},
		"dd_hdr_option":           {"disabled", "auto"},
		"nvenc_twopass":           {"disabled", "quarter_res", "full_res"},
		"nvenc_split_encode":      {"disabled", "driver_decides", "enabled"},
		"qsv_preset":              {"veryslow", "slower", "slow", "medium", "fast", "faster", "veryfast"},
		"qsv_coder":               {"auto", "cabac", "ac", "cavlc", "vlc"},
		"amd_quality":             {"balanced", "quality", "speed"},
		"amd_rc":                  {"cbr", "cqp", "vbr_latency", "vbr_peak"},
		"amd_usage":               {"lowlatency", "lowlatency_high_quality", "transcoding", "ultralowlatency", "webcam"},
		"amd_coder":               {"auto", "cabac", "ac", "cavlc", "vlc"},
		"vaapi_quality":           {"balanced", "quality", "speed"},
		"vaapi_rc":                {"avbr", "cbr", "cqp", "icq", "qvbr", "vbr"},
	}
	for key, choices := range cases {
		t.Run(key, func(t *testing.T) {
			if !reflect.DeepEqual(encoderFieldByKey[key].Choices, choices) {
				t.Fatal("catalog choices differ from reviewed native parser")
			}
			values := []string{`null`, `""`}
			for _, choice := range choices {
				encoded, _ := json.Marshal(choice)
				values = append(values, string(encoded))
			}
			validCount := len(values)
			values = append(values, `"unknown"`, `"AUTO"`, `1`, `true`, `{}`, `[]`)
			for i, value := range values {
				fake := &encoderConfigurationFake{}
				r := gin.New()
				r.PATCH("/config", EncoderConfiguration(fake))
				w := httptest.NewRecorder()
				r.ServeHTTP(w, httptest.NewRequest("PATCH", "/config", strings.NewReader(`{"revision":"old","changes":{"`+key+`":`+value+`}}`)))
				valid := i < validCount
				if (w.Code == 200) != valid || (fake.writes == 1) != valid {
					t.Fatalf("value=%s status=%d writes=%d", value, w.Code, fake.writes)
				}
			}
		})
	}
}
