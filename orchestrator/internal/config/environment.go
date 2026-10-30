package config

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"reflect"
	"sort"
	"strconv"
	"strings"
)

// applyEnvironment overlays deployment values without normalizing user-defined
// map keys. Empty environment variables retain the file value, as before.
// Scalars use their native textual representation; string lists accept either
// JSON arrays or comma-separated items. Objects/maps use typed JSON.
func applyEnvironment(cfg *Config) error {
	seen := map[string]string{}
	var walk func(reflect.Value, []string) (reflect.Value, error)
	walk = func(value reflect.Value, path []string) (reflect.Value, error) {
		if len(path) > 0 {
			name := "ORCH_" + strings.ToUpper(strings.Join(path, "_"))
			if raw, exists := os.LookupEnv(name); exists && raw != "" {
				identity := strings.Join(path, "/")
				if previous, exists := seen[name]; exists && previous != identity {
					return value, fmt.Errorf("environment override %s matches multiple configuration fields", name)
				}
				seen[name] = identity
				replacement, err := parseEnvironment(raw, value.Type())
				if err != nil {
					return value, fmt.Errorf("environment override %s has invalid type %s", name, value.Type())
				}
				value = replacement
			}
		}
		switch value.Kind() {
		case reflect.Struct:
			copy := reflect.New(value.Type()).Elem()
			copy.Set(value)
			for i := 0; i < value.NumField(); i++ {
				field := value.Type().Field(i)
				if field.PkgPath != "" {
					continue
				}
				key := strings.Split(field.Tag.Get("json"), ",")[0]
				if key == "" || key == "-" {
					continue
				}
				child, err := walk(value.Field(i), append(append([]string{}, path...), key))
				if err != nil {
					return value, err
				}
				copy.Field(i).Set(child)
			}
			return copy, nil
		case reflect.Map:
			if value.IsNil() {
				return value, nil
			}
			copy := reflect.MakeMapWithSize(value.Type(), value.Len())
			keys := value.MapKeys()
			sort.Slice(keys, func(i, j int) bool { return keys[i].String() < keys[j].String() })
			for _, key := range keys {
				child, err := walk(value.MapIndex(key), append(append([]string{}, path...), key.String()))
				if err != nil {
					return value, err
				}
				copy.SetMapIndex(key, child)
			}
			return copy, nil
		}
		return value, nil
	}
	next, err := walk(reflect.ValueOf(cfg).Elem(), nil)
	if err != nil {
		return err
	}
	reflect.ValueOf(cfg).Elem().Set(next)
	return nil
}

func parseEnvironment(raw string, kind reflect.Type) (reflect.Value, error) {
	value := reflect.New(kind).Elem()
	switch kind.Kind() {
	case reflect.String:
		value.SetString(raw)
		return value, nil
	case reflect.Bool:
		b, err := strconv.ParseBool(raw)
		if err != nil {
			return value, err
		}
		value.SetBool(b)
		return value, nil
	case reflect.Int, reflect.Int64:
		n, err := strconv.ParseInt(raw, 10, kind.Bits())
		if err != nil {
			return value, err
		}
		value.SetInt(n)
		return value, nil
	case reflect.Slice:
		if kind.Elem().Kind() == reflect.String && !strings.HasPrefix(strings.TrimSpace(raw), "[") {
			parts := strings.Split(raw, ",")
			for i := range parts {
				parts[i] = strings.TrimSpace(parts[i])
			}
			value.Set(reflect.ValueOf(parts))
			return value, nil
		}
	}
	d := json.NewDecoder(bytes.NewBufferString(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(value.Addr().Interface()); err != nil {
		return value, err
	}
	if d.Decode(new(any)) != io.EOF {
		return value, fmt.Errorf("multiple values")
	}
	return value, nil
}
