package main

import (
	"fmt"
	"os"
	"strconv"
	"syscall"
	"unsafe"
)

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	gdi32    = syscall.NewLazyDLL("gdi32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")

	pRegisterClassEx  = user32.NewProc("RegisterClassExW")
	pCreateWindowEx   = user32.NewProc("CreateWindowExW")
	pShowWindow       = user32.NewProc("ShowWindow")
	pUpdateWindow     = user32.NewProc("UpdateWindow")
	pGetMessage       = user32.NewProc("GetMessageW")
	pTranslateMessage = user32.NewProc("TranslateMessage")
	pDispatchMessage  = user32.NewProc("DispatchMessageW")
	pDefWindowProc    = user32.NewProc("DefWindowProcW")
	pPostQuitMessage  = user32.NewProc("PostQuitMessage")
	pBeginPaint       = user32.NewProc("BeginPaint")
	pEndPaint         = user32.NewProc("EndPaint")
	pGetSystemMetrics = user32.NewProc("GetSystemMetrics")
	pGetModuleHandle  = kernel32.NewProc("GetModuleHandleW")
	pGetClientRect    = user32.NewProc("GetClientRect")

	pCreateSolidBrush = gdi32.NewProc("CreateSolidBrush")
	pFillRect         = user32.NewProc("FillRect")
	pDeleteObject     = gdi32.NewProc("DeleteObject")
	pSetTextColor     = gdi32.NewProc("SetTextColor")
	pSetBkMode        = gdi32.NewProc("SetBkMode")
	pDrawTextW        = user32.NewProc("DrawTextW")
	pSelectObject     = gdi32.NewProc("SelectObject")
	pCreateFontW      = gdi32.NewProc("CreateFontW")
)

const (
	WS_OVERLAPPEDWINDOW = 0x00CF0000
	WS_VISIBLE          = 0x10000000
	CW_USEDEFAULT       = 0x80000000
	WM_DESTROY          = 0x0002
	WM_PAINT            = 0x000F
	SW_SHOW             = 5
	SM_CXSCREEN         = 0
	SM_CYSCREEN         = 1
	TRANSPARENT         = 1
	DT_CENTER           = 0x01
	DT_VCENTER          = 0x04
	DT_SINGLELINE       = 0x20
)

type WNDCLASSEX struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   syscall.Handle
	Icon       syscall.Handle
	Cursor     syscall.Handle
	Background syscall.Handle
	MenuName   *uint16
	ClassName  *uint16
	IconSm     syscall.Handle
}

type PAINTSTRUCT struct {
	HDC     syscall.Handle
	Erase   int32
	RcPaint RECT
	Pad     [40]byte
}

type RECT struct {
	Left, Top, Right, Bottom int32
}

type MSG struct {
	Hwnd    syscall.Handle
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      struct{ X, Y int32 }
}

func rgb(r, g, b byte) uintptr {
	return uintptr(r) | uintptr(g)<<8 | uintptr(b)<<16
}

var screenW, screenH int
var gridCols, gridRows = 8, 8
var fullscreen = false

