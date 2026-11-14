# CS 1.5 复刻版 · P4 工程化测试与 lint

本目录是新增的测试/文档；业务代码（`web/*.js`、`serve.py`、`web/index.html`、
`web/style.css`、`web/package.json`）由主流程同步维护，测试脚本本身不写入它们。

| 文件 | 说明 |
|---|---|
| `tests/smoke.mjs` | 自包含的无头回归脚本：启动 `serve.py`、驱动 headless Edge/Chrome、先验证非 auto 主菜单，再执行 P1/P2 契约与 1~7b 组断言、5 视角截图基线比对 |
| `tests/README.md` | 本文档 |
| `tests/baselines/*.png` | 5 个固定视角的截图基线（首次运行自动创建 / `--update-baselines` 生成） |
| `eslint.config.js` | 项目根目录的 ESLint flat config（零 npm 依赖，只 lint `web/*.js`） |

> 本工作区在脚本自检时用 headless Edge 157 + swiftshader 生成了 5 张基线 PNG，
> 因此首次完整回归会直接做像素比对（而不是提示「基线不存在」）。换浏览器/显卡后
> 请用 `--update-baselines` 重建，见「当前已知限制」第 5 条。

---

## 1. 运行

在项目根目录执行（**不需要 `npm install`**）：

```powershell
node tests/smoke.mjs                       # 完整回归：断言 + 截图基线比对
node tests/smoke.mjs --update-baselines    # 只写 5 张基线 PNG，跳过断言与比对
node tests/smoke.mjs --help                # 显示命令行说明
```

也可从 `web/` 目录用 `npm test` / `npm run test:update-baselines`（`web/package.json`
已配置相应 scripts）。

`eslint.config.js` 本身不需要安装任何东西，但**执行 lint 需要 ESLint**（本脚本不依赖它）：

```powershell
npx --yes eslint@9 web/       # 临时使用，不修改 package.json
# 或全局安装后：eslint web/
```

### 依赖要求

| 依赖 | 要求 | 说明 |
|---|---|---|
| Node.js | >= 22（推荐 24） | 零依赖 CDP 后端依赖全局 `WebSocket` + `fetch`；本工作区为 `v24.14.0` |
| Python | 3.x，且 PATH 里能找到 `python` | 用于 `python serve.py <随机空闲端口>`；本工作区为 `3.14.4` |
| Edge / Chrome | 本机已安装 | 本工作区：`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`（`Edg/157.0.4341.46`） |
| playwright / puppeteer | **可选** | 装了就优先用；没装自动回退到内置 CDP 客户端（见下） |
| sharp | **不需要** | 截图比对用纯 Node 的 PNG 解码器 + zlib 实现 |

可用环境变量：

```powershell
$env:CS_BROWSER = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$env:CS_PYTHON  = "python"
node tests/smoke.mjs
```

### 自动化后端优先级

1. 依次尝试 `playwright` → `playwright-core` → `puppeteer` → `puppeteer-core`（用
   `executablePath` 指向本机 Edge/Chrome，不下载额外浏览器）。
2. 都没有时，用 **Node 全局 `WebSocket` + `fetch` 直连 CDP**：
   启动 `--remote-debugging-port=0` 的 Edge，读 `DevToolsActivePort` 拿端口，
   通过 `Target.createTarget` 新建 page，`Page.navigate` / `Runtime.evaluate` /
   `Page.captureScreenshot` 完成全部操作，事件由 `Runtime.*` / `Log.*` / `Network.*` 收集。
3. 若连浏览器都找不到（或 Node 无内置 `WebSocket`），明确输出 **SKIP** 与安装命令，
   并设置 `process.exitCode = 1`。**绝不会静默假装通过**：

   ```
   npm i -D playwright && npx playwright install chromium
   npm i -D puppeteer-core   # 需配合 CS_BROWSER 使用
   ```

浏览器统一附加：
`--headless=new --disable-gpu --use-gl=swiftshader --enable-unsafe-swiftshader
--no-sandbox --no-first-run --no-default-browser-check --disable-dev-shm-usage
--autoplay-policy=no-user-gesture-required --window-size=1280,720`
（CDP 模式另加 `--remote-debugging-port=0` 与独立的临时 `--user-data-dir`；
截图时通过 `Emulation.setDeviceMetricsOverride` 固定 1280×720 @ DPR 1。）

