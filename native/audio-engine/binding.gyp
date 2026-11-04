{
  "targets": [
    {
      "target_name": "resonant_audio",
      "sources": ["src/addon.cc", "src/engine.cc"],
      "include_dirs": ["<!(node -p \"require('node-addon-api').include_dir\")"],
      "defines": ["NAPI_VERSION=8", "NAPI_CPP_EXCEPTIONS"],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "MACOSX_DEPLOYMENT_TARGET": "11.0",
        "GCC_OPTIMIZATION_LEVEL": "2"
      },
      "link_settings": {
        "libraries": ["-framework CoreAudio", "-framework AudioToolbox", "-framework CoreFoundation"]
      }
    }
  ]
}