func wndProc(hwnd syscall.Handle, msg uint32, wParam, lParam uintptr) uintptr {
	switch msg {
	case WM_PAINT:
		var ps PAINTSTRUCT
		hdc, _, _ := pBeginPaint.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&ps)))

		var rc RECT
		pGetClientRect.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&rc)))
		w := int(rc.Right)
		h := int(rc.Bottom)

		cellW := int32(w) / int32(gridCols)
		cellH := int32(h) / int32(gridRows)
		if cellW < 1 {
			cellW = 1
		}
		if cellH < 1 {
			cellH = 1
		}

		dark, _, _ := pCreateSolidBrush.Call(rgb(15, 23, 42))
		light, _, _ := pCreateSolidBrush.Call(rgb(30, 41, 59))

		for row := int32(0); row < int32(gridRows); row++ {
			for col := int32(0); col < int32(gridCols); col++ {
				r := RECT{col * cellW, row * cellH, (col + 1) * cellW, (row + 1) * cellH}
				brush := dark
				if (col+row)%2 == 0 {
					brush = light
				}
				pFillRect.Call(hdc, uintptr(unsafe.Pointer(&r)), brush)
			}
		}

		pDeleteObject.Call(dark)
		pDeleteObject.Call(light)

		green, _, _ := pCreateSolidBrush.Call(rgb(34, 197, 94))
		borders := []RECT{
			{0, 0, int32(w), 2},
			{0, int32(h) - 2, int32(w), int32(h)},
			{0, 0, 2, int32(h)},
			{int32(w) - 2, 0, int32(w), int32(h)},
		}
		for _, b := range borders {
			pFillRect.Call(hdc, uintptr(unsafe.Pointer(&b)), green)
		}
		pDeleteObject.Call(green)

		text := fmt.Sprintf("Grid: %dx%d  |  Resolution: %dx%d  |  Screen: %dx%d", gridCols, gridRows, w, h, screenW, screenH)
		textPtr, _ := syscall.UTF16PtrFromString(text)

		fontName, _ := syscall.UTF16PtrFromString("Consolas")
		font, _, _ := pCreateFontW.Call(
			uintptr(uint32(0xFFFFFFE0)),
			0, 0, 0, 700, 0, 0, 0, 0, 0, 0, 0, 0,
			uintptr(unsafe.Pointer(fontName)),
		)
		oldFont, _, _ := pSelectObject.Call(hdc, font)
		pSetTextColor.Call(hdc, rgb(34, 197, 94))
		pSetBkMode.Call(hdc, TRANSPARENT)

		textRect := RECT{0, 0, int32(w), int32(h)}
		pDrawTextW.Call(hdc, uintptr(unsafe.Pointer(textPtr)), ^uintptr(0),
			uintptr(unsafe.Pointer(&textRect)), DT_CENTER|DT_VCENTER|DT_SINGLELINE)

		pSelectObject.Call(hdc, oldFont)
		pDeleteObject.Call(font)

		pEndPaint.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&ps)))
		return 0

	case WM_DESTROY:
		pPostQuitMessage.Call(0)
		return 0
	}

	ret, _, _ := pDefWindowProc.Call(uintptr(hwnd), uintptr(msg), wParam, lParam)
	return ret
}

func main() {
	// Parse args: checkerboard.exe [-fullscreen] [cols] [rows]
	var numArgs []string
	for _, arg := range os.Args[1:] {
		if arg == "-fullscreen" || arg == "--fullscreen" {
			fullscreen = true
		} else {
			numArgs = append(numArgs, arg)
		}
	}
	if len(numArgs) >= 1 {
		if v, err := strconv.Atoi(numArgs[0]); err == nil && v > 0 {
			gridCols = v
		}
	}
	if len(numArgs) >= 2 {
		if v, err := strconv.Atoi(numArgs[1]); err == nil && v > 0 {
			gridRows = v
		}
	}
	if len(numArgs) == 1 {
		gridRows = gridCols
	}

	w, _, _ := pGetSystemMetrics.Call(SM_CXSCREEN)
	h, _, _ := pGetSystemMetrics.Call(SM_CYSCREEN)
	screenW = int(w)
	screenH = int(h)

	hInstance, _, _ := pGetModuleHandle.Call(0)

	className, _ := syscall.UTF16PtrFromString("CheckerboardWindow")
	windowTitle, _ := syscall.UTF16PtrFromString(fmt.Sprintf("Checkerboard %dx%d  |  Screen %dx%d", gridCols, gridRows, screenW, screenH))

	bgBrush, _, _ := pCreateSolidBrush.Call(rgb(10, 15, 26))

	wc := WNDCLASSEX{
		Size:       uint32(unsafe.Sizeof(WNDCLASSEX{})),
		WndProc:    syscall.NewCallback(wndProc),
		Instance:   syscall.Handle(hInstance),
		ClassName:  className,
		Background: syscall.Handle(bgBrush),
	}

	pRegisterClassEx.Call(uintptr(unsafe.Pointer(&wc)))

	var style uintptr = WS_OVERLAPPEDWINDOW | WS_VISIBLE
	winX, winY, winW, winH := uintptr(CW_USEDEFAULT), uintptr(CW_USEDEFAULT), uintptr(800), uintptr(600)
	if fullscreen {
		// WS_POPUP + full screen size = borderless fullscreen
		style = 0x80000000 | WS_VISIBLE // WS_POPUP | WS_VISIBLE
		winX, winY = 0, 0
		winW, winH = uintptr(screenW), uintptr(screenH)
	}

	hwnd, _, _ := pCreateWindowEx.Call(
		0,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(windowTitle)),
		style,
		winX, winY,
		winW, winH,
		0, 0, hInstance, 0,
	)

	pShowWindow.Call(hwnd, SW_SHOW)
	pUpdateWindow.Call(hwnd)

	var msg MSG
	for {
		ret, _, _ := pGetMessage.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
		if ret == 0 {
			break
		}
		pTranslateMessage.Call(uintptr(unsafe.Pointer(&msg)))
		pDispatchMessage.Call(uintptr(unsafe.Pointer(&msg)))
	}
}
