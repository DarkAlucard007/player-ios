Pod::Spec.new do |s|
  s.name         = 'LocalMedia'
  s.version      = '1.0.0'
  s.summary      = 'Local media picker, localmedia:// streaming and frame capture.'
  s.description  = <<-DESC
Capacitor plugin for the player app:
- UIDocumentPicker based local media import (videos + subtitle files)
- WKURLSchemeHandler serving cached files over localmedia:// with HTTP Range support
- Native frame capture (AVAssetImageGenerator) for screenshots / thumbnails
- Photo library export (add-only) for saving screenshots
DESC
  s.homepage     = 'https://github.com/DarkAlucard007/player-ios'
  s.license      = { :type => 'MIT', :file => 'LICENSE' }
  s.author       = { 'Alucard' => 'dev@alucard.local' }
  s.platform     = :ios, '14.0'
  # 本地 :path 开发 pod 不会真的去拉这个 git 源，但 CocoaPods 校验要求 source 属性存在
  s.source       = { :git => 'https://github.com/DarkAlucard007/player-ios.git', :tag => s.version.to_s }
  s.source_files   = 'Sources/**/*.{swift,h,mm}'
  # v1.1.17：播放自测样本（Big Buck Bunny 10 秒 788KB H.264+AAC）。
  # use_frameworks! 下 CocoaPods 会生成 LocalMedia.bundle 嵌进
  # LocalMedia.framework/，运行时 Bundle(for:).url(forResource:) 可取到。
  s.resources      = ['Resources/sample.mp4']
  s.dependency 'Capacitor'
  # v1.1.31：FFmpeg C shim——非 MP4 容器（MKV/AVI/FLV/RMVB/TS…）走原生 FFmpeg 解码播放
  s.dependency 'FFmpegShim'
  s.swift_version  = '5.0'
  # 注意：不要加 static_framework。use_frameworks! 下默认动态 framework 才会被
  # 嵌入 App.app/Frameworks/（校验脚本在那里找符号）；静态链接会进主二进制导致 MISSING SYMBOL
end
