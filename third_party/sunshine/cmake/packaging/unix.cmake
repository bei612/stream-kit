# unix specific packaging
# put anything here that applies to both linux and macos

# return here if building a macos .app
if(APPLE AND NOT SUNSHINE_BUILD_HOMEBREW)
    return()
endif()

# Installation destination dir
set(CPACK_SET_DESTDIR true)
if(NOT CMAKE_INSTALL_PREFIX)
    set(CMAKE_INSTALL_PREFIX "/usr/share/sunshine")
endif()

install(TARGETS sunshine RUNTIME DESTINATION "${CMAKE_INSTALL_BINDIR}")

if(UNIX AND NOT APPLE AND NOT FREEBSD AND FFMPEG_VULKAN_RUNTIME)
    # Keep the pinned loader private to this installation. Build-tree targets
    # retain CMake's SDK RPATH; installation replaces it with a relocatable one.
    file(REAL_PATH "${FFMPEG_VULKAN_RUNTIME}" _vulkan_runtime)
    file(RELATIVE_PATH _private_lib_from_bin "${CMAKE_INSTALL_FULL_BINDIR}" "${CMAKE_INSTALL_FULL_LIBDIR}/stream-kit")
    set_property(TARGET sunshine APPEND PROPERTY INSTALL_RPATH "$ORIGIN/${_private_lib_from_bin}")
    install(FILES "${_vulkan_runtime}" DESTINATION "${CMAKE_INSTALL_LIBDIR}/stream-kit" RENAME libvulkan.so.1)
    unset(_vulkan_runtime)
    unset(_private_lib_from_bin)
endif()
