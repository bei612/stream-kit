/* Verify source-built codec registration without opening any GPU/audio device. */
#include <stdio.h>
#include <libavcodec/avcodec.h>
#include <libavutil/avutil.h>

int main(void) {
    const char *names[] = {
        "libx264", "libx265", "libsvtav1",
#ifdef _WIN32
        "h264_nvenc", "hevc_nvenc", "av1_nvenc", "h264_amf", "h264_mf", "h264_qsv",
#endif
    };
    printf("FFmpeg %s\n", av_version_info());
    for (unsigned i = 0; i < sizeof(names) / sizeof(names[0]); ++i) {
        if (!avcodec_find_encoder_by_name(names[i])) {
            fprintf(stderr, "Missing encoder: %s\n", names[i]);
            return 1;
        }
        printf("Registered encoder: %s\n", names[i]);
    }
    return 0;
}
