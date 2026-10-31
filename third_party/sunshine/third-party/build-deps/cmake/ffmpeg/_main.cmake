if(WIN32)
    set(BUILD_FFMPEG_LIBVA OFF)
    set(BUILD_FFMPEG_VULKAN OFF)

    # We must disable CUDA and NVENC on ARM64 until following issues is resolved
    # https://github.com/FFmpeg/FFmpeg/blob/4e5523c98597a417eb43555933b1075d18ec5f8b/configure#L7443
    if (${arch} STREQUAL "arm64")
        set(BUILD_FFMPEG_NV_CODEC_HEADERS OFF)
    endif()
elseif(APPLE)
    set(BUILD_FFMPEG_AMF OFF)
    set(BUILD_FFMPEG_MF OFF)
    set(BUILD_FFMPEG_NV_CODEC_HEADERS OFF)
    set(BUILD_FFMPEG_LIBVA OFF)
    set(BUILD_FFMPEG_VULKAN OFF)
elseif(FREEBSD)
    set(BUILD_FFMPEG_AMF OFF)
    set(BUILD_FFMPEG_MF OFF)
    if(${arch} STREQUAL "aarch64")
        set(BUILD_FFMPEG_NV_CODEC_HEADERS OFF)
    endif()
elseif(UNIX)
    set(BUILD_FFMPEG_MF OFF)
endif()

include(${CMAKE_CURRENT_SOURCE_DIR}/cmake/prepare_source_tree.cmake)
get_cmake_property(_source_options VARIABLES)
list(FILTER _source_options INCLUDE REGEX "^BUILD_FFMPEG")
list(SORT _source_options)
set(_patch_selection "")
foreach(_option IN LISTS _source_options)
    list(APPEND _patch_selection "${_option}=${${_option}}")
endforeach()
PREPARE_SOURCE_TREE("${CMAKE_CURRENT_SOURCE_DIR}/third-party/FFmpeg"
        "${CMAKE_CURRENT_SOURCE_DIR}/patches/FFmpeg"
        "${CMAKE_CURRENT_BINARY_DIR}/prepared-sources" "${_patch_selection}" FFMPEG_SOURCE_ROOT)
set(FFMPEG_GENERATED_SRC_PATH "${FFMPEG_SOURCE_ROOT}/FFmpeg")
set(AVCODEC_GENERATED_SRC_PATH "${FFMPEG_SOURCE_ROOT}/libavcodec")

set(_original_cmake_install_prefix ${CMAKE_INSTALL_PREFIX})
set(CMAKE_INSTALL_PREFIX ${FFMPEG_INSTALL_PREFIX})

if(BUILD_FFMPEG_AMF)
    include(${CMAKE_CURRENT_SOURCE_DIR}/cmake/ffmpeg/amf.cmake)
endif()

if(BUILD_FFMPEG_MF)
    include(${CMAKE_CURRENT_SOURCE_DIR}/cmake/ffmpeg/mf.cmake)
endif()

if(BUILD_FFMPEG_NV_CODEC_HEADERS)
    include(${CMAKE_CURRENT_SOURCE_DIR}/cmake/ffmpeg/nv_codec_headers.cmake)
endif()

if(BUILD_FFMPEG_SVT_AV1)
    include(${CMAKE_CURRENT_SOURCE_DIR}/cmake/ffmpeg/svt_av1.cmake)
endif()

if(BUILD_FFMPEG_LIBVA)
    include(${CMAKE_CURRENT_SOURCE_DIR}/cmake/ffmpeg/libva.cmake)
endif()

if(BUILD_FFMPEG_VULKAN)
    include(${CMAKE_CURRENT_SOURCE_DIR}/cmake/ffmpeg/vulkan.cmake)
endif()

if(BUILD_FFMPEG_X264)
    include(${CMAKE_CURRENT_SOURCE_DIR}/cmake/ffmpeg/x264.cmake)
endif()

if(BUILD_FFMPEG_X265)
    include(${CMAKE_CURRENT_SOURCE_DIR}/cmake/ffmpeg/x265.cmake)
endif()

include(${CMAKE_CURRENT_SOURCE_DIR}/cmake/ffmpeg/ffmpeg.cmake)

set(CMAKE_INSTALL_PREFIX ${_original_cmake_install_prefix})
