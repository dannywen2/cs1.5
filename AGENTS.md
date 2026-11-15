# AGENTS.md — cs_demo（CS 1.5 three.js 复刻版）

给在此仓库工作的 AI 代理的项目说明。各子目录的详细文档见 `web/README.md`、
`tests/README.md`、`hlsrc/README.md`。

## 项目概览

把 CS 1.5 复刻版（原 Python + Ursina）整体移植到浏览器：three.js 0.187.0（本地
vendor，无 CDN）、纯 ES modules、**无 npm install、无打包、无构建步骤**。
原版烘焙资产（`assets/` 下的 `dust2.geo/.nav/.col/.hit`、贴图、MDL 模型、音效、
雷达图）全部直接复用，浏览器端 `fetch` + `DataView` 解析，不重新烘焙。

## 运行 / 开发

```powershell
python serve.py            # http://127.0.0.1:8080/web/
python serve.py 9000       # 指定端口
```

- `serve.py` 是带路径白名单的静态服务器（根目录为文档根）：只放行 `web/` 与游戏
  资产；`web/vendor/`、`assets/tex|sky|player|vm|sfx/`、`dust2.*`。`.git/`、
  `hlsrc/`、`_tools/` 一律 404，且不提供目录列表。
- 启动时浏览器并行拉 100+ 文件，`serve.py` 的 listen backlog 提到 128，别改小。
- 改 JS 后刷新即生效（`Cache-Control: no-store`），无需任何构建。
- 浏览器要求 WebGL2 + ES modules + Pointer Lock。

## 测试 / lint

```powershell
node tests/smoke.mjs                       # 无头回归：7 组断言 + 5 视角截图基线比对
node tests/smoke.mjs --update-baselines    # 画面有意变更后重建基线
npx --yes eslint@9 web/                    # lint（零 npm 依赖配置，见 eslint.config.js）
```

- Node ≥ 22，headless Edge/Chrome（可用 `CS_BROWSER` / `CS_PYTHON` 指定）。
- 页面入口 `?auto=1`：`boot()` 写 `window.__CS__ = { S, A }`，断言经 `page.evaluate` 读取。
- 基线依赖渲染环境（swiftshader/驱动/Edge 版本），换环境后用 `--update-baselines` 重建。
- 已知缺陷与限制见 `tests/README.md` §4（如死亡后下回合不补发默认手枪、
  换边后 C4 carrier 缺失、`BUY_CATEGORIES.gear` 缺 smoke）。

## 目录结构

| 路径 | 说明 |
|---|---|
| `serve.py` | 静态服务器（路径白名单 + no-store + backlog 128） |
| `web/index.html` / `style.css` | HUD / 菜单 / 加载页 DOM 与样式 |
| `web/main.js` | 启动、主循环、输入、Web Audio、HUD、雷达 |
| `web/state.js` | 全局状态 `S` 与跨模块钩子 `A.hooks` |
| `web/asset.js` | 二进制资产解析、BSP 碰撞、nav 网格、A*、模型加载 |
| `web/engine.js` | 渲染（世界/天空/枪模）、玩家物理、射击射线 |
| `web/game.js` | Bot AI、C4/回合状态机、经济、购买、投掷物 |
| `web/vendor/` | three.js 0.187.0（本地，勿改） |
| `assets/` | 原版烘焙资产（未改动，勿手改） |
| `hlsrc/` | 资产生成脚本（BSP/MDL/WAD 烘焙），见其 README |
| `tests/` | 无头回归 `smoke.mjs` + 截图基线，见其 README |
| `_tools/` | 第三方二进制/解包工具，勿对外提供，一般无需触碰 |

## 关键约定（改代码前必读）

- **坐标系**：x 右 / y 上 / z 前，yaw=0 朝 +z。GoldSrc BSP `(x,y,z)` 在
  `buildWorldMeshes` 里镜像映射为 `(x,z,y)`（行列式 −1），因此每个三角形**反转绕序**，
  UV 做 `(u,-v)`。
- **碰撞文件分工**：`dust2.col` = hull1 clipnode（玩家移动）；`dust2.hit` = hull0
  渲染 BSP（子弹/视线）；`dust2.nav` = 16 单位多层导航格（Bot 寻路）。
  三者及 `.geo` 都是自定义二进制格式，与 `web/asset.js` 的解析函数一一对应：
  **改烘焙端（hlsrc）必须同步改解析端（asset.js），反之亦然**。
- **格式 v2**：`dust2.col` / `dust2.hit` 尾部追加了 `func_breakable` 等 brush
  实体的独立子树（根节点 + 包围盒）——漏掉它们箱子就能被穿透。相关约定详见
  `hlsrc/README.md`。
- **弹道**：`raySolidDistance` 沿 BSP 平面精确求交；`hitSolid`（步进采样）只用于
  视线/网格点测试。别用步进法做弹道命中——会跨过 8 单位以下的薄墙。
- **材质**：所有模型/贴图显式 `transparent:false`；世界几何
  `MeshBasicMaterial + DoubleSide`。这是为了杜绝旧版"墙壁透明 / bot 抢模型节点"
  两类 bug，不要引入隐式透明状态；bot 几何必须各自独立（只缓存 typed array 模板）。
- **渲染顺序**：天空盒 scene（关深度）→ 清深度 → 世界 → 清深度 → 第一人称枪模
  scene（关深度）。
- **音频**：每个 wav 解码成 AudioBuffer，每次播放新建 BufferSourceNode，不能复用
  单一 source（急促音效会互相截断）。
- **资产在 `serve.py` 白名单里**：新增对外提供的文件/扩展名需同步更新
  `serve.py` 的 `ALLOW_*` / `ALLOW_EXT`。

## 代码风格

- 纯 ES modules，`web/*.js` 间靠 `state.js` 的 `S` / `A` 钩子通信，无框架。
- `eslint.config.js` 是零依赖 flat config，只 lint `web/*.js`、忽略 `web/vendor/`；
  浏览器全局是手写 `browserGlobals` 列表——新代码用了新全局要加进去。
- 规则集刻意保守（未开 `no-console` / `no-empty` / `eqeqeq`），别顺手加严规则制造误报。
- 中文注释与文档是项目惯例，新增文档/注释请用中文。

## 修改纪律

- 不要手改 `assets/` 下的烘焙产物；需要变化走 `hlsrc/` 烘焙脚本（依赖 pillow /
  panda3d，需要原版 CS 1.5 安装目录，路径见各脚本顶部常量）。
- `tests/` 是纯新增目录，不依赖业务代码改动；加断言遵循 `tests/README.md` §3。
- 改完受影响的模块后运行 `node tests/smoke.mjs`；画面有意变更时重建基线。
