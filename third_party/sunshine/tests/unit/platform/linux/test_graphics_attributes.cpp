/**
 * @file tests/unit/platform/linux/test_graphics_attributes.cpp
 * @brief Validate DMA-BUF attribute serialization without opening a graphics device.
 */
#ifdef __linux__
  #include <drm_fourcc.h>
  #include <gtest/gtest.h>

  #include "src/platform/linux/graphics.h"

namespace {
  TEST(GraphicsAttributes, FourPlanesPreserveModifierBitsAndTermination) {
    egl::surface_descriptor_t surface {};
    surface.width = 1920;
    surface.height = 1080;
    surface.fourcc = DRM_FORMAT_XRGB8888;
    surface.modifier = 0xFEDCBA9887654321ULL;
    for (int plane = 0; plane < 4; ++plane) {
      surface.fds[plane] = 40 + plane;
      surface.offsets[plane] = 4096 * plane;
      surface.pitches[plane] = 7680;
    }
    const auto attributes = egl::surface_descriptor_to_egl_attribs(surface);
    ASSERT_EQ(attributes.size(), 47);
    EXPECT_EQ(attributes[0], EGL_WIDTH);
    EXPECT_EQ(attributes[1], 1920);
    EXPECT_EQ(attributes[2], EGL_HEIGHT);
    EXPECT_EQ(attributes[3], 1080);
    EXPECT_EQ(attributes[4], EGL_LINUX_DRM_FOURCC_EXT);
    EXPECT_EQ(attributes[5], DRM_FORMAT_XRGB8888);
    for (int plane = 0; plane < 4; ++plane) {
      const auto base = 6 + plane * 10;
      EXPECT_EQ(attributes[base + 1], 40 + plane);
      EXPECT_EQ(attributes[base + 3], 4096 * plane);
      EXPECT_EQ(attributes[base + 5], 7680);
      EXPECT_EQ(attributes[base + 7], 0x87654321ULL);
      EXPECT_EQ(attributes[base + 9], 0xFEDCBA98ULL);
    }
    EXPECT_EQ(attributes[36], EGL_DMA_BUF_PLANE3_FD_EXT);
    EXPECT_EQ(attributes[42], EGL_DMA_BUF_PLANE3_MODIFIER_LO_EXT);
    EXPECT_EQ(attributes[44], EGL_DMA_BUF_PLANE3_MODIFIER_HI_EXT);
    EXPECT_EQ(attributes.back(), EGL_NONE);
  }

  TEST(GraphicsAttributes, MissingPlanesAndInvalidModifierAreOmitted) {
    egl::surface_descriptor_t surface {};
    surface.modifier = DRM_FORMAT_MOD_INVALID;
    for (auto &fd : surface.fds) {
      fd = -1;
    }
    auto attributes = egl::surface_descriptor_to_egl_attribs(surface);
    ASSERT_EQ(attributes.size(), 7);
    EXPECT_EQ(attributes.back(), EGL_NONE);
    surface.fds[2] = 55;
    surface.pitches[2] = 512;
    surface.offsets[2] = 1024;
    attributes = egl::surface_descriptor_to_egl_attribs(surface);
    ASSERT_EQ(attributes.size(), 13);
    EXPECT_EQ(attributes[6], EGL_DMA_BUF_PLANE2_FD_EXT);
    EXPECT_EQ(attributes[7], 55);
    EXPECT_EQ(attributes[8], EGL_DMA_BUF_PLANE2_OFFSET_EXT);
    EXPECT_EQ(attributes[9], 1024);
    EXPECT_EQ(attributes[10], EGL_DMA_BUF_PLANE2_PITCH_EXT);
    EXPECT_EQ(attributes[11], 512);
    EXPECT_EQ(attributes.back(), EGL_NONE);
  }
}  // namespace
#endif
