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
  s.source_files   = 'Sources/**/*.swift'
  s.dependency 'Capacitor'
  s.swift_version  = '5.0'
  s.static_framework = true
end
