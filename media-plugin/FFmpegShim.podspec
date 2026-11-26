Pod::Spec.new do |s|
  s.name         = 'FFmpegShim'
  s.version      = '1.0.0'
  s.summary      = 'C shim exposing FFmpeg static-lib headers to Swift'
  s.description  = 'Header-only module that #includes the FFmpeg (libavformat/libavcodec/libavutil/libswscale/libswresample) public headers so the LocalMedia Swift framework can call the C API. The .a files are built by the CI workflow into ../ffmpeg and linked here.'
  s.homepage     = 'https://example.local/ffmpegshim'
  s.license      = { :type => 'LGPL-2.1' }
  s.author       = { 'Alucard' => 'endtime@163.com' }
  s.platform     = :ios, '14.0'
  s.source       = { :path => '.' }
  s.source_files = 'FFmpegShim/**/*.{h,m}'
  s.xcconfig = {
    'HEADER_SEARCH_PATHS'    => '$(PODS_TARGET_SRCROOT)/../ffmpeg/include',
    'LIBRARY_SEARCH_PATHS'   => '$(PODS_TARGET_SRCROOT)/../ffmpeg/lib',
    'GCC_PREPROCESSOR_DEFINITIONS' => 'HAVE_SYS_QUEUE_H=1'
  }
  s.libraries   = 'avformat', 'avcodec', 'avutil', 'swscale', 'swresample', 'bz2', 'z', 'c'
  s.frameworks  = 'CoreMedia', 'VideoToolbox', 'CoreVideo', 'CoreFoundation', 'AudioToolbox', 'AVFoundation', 'CoreGraphics', 'CoreImage', 'Metal'
  s.swift_version = '5.0'
end
