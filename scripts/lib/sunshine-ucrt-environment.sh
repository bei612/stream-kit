# An MSVC build and a MinGW/UCRT build must not share SDK search variables.
# This function changes only its calling shell (the renderer build process).
sunshine_ucrt_environment() {
  [[ "${MSYSTEM:-}" == UCRT64 ]] || { echo 'Use the native MSYS2 UCRT64 environment' >&2; return 1; }
  unset LIB LIBPATH INCLUDE VCINSTALLDIR VCToolsInstallDir VCToolsVersion
  unset VSINSTALLDIR WindowsSdkDir WindowsSDKDir WindowsSDKVersion UniversalCRTSdkDir UCRTVersion
}