脚本会自己启动 `serve.py`（`NOBROWSER=1`、`QUIET=1`），等端口可连接后才继续，
结束时先关浏览器（`Browser.close`）再 `child.kill()` 关服务；随机空闲端口由内核分配，
失败会换端口/换 python 候选重试。

---

## 2. 断言清单

所有断言都走同一个 `check(name, fn)`：`fn` 抛异常 → `FAIL`，返回字符串 → `PASS`，
返回 `{ status, detail }` → 自定义状态；全部执行完统一打印中文报告，
出现 **FAIL / SKIP** 时退出码为 1。

脚本先访问普通入口 `http://127.0.0.1:<port>/web/`：不带 `?auto=1` 时必须停在
主菜单（`S.menuMode='start'`、不写 `window.__CS_READY__`，但保留俯视图和全部设置控件）。
随后访问 `?auto=1` 页面：`main.js` 的 `boot()` 设 `S.started=true`、隐藏开始/加载遮罩、
把冻结阶段直接置为 `S.round.phase='live'`，写 `window.__CS_READY__ = true`；两条路径都无条件写
`window.__CS_BOOTED__ = true` 与 `window.__CS__ = { S, A }`。脚本等待
`__CS_BOOTED__ === true`，所有页面内断言通过 `page.evaluate` 读取 `S` / `A`。

| # | 断言 | 实现方式 |
|---|---|---|
| 0 | 非 auto 主菜单与设置 | 普通入口断言 `#start` 可见、`menuMode==='start'`、未自动进入战场、`__CS_READY__ !== true`；8 个设置/开始控件存在、阵营文字存在、俯视图指向 `assets/overviews/dust2.png` |
| 0a | 新增 P1/P2 契约 | `?auto=1` 下断言 `SFX_NAMES` 新音效、USP/M4A1 消音器、Glock 三连发、6 把枪开镜等级、≥22 组后坐力、`materialAt`、血迹/枪口光/击杀图标/俯视图贴图、回合为 live、设置与 HUD、9 个新增 hook、`clearEffects/getEffects` 共享 `S.effects`、武器准星类型齐全 |
| — | 等待 bot 生成 | `nextRound()` 在冻结时间内同步 spawn，轮询 `S.BOMB.spawnLeft === 0 && S.enemies.length > 0 && S.allies.length > 0` |
| 1 | 世界材质不透明 | 遍历 `S.assets.worldMeshes`（实测 34 个），逐个断言 `material.transparent === false`、`depthWrite === true`、`depthTest === true`、`side === 2`（`THREE.DoubleSide`），并断言数量 > 0 |
| 2 | bot 几何独立 | 遍历 `S.enemies` + `S.allies` 的 `visual.group`，`traverse` 收集所有 `geometry.uuid` / `material.uuid`，断言零重复、零 `parent` 为空 |
| 3 | 射线命中实体 | 主路径用 `S.engine.rayHit([bot.x, bot.y+36, bot.z-18], [0,0,1], 40)`，断言 `kind === 'entity'` 且 `hit.entity` 就是该 bot；再端到端补强：临时把玩家放到 bot 正前方 30 单位、`weapon='usp'`、清冷却后调 `S.engine.shoot()`，断言 `bot.health` 下降（实测 -134），`try/finally` 还原玩家与回合状态 |
| 4 | 购买菜单 / 烟雾弹 | 断言 `S.player.nades` 有 `smoke` 键；把玩家放到本方出生点、`money=16000`、`BOMB.roundLeft=A.ROUND_TIME` 后调 `S.hooks.buy('smoke')`，断言返回 `true` 且 `nades.smoke` +1。另用 `await import('/web/game.js')` 动态读取 `BUY_CATEGORIES`，确认 `gear` 分类已列出 `smoke` |
| 5 | 阵亡后下回合有默认手枪 | `money` 设大 → `S.hooks.onPlayerDeath()` → `S.hud.nextRound()` → 按 `S.playerTeam` 断言 `S.owned` 含 CT 的 `usp` 或 T 的 `glock18`，且 `S.weapon ∈ S.owned` |
| 6 | 半场换边后 C4 有携带者 | 把 `S.match.half=1`、`ctScore=roundsPerHalf-1` 后调 `S.hooks.roundEnd('ct','killed')`，在 `evaluate` 内 `await sleep(4600)` 等 4 秒过场；先检查换边后下一回合 `S.BOMB.carrier !== null \|\| S.player.hasC4 === true`，不满足时退回结构探针（`playerTeam` 翻转、`half=2`、重新 spawn、T 为进攻方）并标记 **LIMIT**（见限制） |
| 7a | 零控制台错误 | 监听 `pageerror` / `console(error)` / `Runtime.exceptionThrown` / `Log.entryAdded(level=error)`；swiftshader 的 `GPU stall due to ReadPixels` 是 warning 级驱动日志，不计入 |
| 7b | 零 404 | 监听 `requestfailed` / `response(>=400)` / `Network.loadingFailed` / `Network.responseReceived`；切换页面时取消在途子资源的 `net::ERR_ABORTED` 明确忽略 |

