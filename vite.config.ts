import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

// 版本号唯一来源：package.json（构建时注入前端，禁止硬编码）
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version)
  },
  // 用相对路径，打包产物才能放进任意目录
  base: './',
  server: {
    host: '0.0.0.0',
    allowedHosts: true
  },
  build: {
    target: 'es2020',
    // 图标等小资源不内联（内联逻辑在 scripts/inline-assets.mjs 里统一做）
    assetsInlineLimit: 0,
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // ⚠ 必须只有一个 JS chunk，且不能有动态 import()。
        //
        // 打包产物会被 scripts/inline-assets.mjs 整体内联进 dist/index.html。
        // 内联后的 import("./chunk.js") 会相对文档解析到 dist/ 根目录，
        // 而真实文件在 dist/assets/ → 真机上直接 404，
        // 表现为「功能静默失效」（事件监听器压根没注册）。
        //
        // 出现多个 chunk 时 scripts/inline-assets.mjs 会直接让构建失败。
        inlineDynamicImports: true
      }
    }
  }
});
