// Isolated CI target window. Never included in product installers. Count only
// real X11 input delivered to this window; reject XSendEvent synthetic messages.
#define _POSIX_C_SOURCE 200809L
#include <X11/Xlib.h>
#include <X11/Xatom.h>
#include <X11/Xutil.h>
#include <inttypes.h>
#include <signal.h>
#include <stdint.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t stopped;
static Display *display;
static Window window;
static uint64_t keys, clicks;

// Test-only close requester. Use the real WM protocol instead of destroying a
// window or killing its client. Recheck the target window's owning PID here.
static int close_owned_window(const char *window_id, const char *process_id) {
    char *end;
    if (*window_id < '0' || *window_id > '9' || *process_id < '0' || *process_id > '9') return 2;
    errno = 0;
    unsigned long target_window = strtoul(window_id, &end, 10);
    if (errno || *end || !target_window) return 2;
    errno = 0;
    unsigned long target_pid = strtoul(process_id, &end, 10);
    if (errno || *end || !target_pid || target_pid > UINT32_MAX) return 2;
    Display *connection = XOpenDisplay(NULL);
    if (!connection) return 1;
    Atom actual_type; int actual_format; unsigned long count, remaining; unsigned char *value = NULL;
    int status = XGetWindowProperty(connection, target_window, XInternAtom(connection, "_NET_WM_PID", False),
                                   0, 1, False, XA_CARDINAL, &actual_type, &actual_format, &count, &remaining, &value);
    int owned = status == Success && actual_type == XA_CARDINAL && actual_format == 32 && count == 1 && value && *(unsigned long *)value == target_pid;
    if (value) XFree(value);
    if (!owned) { XCloseDisplay(connection); return 2; }
    Atom close_message = XInternAtom(connection, "WM_DELETE_WINDOW", False), *protocols = NULL;
    int protocol_count = 0, supported = 0;
    if (XGetWMProtocols(connection, target_window, &protocols, &protocol_count)) {
        for (int i = 0; i < protocol_count; i++) if (protocols[i] == close_message) supported = 1;
    }
    if (protocols) XFree(protocols);
    if (!supported) { XCloseDisplay(connection); return 2; }
    XEvent event; memset(&event, 0, sizeof event);
    event.xclient.type = ClientMessage; event.xclient.window = target_window;
    event.xclient.message_type = XInternAtom(connection, "WM_PROTOCOLS", False); event.xclient.format = 32;
    event.xclient.data.l[0] = (long)close_message; event.xclient.data.l[1] = CurrentTime;
    int sent = XSendEvent(connection, target_window, False, NoEventMask, &event);
    XSync(connection, False); XCloseDisplay(connection);
    return sent ? 0 : 1;
}
static void stop(int signal_number) { (void)signal_number; stopped = 1; }
static void record(const char *event) {
    Window focused; int revert;
    XGetInputFocus(display, &focused, &revert);
    struct timespec now; struct tm utc; char stamp[32];
    clock_gettime(CLOCK_REALTIME, &now); gmtime_r(&now.tv_sec, &utc);
    strftime(stamp, sizeof stamp, "%Y-%m-%dT%H:%M:%S", &utc);
    printf("{\"schema_version\":1,\"type\":\"stream-kit-example-input\",\"event\":\"%s\","
           "\"process_id\":%ld,\"time\":\"%s.%03ldZ\",\"keys\":%" PRIu64 ",\"clicks\":%" PRIu64 ","
           "\"foreground\":%s,\"has_keyboard_focus\":%s}\n",
           event, (long)getpid(), stamp, now.tv_nsec / 1000000L, keys, clicks,
           focused == window ? "true" : "false", focused == window ? "true" : "false");
    fflush(stdout);
}
int main(int argc, char **argv) {
    if (argc > 1 && !strcmp(argv[1], "--close-owned-window"))
        return argc == 4 ? close_owned_window(argv[2], argv[3]) : 2;
    display = XOpenDisplay(NULL);
    if (!display) { fputs("No X11 display\n", stderr); return 1; }
    const int screen = DefaultScreen(display);
    window = XCreateSimpleWindow(display, RootWindow(display, screen), 50, 50, 960, 540, 0, 0, 0x142b40);
    XStoreName(display, window, "Stream Kit Input Acceptance");
    XClassHint hint = {"stream-kit-input", "StreamKitInputAcceptance"}; XSetClassHint(display, window, &hint);
    const unsigned long pid = (unsigned long)getpid();
    XChangeProperty(display, window, XInternAtom(display, "_NET_WM_PID", False), XA_CARDINAL, 32,
                    PropModeReplace, (const unsigned char *)&pid, 1);
    Atom close_message = XInternAtom(display, "WM_DELETE_WINDOW", False);
    XSetWMProtocols(display, window, &close_message, 1);
    XSelectInput(display, window, ExposureMask | KeyPressMask | ButtonPressMask | FocusChangeMask | StructureNotifyMask);
    GC graphics = XCreateGC(display, window, 0, NULL);
    signal(SIGTERM, stop); signal(SIGINT, stop);
    XMapWindow(display, window); XFlush(display);
    unsigned frame = 0; int ready = 0;
    while (!stopped) {
        while (XPending(display)) {
            XEvent event; XNextEvent(display, &event);
            if (event.xany.window != window) continue;
            if (event.type == MapNotify && !ready) { ready = 1; record("ready"); }
            if (event.type == KeyPress && !event.xkey.send_event) { keys++; record("key_down"); }
            if (event.type == ButtonPress && !event.xbutton.send_event) { clicks++; record("pointer_down"); }
            if (event.type == FocusIn || event.type == FocusOut) record("focus_changed");
            if (event.type == ClientMessage && (Atom)event.xclient.data.l[0] == close_message) stopped = 1;
        }
        XWindowAttributes bounds; XGetWindowAttributes(display, window, &bounds);
        for (int y=0; y<bounds.height; y+=60) for (int x=0; x<bounds.width; x+=60) {
            XSetForeground(display, graphics, ((x/60+y/60)%2) ? 0x254c69 : 0x142b40);
            XFillRectangle(display, window, graphics, x, y, 60, 60);
        }
        XSetForeground(display, graphics, 0x55ddaa);
        XFillRectangle(display, window, graphics, (int)(frame++ % 800), 80, 40, 20);
        char label[128]; snprintf(label, sizeof label, "Keys: %" PRIu64 "  Clicks: %" PRIu64, keys, clicks);
        XDrawString(display, window, graphics, 30, 40, label, (int)strlen(label)); XFlush(display);
        fd_set set; FD_ZERO(&set); FD_SET(ConnectionNumber(display), &set);
        struct timeval timeout = {0, 50000};
        (void)select(ConnectionNumber(display)+1, &set, NULL, NULL, &timeout);
    }
    record("closed"); XFreeGC(display, graphics); XDestroyWindow(display, window); XCloseDisplay(display);
    return 0;
}