### 截图基线

5 个固定视角由 `A.playerSpawns` / `A.tSpawns` / `A.BOMB_SITES` 推导（中路取 A、B 包点中点，
yaw 用 `atan2(dx, dz)` 朝向目标）：

| 文件 | 视角 |
|---|---|
| `tests/baselines/ct_spawn.png` | CT 出生 |
| `tests/baselines/mid.png` | 中路 |
| `tests/baselines/t_spawn.png` | T 出生 |
| `tests/baselines/site_a.png` | A 点 |
| `tests/baselines/site_b.png` | B 点 |

每张用 `?auto=1&pos=x,y,z,yaw,pitch` 固定相机（实测 `pos=1160,96,2472,45,-10`
会让 `S.player.pos/yaw/pitch` 与相机精确对应）。截图前会**归一化画面**：
`S.paused = true`（`loop()` 的 else 分支仍渲染，但 HUD/计时/bot AI 不再推进）、
用 CSS 隐藏 `#hud` 及各浮动层（含实时计时/比分/提示文本）、等 `spawnLeft=0` 后移除所有
bot / 投掷物网格（bot 出生点有随机性），停一帧再 `Page.captureScreenshot`。

比对用**纯 Node PNG 解析**：校验签名 → 读 `IHDR` → 拼接 `IDAT` → `zlib.inflateSync` →
逐行还原 PNG filter 0~4（Paeth）得到像素，然后计算
「最大通道差 > 16 的像素占比 ≤ 2%」且「全图平均绝对差 ≤ 2.0」。
若 PNG 解码不可用，回退为「文件大小差 ≤ 5% + 字节差 ≤ 5%」的**弱比较**并在报告里注明
（该方式无法发现等长重排/色调漂移）。

- 基线不存在时**自动创建并提示**，本次跳过比对，标记 `LIMIT`，请人工复核后纳入版本库。
- `--update-baselines` 只写基线，不跑断言、不比对。
- 预期画面变更后重跑：`node tests/smoke.mjs --update-baselines`。

### 报告状态

| 状态 | 含义 | 影响退出码 |
|---|---|---|
| `PASS` | 断言通过 | 否 |
| `FAIL` | 断言失败 / 脚本异常 | 是（1） |
| `LIMIT` | 通过但走了降级路径或存在已知限制（结构探针、基线新建、PNG 弱比较） | 否 |
| `SKIP` | 根本没跑（无浏览器/无自动化能力） | 是（1） |

---

## 3. 如何新增断言

1. 在 `tests/smoke.mjs` 的「页面内断言函数」区块新增一个**自包含**函数，签名固定：

   ```js
   function myCheck(assert, S, A, sleep) {
     // assert(cond, msg) 由 evalInPage 注入；S / A 来自 window.__CS__
     // 需要等待就写成 async 并用 await sleep(ms)（evalInPage 带 awaitPromise: true）
     assert(S.assets && S.assets.worldMeshes.length > 0, '世界网格为空');
     return '返回一段中文说明，会显示在 PASS 详情里';
   }
   ```

   ⚠️ 页面内函数会被 `fn.toString()` 序列化后注入浏览器，**不能引用 Node 侧闭包变量**
   （常量请写进函数体，或通过 `evalInPage` 的第 3 个参数 `arg` 传 JSON 值）。

