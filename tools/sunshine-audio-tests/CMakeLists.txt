cmake_minimum_required(VERSION 3.25)
project(stream_kit_native_audio_tests LANGUAGES CXX)

if(NOT CMAKE_SYSTEM_NAME STREQUAL "Linux")
    message(FATAL_ERROR "The PulseAudio integration tests require a Linux build host")
endif()

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
get_filename_component(SUNSHINE_SOURCE "${CMAKE_CURRENT_SOURCE_DIR}/../../third_party/sunshine" ABSOLUTE)
set(INSTALL_GTEST OFF CACHE BOOL "" FORCE)
add_subdirectory("${SUNSHINE_SOURCE}/third-party/lizardbyte-common/third-party/googletest" googletest)
find_package(PkgConfig REQUIRED)
pkg_check_modules(PULSE REQUIRED IMPORTED_TARGET libpulse libpulse-simple)
pkg_check_modules(XCB_RES REQUIRED IMPORTED_TARGET xcb xcb-res xcb-composite xcb-shm xcb-xfixes)

# Compile the production backend and its normal Sunshine integration test unchanged.
# No GPU or video encoder is needed. Window ownership runs against an isolated Xvfb server.
add_executable(test_sunshine
    "${SUNSHINE_SOURCE}/src/platform/linux/application_audio.cpp"
    "${SUNSHINE_SOURCE}/src/platform/linux/application_target.cpp"
    "${SUNSHINE_SOURCE}/src/platform/linux/application_frame.cpp"
    "${SUNSHINE_SOURCE}/tests/integration/test_linux_application_audio.cpp"
    "${SUNSHINE_SOURCE}/tests/unit/test_linux_capture_target.cpp")
target_include_directories(test_sunshine PRIVATE "${SUNSHINE_SOURCE}")
target_compile_options(test_sunshine PRIVATE -Wall -Wextra -Werror)
target_compile_definitions(test_sunshine PRIVATE SUNSHINE_BUILD_X11)
target_link_libraries(test_sunshine PRIVATE PkgConfig::PULSE PkgConfig::XCB_RES GTest::gtest_main)
enable_testing()
add_test(NAME native_audio COMMAND test_sunshine)
set_tests_properties(native_audio PROPERTIES TIMEOUT 30)
