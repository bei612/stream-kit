// Isolated CI program: its visible X11 window and actual paplay child are one
// process tree. No audio bypass, loopback renderer, or production test hook.
#define _POSIX_C_SOURCE 200809L
#include <X11/Xlib.h>
#include <X11/Xatom.h>
#include <X11/Xutil.h>
#include <errno.h>
#include <math.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <sys/wait.h>
#include <unistd.h>

static volatile sig_atomic_t stopped;
static void stop(int number) { (void)number; stopped = 1; }
int main(int argc, char **argv) {
    const char *sink = NULL; long count = 0;
    for (int i = 1; i < argc; i++) {
        if (!strncmp(argv[i], "--tone-output=", 14)) sink = argv[i] + 14;
        else if (!strncmp(argv[i], "--tone-count=", 13)) { char *end; count = strtol(argv[i]+13, &end, 10); if (*end) return 2; }
        else return 2;
    }
    if (!sink || !*sink || count < 1 || count > 30000) return 2;
    Display *display = XOpenDisplay(NULL); if (!display) return 1;
    Window window = XCreateSimpleWindow(display, DefaultRootWindow(display), 30, 30, 960, 540, 0, 0, 0x142b40);
    XStoreName(display, window, "Stream Kit Native Audio Acceptance");
    XClassHint hint = {"stream-kit-audio", "StreamKitAudioAcceptance"}; XSetClassHint(display, window, &hint);
    const unsigned long pid = (unsigned long)getpid();
    XChangeProperty(display, window, XInternAtom(display, "_NET_WM_PID", False), XA_CARDINAL, 32, PropModeReplace, (const unsigned char *)&pid, 1);
    XSelectInput(display, window, ExposureMask | StructureNotifyMask);
    XMapWindow(display, window); XFlush(display);
    int pipefd[2]; if (pipe(pipefd)) return 1;
    const pid_t child = fork(); if (child < 0) return 1;
    if (!child) {
        close(pipefd[1]); if (dup2(pipefd[0], STDIN_FILENO) < 0) _exit(127); close(pipefd[0]);
        execlp("paplay", "paplay", "--raw", "--format=s16le", "--rate=48000", "--channels=1", "--device", sink, (char *)NULL); _exit(127);
    }
    close(pipefd[0]); signal(SIGPIPE, SIG_IGN); signal(SIGTERM, stop); signal(SIGINT, stop);
    printf("{\"type\":\"stream-kit-audio-program\",\"process_id\":%ld,\"audio_process_id\":%ld,\"frequency_hz\":997,\"sample_rate\":48000}\n", (long)getpid(), (long)child); fflush(stdout);
    GC graphics = XCreateGC(display, window, 0, NULL);
    uint64_t frame = 0; int failed = 0, child_alive = 1;
    while (!stopped && frame < (uint64_t)count * 3 * 48000) {
        while (XPending(display)) { XEvent event; XNextEvent(display, &event); }
        int status; if (waitpid(child, &status, WNOHANG) == child) { failed = 1; child_alive = 0; break; }
        XSetForeground(display, graphics, (frame / 960 % 2) ? 0x254c69 : 0x142b40); XFillRectangle(display, window, graphics, 0, 0, 960, 540);
        XSetForeground(display, graphics, 0x55ddaa); XFillRectangle(display, window, graphics, (int)(frame / 960 % 850), 80, 40, 20);
        const char *label = "Real application audio: paplay child / 997 Hz";
        XDrawString(display, window, graphics, 30, 40, label, (int)strlen(label)); XFlush(display);
        unsigned char pcm[1920];
        for (int i = 0; i < 960; i++) {
            const int16_t sample = (int16_t)lrint(6000 * sin(6.283185307179586 * 997 * (double)(frame + (uint64_t)i) / 48000));
            pcm[i*2] = (unsigned char)((uint16_t)sample & 255); pcm[i*2+1] = (unsigned char)((uint16_t)sample >> 8);
        }
        size_t sent = 0;
        while (sent < sizeof pcm && !stopped) { ssize_t n = write(pipefd[1], pcm+sent, sizeof pcm-sent); if (n > 0) sent += (size_t)n; else if (n < 0 && errno == EINTR) continue; else { failed = 1; stopped = 1; } }
        frame += 960;
        struct timeval pause = {0, 20000}; (void)select(0, NULL, NULL, NULL, &pause);
    }
    close(pipefd[1]); if (child_alive) { kill(child, SIGTERM); while (waitpid(child, NULL, 0) < 0 && errno == EINTR) {} }
    XFreeGC(display, graphics); XDestroyWindow(display, window); XCloseDisplay(display); return failed;
}
