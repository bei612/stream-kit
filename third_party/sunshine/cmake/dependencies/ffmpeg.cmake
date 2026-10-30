# Stream-Kit builds the vendored build-deps sources before Sunshine. Never infer
# dependency versions from the enclosing monorepo or download a "latest" bundle.
include_guard(GLOBAL)

set(FFMPEG_PREPARED_BINARIES "" CACHE PATH "Installed prefix of the source-built Sunshine FFmpeg dependencies")
if(NOT IS_DIRECTORY "${FFMPEG_PREPARED_BINARIES}")
    message(FATAL_ERROR
            "Build third-party/build-deps first, then set FFMPEG_PREPARED_BINARIES "
            "to its installed ffmpeg directory. Automatic binary downloads are disabled.")
endif()

message(STATUS "Using source-built FFmpeg prefix: ${FFMPEG_PREPARED_BINARIES}")
if(NOT DEFINED FFMPEG_PLATFORM_LIBRARIES)
    if(WIN32)
        set(FFMPEG_PLATFORM_LIBRARIES mfplat ole32 strmiids mfuuid vpl)
    elseif(FREEBSD)
        set(FFMPEG_PLATFORM_LIBRARIES va va-drm va-x11 X11)
    elseif(UNIX AND NOT APPLE)
        set(FFMPEG_PLATFORM_LIBRARIES numa va va-drm va-x11 X11)
    endif()
endif()

set(FFMPEG_LIBRARIES "")
foreach(library avcodec swscale avutil cbs SvtAv1Enc x264 x265)
    set(archive "${FFMPEG_PREPARED_BINARIES}/lib/lib${library}.a")
    if(NOT EXISTS "${archive}")
        message(FATAL_ERROR "Incomplete FFmpeg build: missing ${archive}")
    endif()
    list(APPEND FFMPEG_LIBRARIES "${archive}")
endforeach()
if(EXISTS "${FFMPEG_PREPARED_BINARIES}/lib/libhdr10plus.a")
    list(APPEND FFMPEG_LIBRARIES "${FFMPEG_PREPARED_BINARIES}/lib/libhdr10plus.a")
endif()
list(APPEND FFMPEG_LIBRARIES ${FFMPEG_PLATFORM_LIBRARIES})
set(FFMPEG_INCLUDE_DIRS "${FFMPEG_PREPARED_BINARIES}/include")
if(NOT EXISTS "${FFMPEG_INCLUDE_DIRS}/libavcodec/avcodec.h")
    message(FATAL_ERROR "Incomplete FFmpeg build: missing installed headers")
endif()
