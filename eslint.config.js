// ===========================================================================
// eslint.config.js — P4 工程化 / ESLint flat config (项目根目录)
//
// 设计约束:
//   * 纯静态项目, **不引入任何 npm 依赖** (不 import globals / @eslint/js 等),
//     因此浏览器全局用手写对象声明。
//   * 只 lint web/*.js; web/vendor/ 下的 three.js 是第三方 vendor, 一律排除。
//   * 现有代码存在大量 console.warn 与空的 try/catch 块, 所以只开启「无争议」
//     的正确性规则, 刻意不加 no-console / no-empty / eqeqeq / complexity 等
//     会产生大量误报的风格规则。
//
// 用法 (需要自行安装 eslint, 本文件本身不依赖它):
//   npx eslint .             # 或 eslint web/
// ===========================================================================

// 浏览器环境下 ESLint 默认不认识的全局。值 'readonly' 表示只读绑定,
// 'writable' 表示可写; 这里统一用 readonly, 现有代码也不会给它们赋值。
// 手写而非依赖 globals 包 —— 见文件头说明。
const browserGlobals = {
  // ---- window / document / DOM ----
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  history: 'readonly',
  screen: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  getComputedStyle: 'readonly',
  HTMLElement: 'readonly',
  HTMLCanvasElement: 'readonly',
  Element: 'readonly',
  Event: 'readonly',
  CustomEvent: 'readonly',
  MouseEvent: 'readonly',
  KeyboardEvent: 'readonly',
  PointerEvent: 'readonly',
  MutationObserver: 'readonly',
  ResizeObserver: 'readonly',
  DOMParser: 'readonly',
  Image: 'readonly',
  ImageData: 'readonly',
  ImageBitmap: 'readonly',
  OffscreenCanvas: 'readonly',
  createImageBitmap: 'readonly',
  FileReader: 'readonly',
  Blob: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  XMLHttpRequest: 'readonly',
  WebSocket: 'readonly',
  Worker: 'readonly',
  AudioContext: 'readonly',
  webkitAudioContext: 'readonly',
  WebGLRenderingContext: 'readonly',
  WebGL2RenderingContext: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',

  // ---- 控制台 / 计时器 / 动画帧 / 网络 ----
  console: 'readonly',
  performance: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  requestIdleCallback: 'readonly',
  cancelIdleCallback: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  queueMicrotask: 'readonly',
  fetch: 'readonly',
  alert: 'readonly',
  confirm: 'readonly',
  structuredClone: 'readonly',
  atob: 'readonly',
  btoa: 'readonly',
  crypto: 'readonly',

  // ---- 裸写 innerWidth / devicePixelRatio 之类的 window 属性 ----
  innerWidth: 'readonly',
  innerHeight: 'readonly',
  devicePixelRatio: 'readonly',
};

export default [
  // 全局忽略: 第三方 vendor、node_modules、以及非 JS 资源。
  // flat config 里 { ignores: [...] } 单独成项时表示全局忽略。
  {
    ignores: [
      'web/vendor/**',
      'node_modules/**',
      'tests/**',
      'assets/**',
      'hlsrc/**',
    ],
  },

  // 只 lint web/*.js (ES module + browser 全局)
  {
    files: ['web/*.js'],
    ignores: ['web/vendor/**'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: browserGlobals,
    },
    rules: {
      // ---- 正确性 ----
      'no-undef': 'error',
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      'no-constant-condition': 'error',
      'no-cond-assign': 'error',
      'no-irregular-whitespace': 'error',
      'no-sparse-arrays': 'error',
      'valid-typeof': 'error',
      'no-self-assign': 'error',

      // ---- 只警告: 现有代码里存在若干有意未使用的变量/参数 ----
      // args:'none' 忽略函数形参; varsIgnorePattern:'^_' 允许 _ 前缀占位符;
      // caughtErrors:'none' 忽略 catch (_) / catch (e) 的绑定 (现有代码大量
      // 用空 catch 做资源释放兜底)。未使用的模块级变量仍会 warn, 便于逐步清理。
      'no-unused-vars': ['warn', {
        args: 'none',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
    },
  },
];
