package main

import (
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
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
	pDestroyWindow    = user32.NewProc("DestroyWindow")
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
	pGetTextExtent    = gdi32.NewProc("GetTextExtentPoint32W")
)

const (
	WS_OVERLAPPEDWINDOW = 0x00CF0000
	WS_VISIBLE          = 0x10000000
	WS_EX_TOPMOST       = 0x00000008
	CW_USEDEFAULT       = 0x80000000
	WM_DESTROY          = 0x0002
	WM_PAINT            = 0x000F
	WM_KEYDOWN          = 0x0100
	VK_ESCAPE           = 0x1B
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
var initialToneOutput string
var initialInputDevice string
var initialToneCount = 1

func wndProc(hwnd syscall.Handle, msg uint32, wParam uintptr, lParam unsafe.Pointer) uintptr {
	switch msg {
	case 0x0024: // WM_GETMINMAXINFO: keep controls reachable at the minimum size.
		info := (*[10]int32)(lParam)
		info[6] = 640
		info[7] = 540
		return 0
	case 0x002B: // WM_DRAWITEM
		drawAudioButton((*drawItem)(lParam))
		return 1
	case 0x0014: // WM_ERASEBKGND: the canvas paints its own background.
		return 1
	case 0x0138: // WM_CTLCOLORSTATIC
		pSetTextColor.Call(wParam, rgb(210, 220, 235))
		gdi32.NewProc("SetBkColor").Call(wParam, rgb(15, 23, 42))
		return audioBackground
	case 0x0005: // WM_SIZE
		if probe != nil {
			layoutAudio(uintptr(hwnd))
		}
	case 0x0111: // WM_COMMAND
		if wParam>>16 == 0 {
			audioCommand(wParam & 0xffff)
		}
	case audioMessage:
		refreshAudio()
		return 0
	case 0x0113: // WM_TIMER: lightweight visual liveness and input counters.
		frameCount++
		pInvalidateRect.Call(uintptr(hwnd), 0, 0)
		return 0
	case 0x0201, 0x0204, 0x0207: // Pointer buttons on the test canvas.
		pointerCount++
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
		if audioBackground != 0 {
			panelWidth := w - 48
			if panelWidth > 840 {
				panelWidth = 840
			}
			panelX := (w - panelWidth) / 2
			panelY := h/2 - 160
			if panelY < 90 {
				panelY = 90
			}
			panel := RECT{int32(panelX - 12), int32(panelY - 12), int32(panelX + panelWidth + 12), int32(panelY + 336)}
			pFillRect.Call(hdc, uintptr(unsafe.Pointer(&panel)), audioBackground)
		}

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

		text := fmt.Sprintf("%dx%d  |  %dx%d  |  Tick %d  Keys %d  Clicks %d  |  Esc: Close", gridCols, gridRows, w, h, frameCount, inputCount, pointerCount)
		textPtr, _ := syscall.UTF16PtrFromString(text)

		fontName, _ := syscall.UTF16PtrFromString("Consolas")
		fontHeight := int32(-32)
		createFont := func(height int32) uintptr {
			font, _, _ := pCreateFontW.Call(
				uintptr(height),
				0, 0, 0, 700, 0, 0, 0, 0, 0, 0, 0, 0,
				uintptr(unsafe.Pointer(fontName)),
			)
			return font
		}
		font := createFont(fontHeight)
		oldFont, _, _ := pSelectObject.Call(hdc, font)
		var textSize struct{ Width, Height int32 }
		pGetTextExtent.Call(hdc, uintptr(unsafe.Pointer(textPtr)), uintptr(len(text)), uintptr(unsafe.Pointer(&textSize)))
		if available := int32(w) - 24; available > 0 && textSize.Width > available {
			fontHeight = fontHeight * available / textSize.Width
			if fontHeight > -1 {
				fontHeight = -1
			}
			pSelectObject.Call(hdc, oldFont)
			pDeleteObject.Call(font)
			font = createFont(fontHeight)
			pSelectObject.Call(hdc, font)
		}
		pSetTextColor.Call(hdc, rgb(34, 197, 94))
		pSetBkMode.Call(hdc, TRANSPARENT)

		textRect := RECT{0, 20, int32(w), 70}
		pDrawTextW.Call(hdc, uintptr(unsafe.Pointer(textPtr)), ^uintptr(0),
			uintptr(unsafe.Pointer(&textRect)), DT_CENTER|DT_VCENTER|DT_SINGLELINE)

		pSelectObject.Call(hdc, oldFont)
		pDeleteObject.Call(font)

		pEndPaint.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&ps)))
		return 0

	case WM_KEYDOWN:
		if wParam == VK_ESCAPE {
			lifecycle("escape", nil)
			pDestroyWindow.Call(uintptr(hwnd))
			return 0
		}
	case 0x0010: // WM_CLOSE; preserve normal system close handling below.
		lifecycle("window_close", nil)
	case WM_DESTROY:
		lifecycle("window_destroyed", nil)
		pKillTimer.Call(uintptr(hwnd), 1)
		pPostQuitMessage.Call(0)
		return 0
	}

	ret, _, _ := pDefWindowProc.Call(uintptr(hwnd), uintptr(msg), wParam, uintptr(lParam))
	return ret
}

