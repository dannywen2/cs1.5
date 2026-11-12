# hlsrc — 资产生成脚本

把原版 CS 1.5 安装目录里的 BSP / MDL / WAD / TGA / WAV 解析并烘焙成
`assets/` 下的二进制资产，供浏览器端 `web/asset.js` 直接 `fetch` + `DataView`
解析（不需要在运行时重新烘焙）。

## 依赖

```powershell
pip install pillow            # bake.py / bake_player.py
pip install panda3d           # bake_sky.py / bake_vm.py (PNMImage)
```

另外需要本机存在原版安装（路径见各脚本顶部的 `SRC` / `GAME` 常量）。

## 脚本

| 脚本 | 输入 | 输出 |
|---|---|---|
| `bake.py` | `cstrike/maps/de_dust2.bsp` + WAD | `assets/tex/*.png`、`dust2.geo`、`dust2.meta.json`、`dust2.col`、`dust2.hit` |
| `bake_nav.py` | 同上 | `dust2.nav`（16 单位多层导航格） |
| `bake_player.py` | `models/player/{leet,terror,sas,urban}.mdl` | `assets/player/*.geo/.json` + 贴图 |
| `bake_pw.py` | `models/player/w_*.mdl` | `assets/player/w_*.geo/.json`（手持武器） |
| `bake_vm.py` | `models/v_*.mdl` | `assets/vm/*.geo/.json`（第一人称枪模） |
| `bake_sky.py` | `gfx/env/des*.tga` | `assets/sky/des_*.png`（6 面） |
| `bake_sound.py` | `cstrike/sound/**` | 项目根目录 `sfx_*.wav` |
| `check_nav.py` | `dust2.nav` | 打印出生点/包点可站性与 A* 连通性 |

## 库

- `bsp.py`：GoldSrc BSP v30 解析（面/顶点/贴图/lightmap/clipnode/实体）
- `mdl.py`：GoldSrc MDL v10 解析（骨骼动画烘焙、strip/fan 三角形、调色板）
- `wad.py`：WAD3 贴图解码

## 重要约定

`dust2.col` 与 `dust2.hit` 是 **格式 v2**：结尾追加了 brush 实体
（`func_breakable` 等）各自的子树根节点 + 包围盒。这些 brush 有独立的
model，从 worldspawn（model 0）的根节点走不到 —— 只导出 model 0 会让所有
箱子既不挡人也不挡子弹。`bake_nav.py` 也会把这些 brush 计入 solid 判定，
否则导航网格会把箱子内部当成可站立地面。

改动这两个文件的格式时，必须同步改 `web/asset.js` 的 `parseCol` / `parseHit`。
