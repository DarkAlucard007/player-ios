/// <reference types="vite/client" />

// 构建时由 vite.config.ts 的 define 从 package.json 注入（版本号唯一来源，禁止硬编码）
declare const __APP_VERSION__: string;