2. 在 `main()` 的断言区块加一行：

   ```js
   await check('8. 我的新断言', () => evalInPage(automation, myCheck));
   ```

   需要跨步骤/多页面时用 `async () => { ... }` 并返回字符串或 `{ status, detail }`。

3. 在本文档「断言清单」补一行，说明数据来源与已知限制。

4. Node 侧的检查（如文件、子进程、网络汇总）同样用 `check()`，但直接写普通 async 函数，
   不经过 `evalInPage`。

5. 调试技巧：把 `check()` 抛出的中文消息当作唯一定位线索；脚本顶层已捕获所有
   `unhandledRejection` 与 `main()` 异常并打印报告，不会留下一句难懂的堆栈。

新增 eslint 规则：编辑根目录 `eslint.config.js` 的 `rules` 对象即可（flat config，
`export default [...]`）。注意 `no-undef` 依赖手写的 `browserGlobals`，若新代码用了新的
浏览器全局，要一并加进去。

---

## 4. 当前已知限制

以下说明以当前工作区（headless Edge + swiftshader）实测为准，均为测试脚本自身的降级路径，
不是业务代码缺陷。

1. **断言 6 的降级探针**：动态路径直接检查换边后下一回合 `S.BOMB.carrier` 或
   `S.player.hasC4`。正常情况下玩家换到 T 后由 `hasC4=true` 直接通过；若时序过慢导致
   该检查未满足，脚本会退回结构探针（`playerTeam` 翻转、`half=2`、下回合已重新 spawn、
   进攻方为 T / 防守方为 CT）并标记 **LIMIT**，不算 PASS。

2. **`canBuy()` 有窗口与距离限制**：`buyItem()` 要求 `BOMB.state === 'live'`、开局购买
   窗口内、玩家位于本方出生点附近、资金充足。断言 4 显式把玩家放回出生点、把
   `roundLeft` 复位、把 `money` 设为 16000；否则会静默返回 `false`。

3. **截图基线依赖渲染环境**：已隐藏 DOM HUD、清空随机 bot、固定视口与 DPR，但
   `swiftshader` 版本 / 驱动 / 抗锯齿实现差异仍可能造成像素漂移。换机器、换 Edge 版本
   或升级 three.js 后请 `--update-baselines` 重建。弱回退（文件大小 + 字节差异）
   只能作为最后兜底，不视为严格像素比对。

4. **网络事件的刻意忽略**：切换 `?pos=` 页面时，上一页仍在传输的资源会被浏览器取消，
   产生 `net::ERR_ABORTED`。这是导航行为而非资源缺失，已在两个后端里明确过滤。
   真实的 404 / 5xx / `requestfailed` 仍会计入失败。

5. **时序**：bot 在冻结时间内同步生成，半场过场是 `later(nextRound, 4)` 的 4 秒真实
   时间。脚本轮询等待，但极慢的机器可能需要调大 `waitForBoot` / bot 等待 / `4600ms`
   这些常量。

6. **`eslint.config.js` 不含依赖**：没有引入 `globals` / `@eslint/js`，浏览器全局是手写对象。
   它只 lint `web/*.js`，并全局忽略 `web/vendor/**`（three.js 0.187.0 是本地 vendor）。
   规则集刻意保守：现有代码有大量 `console.warn` 与空 `try/catch`，故未启用
   `no-console` / `no-empty` / `eqeqeq` 等会产生大量误报的规则；
   `no-unused-vars` 只设 `warn` 且忽略 catch 绑定。

7. **之前的验证方式（来自 `.playwright-cli/`）**：6 组 `console-*.log` +
   `page-*.yml` 快照，访问 `http://127.0.0.1:8099/web/`，日志里唯一的
   `[INFO] [asset] 3 个出生点与玩家碰撞盒冲突, 已吸附到可站立格`
   来自 `web/asset.js`（不是错误）。`page-*.yml` 是 HUD 的 accessibility tree 快照
   （击杀/回合/敌人/队友、$ 800、HP 100、1:45、USP 12/100、防守 A 或 B 点等），
   属于人工/CLI 的结构性检查，**没有保存 CDP 端口、命令行参数或截图**，
   所以本脚本自行实现了一套可复现的无头链路。
