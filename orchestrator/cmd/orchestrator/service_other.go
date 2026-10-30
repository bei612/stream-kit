//go:build !windows

package main

import "context"

func runPlatform(run func(context.Context, func()) error) error { return runConsole(run) }