func lifecycle(event string, err error) {
	fmt.Fprintf(os.Stderr, "%s example pid=%d event=%s error=%v\n", time.Now().UTC().Format(time.RFC3339Nano), os.Getpid(), event, err)
}

func main() {
	if err := runExample(); err != nil {
		lifecycle("failed", err)
		os.Exit(1)
	}
}

func runExample() error {
	// A Win32 window and its message pump must stay on the same OS thread.
	// Go may otherwise move this goroutine after a blocking syscall, leaving
	// the window unable to repaint or receive streamed keyboard/mouse input.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	// Parse args: checkerboard.exe [-fullscreen] [cols] [rows]
	var numArgs []string
	for _, arg := range os.Args[1:] {
		if arg == "-fullscreen" || arg == "--fullscreen" {
			fullscreen = true
		} else if strings.HasPrefix(arg, "--tone-output=") {
			initialToneOutput = strings.TrimPrefix(arg, "--tone-output=")
		} else if strings.HasPrefix(arg, "--input-device=") {
			initialInputDevice = strings.TrimPrefix(arg, "--input-device=")
		} else if strings.HasPrefix(arg, "--tone-count=") {
			count, err := strconv.Atoi(strings.TrimPrefix(arg, "--tone-count="))
			if err != nil || count < 1 || count > 30000 {
				fmt.Fprintln(os.Stderr, "tone-count must be between 1 and 30000")
				os.Exit(2)
			}
			initialToneCount = count
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

	if registered, _, err := pRegisterClassEx.Call(uintptr(unsafe.Pointer(&wc))); registered == 0 {
		return fmt.Errorf("register window class: %w", err)
	}

	var style uintptr = WS_OVERLAPPEDWINDOW | WS_VISIBLE | 0x02000000 // WS_CLIPCHILDREN
	var extendedStyle uintptr
	winX, winY, winW, winH := uintptr(CW_USEDEFAULT), uintptr(CW_USEDEFAULT), uintptr(800), uintptr(600)
	if fullscreen {
		// WS_POPUP + full screen size = borderless fullscreen
		style = 0x80000000 | WS_VISIBLE | 0x02000000 // WS_POPUP | WS_VISIBLE | WS_CLIPCHILDREN
		extendedStyle = WS_EX_TOPMOST
		winX, winY = 0, 0
		winW, winH = uintptr(screenW), uintptr(screenH)
	}

	hwnd, _, windowErr := pCreateWindowEx.Call(
		extendedStyle,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(windowTitle)),
		style,
		winX, winY,
		winW, winH,
		0, 0, hInstance, 0,
	)
	if hwnd == 0 {
		return fmt.Errorf("create window: %w", windowErr)
	}
	lifecycle("window_created", nil)

	pShowWindow.Call(hwnd, SW_SHOW)
	setupAudio(hwnd)
	defer probe.close()
	defer pDeleteObject.Call(audioFont)
	defer pDeleteObject.Call(audioBackground)
	pUpdateWindow.Call(hwnd)

	var msg MSG
	for {
		ret, _, err := pGetMessage.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
		if int32(ret) == -1 {
			pDestroyWindow.Call(hwnd)
			return fmt.Errorf("window message loop: %w", err)
		}
		if ret == 0 {
			lifecycle("message_loop_quit", nil)
			break
		}
		// Escape closes the owning example even while a child control has focus.
		if msg.Message == WM_KEYDOWN && msg.WParam == VK_ESCAPE {
			lifecycle("escape", nil)
			pDestroyWindow.Call(hwnd)
			continue
		}
		if msg.Message == WM_KEYDOWN {
			inputCount++
		}
		if handled, _, _ := user32.NewProc("IsDialogMessageW").Call(hwnd, uintptr(unsafe.Pointer(&msg))); handled != 0 {
			continue
		}
		pTranslateMessage.Call(uintptr(unsafe.Pointer(&msg)))
		pDispatchMessage.Call(uintptr(unsafe.Pointer(&msg)))
	}
	return nil
}
