//go:build !windows

package component

import (
	"context"
	"errors"
)

func RunWorker(context.Context, []string) error {
	return errors.New("render-worker entry is specific to Windows interactive sessions")
}
