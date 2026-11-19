import type { CapacitorConfig } from '@capacitor/cli';

// ⚠ appId / appName 与 app.config.json 保持一致。
const config: CapacitorConfig = {
  appId: 'com.alucard.player',
  appName: '视频播放器',
  webDir: 'dist',
  backgroundColor: '#ffffff',
  ios: {
    // 必须用 never：'always' 会让安全区被计算两遍（顶部留白、底栏不贴底）。
    contentInset: 'never'
  }
};

export default config;
