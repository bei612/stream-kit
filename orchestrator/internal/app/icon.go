package app

import (
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
)

// generateDefaultIcon creates a simple 256x256 PNG icon in the app directory.
// Green circle on dark background — matches the platform theme.
func generateDefaultIcon(appDir string) string {
	iconPath := filepath.Join(appDir, "icon.png")

	const size = 256
	img := image.NewRGBA(image.Rect(0, 0, size, size))

	bg := color.RGBA{10, 15, 26, 255}     // dark background
	fg := color.RGBA{34, 197, 94, 255}     // green
	border := color.RGBA{30, 41, 59, 255}  // subtle border

	// Fill background
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			img.SetRGBA(x, y, bg)
		}
	}

	// Draw filled circle
	cx, cy, r := size/2, size/2, size/2-20
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			dx, dy := x-cx, y-cy
			dist := dx*dx + dy*dy
			if dist <= r*r {
				img.SetRGBA(x, y, fg)
			} else if dist <= (r+3)*(r+3) {
				img.SetRGBA(x, y, border)
			}
		}
	}

	// Draw a play triangle in the center (dark on green)
	triSize := r / 2
	for y := -triSize; y <= triSize; y++ {
		xMax := triSize - abs(y)*triSize/triSize
		xMin := -triSize / 3
		for x := xMin; x <= xMax; x++ {
			// Simple triangle: left edge is vertical, right edge is pointed
			halfH := triSize * (triSize - x + xMin) / (triSize + triSize/3)
			if abs(y) <= halfH {
				img.SetRGBA(cx+x, cy+y, bg)
			}
		}
	}

	f, err := os.Create(iconPath)
	if err != nil {
		return ""
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		return ""
	}
	return iconPath
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}
