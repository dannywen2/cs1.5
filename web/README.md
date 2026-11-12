# CS 1.5 复刻版 · three.js / WebGL

把原来基于 Python + Ursina(Panda3D) 的复刻版整体移植到浏览器。原版烘焙资产
（`assets/` 下的 `dust2.geo/.nav/.col/.hit`、贴图、MDL 模型、`sfx_*.wav`、
`radar_v2.png`）**全部直接复用**，浏览器里用 `fetch` + `DataView` 解析，不重新烘焙。

## 运行

无需 npm install、无需打包、无需联网：

```powershell
python serve.py            # 打开 http://127.0.0.1:8080/web/
python serve.py 9000       # 指定端口
```

`serve.py` 以项目根目录为文档根，因此 `web/*.js` 里的 `../assets/`、
`../sfx_*.wav`、`../radar_v2.png` 都能解析。也可以把整个目录丢给任意静态
文件服务器（需正确返回 `.js` 的 `text/javascript` MIME）。

浏览器要求：支持 WebGL2 + ES modules + Pointer Lock 的现代浏览器
（Edge / Chrome / Firefox 均可）。首次点击"点击进入战场"是为了满足
Pointer Lock 和 Web Audio 的用户手势要求。

## 为什么移植能解决遗留 bug

| 旧问题 | Python/Ursina 根因 | three.js 里的处理 |
|---|---|---|
| 墙壁透明 / 漏面 | `Entity.model` setter 强制给每个 Mesh 加 `TransparencyAttrib.M_dual`，配合 NodePath 状态与背面剔除，部分 brush 面被错误混合/剔除 | 世界几何统一 `MeshBasicMaterial({transparent:false, depthWrite:true, depthTest:true, side:DoubleSide})`，绕序显式反转，无隐式透明状态 |
| Bot 只剩血条 | `PLAYER_MODEL_CACHE` 返回同一个 `Mesh` NodePath，`model_setter` 里 `reparentTo(self)` 会让后生成的 bot 把前面的模型节点抢走 | `asset.js` 只缓存 typed array 模板，每个 bot 调 `loadModel()` 生成独立的 `BufferGeometry`；受击闪白只改该 bot 自己的 material |

## 目录

```
serve.py              静态服务器
web/
  index.html          HUD / 菜单 / 加载页 DOM
  style.css           HUD 样式
  main.js             启动、主循环、输入、Web Audio、HUD 更新、雷达
  state.js            全局状态与跨模块钩子
  asset.js            二进制资产解析、BSP 碰撞、nav 网格、A*、模型加载
  engine.js           渲染（世界/天空/视口枪模）、玩家物理、射击射线
  game.js             Bot AI、C4/回合状态机、经济、投掷物
  vendor/             three.js 0.187.0（本地 vendor，无 CDN 依赖）
assets/               原版烘焙资产（未改动）
sfx_*.wav             原版音效
radar_v2.png          雷达底图
main.py               旧 Python 版（保留，可对照数值/逻辑）
```

## 操作

| 键 | 功能 |
|---|---|
| WASD / 鼠标 | 移动 / 视角 |
| Shift / Ctrl | 慢走 / 蹲下 |
| Space | 跳跃 |
| 鼠标左键 / 右键 | 开火 / AWP 开镜（按住） |
| 1 / 2 / 3 | 主武器 / 手枪 / 匕首 |
| R / B | 换弹 / 购买菜单 |
| G / F | HE 手雷 / 闪光弹 |
| E（按住） | 拆弹 |
| Tab（按住） | 计分板 |
| Q | 切回上一把武器 |
| ESC | 释放鼠标 |

## 实现要点

- **坐标**：与旧版一致，x 右 / y 上 / z 前，yaw=0 朝 +z。BSP 的 GoldSrc
  `(x,y,z)` 在 `buildWorldMeshes` 里映射到 `(x,z,y)`（镜像，行列式 −1），
  因此**每个三角形反转绕序**；UV 做 `(u,-v)`，顶点色 `min(1,c*2.35+0.13)`。
- **碰撞**：`dust2.col` 是 hull1 clipnode 树（按 32×32×72 玩家盒膨胀），
  用于玩家移动；`dust2.hit` 是 hull0 渲染 BSP，用于子弹 / 视线；
  `dust2.nav` 是 16 单位多层导航格，用于 Bot 的加权 A*。
- **渲染顺序**：天空盒（独立 scene，关深度）→ 清深度 → 世界 → 清深度 →
  第一人称枪模（独立 scene，关深度），保证持枪模型不被墙裁掉。
- **材质**：所有模型/贴图显式 `transparent:false`，杜绝混合排序造成的透视。
- **音频**：每个 `sfx_*.wav` 解码成 AudioBuffer，每次播放新建
  `BufferSourceNode`，急促的 C4 蜂鸣与多个 bot 枪声不会互相截断。
