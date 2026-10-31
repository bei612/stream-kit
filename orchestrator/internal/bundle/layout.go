package bundle

import (
	_ "embed"
	"encoding/json"
	"fmt"
)

// The same catalog is consumed by native setup and source packagers.
//
//go:embed layouts.json
var layoutJSON []byte

type RuntimeLayout struct {
	Executable    string   `json:"executable"`
	RequiredFiles []string `json:"required_files"`
}

var runtimeLayouts = func() map[string]map[string]RuntimeLayout {
	var value map[string]map[string]RuntimeLayout
	if err := json.Unmarshal(layoutJSON, &value); err != nil {
		panic("invalid compiled platform layout catalog")
	}
	return value
}()

func Layout(platform, component string) (RuntimeLayout, error) {
	layout, ok := runtimeLayouts[platform][component]
	if !ok {
		return RuntimeLayout{}, fmt.Errorf("unsupported runtime layout %s/%s", platform, component)
	}
	layout.RequiredFiles = append([]string(nil), layout.RequiredFiles...)
	return layout, nil
}
