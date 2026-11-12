"""把 de_dust2.bsp 烘焙成 Ursina 可直接加载的资产.

产物 (assets/):
    tex/t000.png ...        贴图 (全部重采样为 2 次幂尺寸)
    dust2.geo               分组网格 (顶点/UV/顶点色/三角形)
    dust2.meta.json         贴图表 / 出生点 / 包点 / 包围盒
    dust2.col               精确碰撞 (hull1 clipnode 树)
"""
import json
import struct
import sys
from array import array
from pathlib import Path
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))

from bsp import Bsp
from wad import Wad, bsp_miptex_png, wad_miptex_png, load_palette

GAME = Path(r"C:\GTGame\cs反恐精英1.5")
CS = GAME / "cstrike"
OUT = Path(__file__).resolve().parent.parent / "assets"

# 不参与渲染的工具贴图 (sky 单独烘成天空盒; trigger/clip 无可见面)
SKIP_TEX = {"clip", "aaatrigger", "trigger", "nodraw"}


def _tri_normal(a, b, c):
    u = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
    v = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
    return (u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0])


def palette_from_wad():
    """GoldSrc 标准调色板; BSP 内嵌贴图仍优先使用各自的局部表。"""
    return load_palette(CS)


def load_all_wads():
    wads = {}
    for folder in (CS, GAME / "valve"):
        for p in sorted(folder.glob("*.wad")):
            if p.name.lower() in wads:
                continue
            try:
                wads[p.name.lower()] = Wad(p)
            except Exception:
                pass
    return wads


def main():
    bsp_path = CS / "maps" / "de_dust2.bsp"
    b = Bsp(bsp_path)
    pal = palette_from_wad()
    wads = load_all_wads()
    OUT.mkdir(parents=True, exist_ok=True)
    texdir = OUT / "tex"
    texdir.mkdir(exist_ok=True)

    polys = b.face_polys()
    print("polys", len(polys))

    # ---- 收集贴图名 ----
    names = []
    for p in polys:
        if p["tex"] not in names:
            names.append(p["tex"])
    print("textures used", len(names))
    # BSP 索引保持与贴图目录一致; 用 t%03d 对应原贴图索引, 便于溯源
    texmap = {}
    for i, t in enumerate(b.textures()):
        n = t[0] if t else None
        if n is None or n not in names:
            continue
        low = n.lower()
        skip = low in SKIP_TEX or "trigger" in low
        im = None
        if not skip:
            im = bsp_miptex_png(b, n, pal)
            if im is None:
                # 内嵌只有名字 -> 按 GoldSrc cstrike -> valve 的 WAD 回退链查找
                for fn in ("cs_dust.wad", "cstrike.wad", "halflife.wad",
                           "decals.wad", "cached.wad"):
                    w = wads.get(fn)
                    if not w:
                        continue
                    im = wad_miptex_png(w, n)
                    if im is not None:
                        break
                if im is None:
                    for w in wads.values():
                        im = wad_miptex_png(w, n)
                        if im is not None:
                            break
        if im is None:
            texmap[n] = None
            print("  [miss] %s" % n)
            continue
        # 天空单独处理
        if low.startswith("sky"):
            texmap[n] = None
            continue
        fn = "t%03d.png" % i
        # GoldSrc/OpenGL 的 mipmap 要求 2 次幂尺寸; 128x240 / 96x32 这类
        # 原版贴图若直接生成 mip 链, 会出现 64x120、8x15 等奇数级 mip,
        # 远处/斜视墙面被采成色块, 看起来像贴了半透明贴图。整张图重采样
        # 到 2 次幂后归一化 UV 不变, mip 链每级都合法。
        w, h = im.size
        nw, nh = 1 << (w - 1).bit_length(), 1 << (h - 1).bit_length()
        if (nw, nh) != (w, h):
            im = im.resize((nw, nh), Image.LANCZOS)
        im.save(texdir / fn)
        texmap[n] = fn
        print("  %-18s %dx%d -> %s %dx%d" % (n, w, h, fn, nw, nh))

    # ---- 分组导出几何 ----
    groups = {}
    for p in polys:
        f = texmap.get(p["tex"])
        if f is None:
            continue
        groups.setdefault(f, []).append(p)

    geo = [b"GEO1"]
    meta_groups = []
    for f, ps in sorted(groups.items()):
        verts = array("f")
        uvs = array("f")
        cols = array("f")
        tris = array("I")
        for p in ps:
            base = len(verts) // 3
            vs, us, lc = p["verts"], p["uvs"], p["light"]
            n = len(vs)
            for k in range(n):
                verts.extend(vs[k])
                uvs.extend(us[k])
                c = lc[k] if k < len(lc) else lc[0]
                cols.extend((c[0] / 255.0, c[1] / 255.0, c[2] / 255.0))
            # BSP 面顶点按 GoldSrc 内法线排列; (x,z,y) 是镜像映射,
            # 在 GoldSrc 里让三角形叉积指向面外法线, Ursina/Panda3D 才会
            # 把它当正面。逐三角形定向也修掉少数扇形剖分中绕序反常的面。
            normal = p["normal"]
            for k in range(1, n - 1):
                i, j = base + k, base + k + 1
                u = _tri_normal(vs[0], vs[k], vs[k + 1])
                if sum(u[t] * u[t] for t in range(3)) < 1e-8:
                    continue                 # 共线顶点: 不栅格化, 也不会形成缝
                dot = sum(u[t] * normal[t] for t in range(3))
                if dot > 0:
                    tris.extend((base, i, j))
                else:
                    tris.extend((base, j, i))
        meta_groups.append(dict(tex=f, nverts=len(verts) // 3, ntris=len(tris) // 3))
        geo.append(struct.pack("<i", len(verts) // 3))
        geo.append(struct.pack("<i", len(tris) // 3))
        geo.append(verts.tobytes())
        geo.append(uvs.tobytes())
        geo.append(cols.tobytes())
        geo.append(tris.tobytes())
    (OUT / "dust2.geo").write_bytes(b"".join(geo))
    print("geo bytes", (OUT / "dust2.geo").stat().st_size,
          "verts", sum(g["nverts"] for g in meta_groups),
          "tris", sum(g["ntris"] for g in meta_groups))

    # ---- 碰撞 hull1 ----
    # 注意: 世界树只包含 model 0 (worldspawn)。原版把 func_breakable 箱子/木箱
    # 放在独立的 brush model 里 (models[1..] 各自有自己的 headnode), 因此只导出
    # model 0 会让所有箱子变成"能穿过去"。这里把每个实心 brush 实体的 hull1
    # 根节点 + 包围盒一起追加到文件尾部 (格式 v2), 由浏览器逐棵点测试。
    models = b.models()
    headnode = models[0]["headnode"][1]      # hull 1 = 玩家碰撞
    planes = b.planes()
    clips = b.clipnodes()
    col = [struct.pack("<ii", headnode, len(clips))]
    for i, (pn, c0, c1) in enumerate(clips):
        nx, ny, nz = planes[pn][0]
        col.append(struct.pack("<ffffhh", nx, ny, nz, planes[pn][1], c0, c1))

    ents = b.entities()
    # func_illusionary 在原版就是"看得见但不挡人"(栏杆/装饰), 不能加碰撞;
    # func_bomb_target / func_buyzone 是触发区域, 也不是实体面。
    SOLID_BRUSH = {"func_breakable", "func_wall", "func_door", "func_door_rotating",
                   "func_button", "func_pushable"}
    brushes = []
    for e in ents:
        cn = e.get("classname")
        if cn not in SOLID_BRUSH:
            continue
        mdl = e.get("model", "")
        if not mdl.startswith("*"):
            continue
        mi = int(mdl[1:])
        if mi <= 0 or mi >= len(models):
            continue
        m = models[mi]
        h1 = m["headnode"][1]
        if h1 < 0:
            continue                         # 该 brush 的 hull1 是叶子(空/全实), 无树可测
        mn, mx = list(m["mins"]), list(m["maxs"])
        # hull1 已按 32x32x72 玩家盒膨胀, 但点测试仍只在 brush 附近的点命中,
        # 用 hull0 包围盒向外扩 40 做快速剔除界。
        brushes.append((h1, mn, mx, mi, cn))
    col.append(struct.pack("<i", len(brushes)))
    for h1, mn, mx, mi, cn in brushes:
        col.append(struct.pack("<i6f", h1, mn[0], mn[1], mn[2], mx[0], mx[1], mx[2]))
    (OUT / "dust2.col").write_bytes(b"".join(col))
    print("clipnodes", len(clips), "headnode", headnode,
          "solid brushes", len(brushes), "->", [b[3] for b in brushes])

    # ---- 点碰撞 hull0: 渲染 BSP 节点树 (无玩家盒膨胀), 供子弹/视线精确命中 ----
    # 同上: 箱子等 brush 实体的 hull0 子树虽然物理上已经在 nodes lump 里,
    # 但从 model 0 的根节点走不到, 所以子弹/视线也会穿箱。追加各自的根节点。
    rn = b.nodes()
    rl = b.leaves()
    hit = [struct.pack("<iiii", models[0]["headnode"][0],
                       len(planes), len(rn), len(rl))]
    for n, dist, _t in planes:
        hit.append(struct.pack("<ffff", n[0], n[1], n[2], dist))
    for nd in rn:
        hit.append(struct.pack("<ihh", nd["plane"], *nd["children"]))
    hit.append(struct.pack("<%di" % len(rl), *(l["contents"] for l in rl)))
    hit_brushes = []
    for h1, mn, mx, mi, cn in brushes:
        h0 = models[mi]["headnode"][0]
        if h0 < 0:
            continue
        hit_brushes.append((h0, mn, mx, mi, cn))
    hit.append(struct.pack("<i", len(hit_brushes)))
    for h0, mn, mx, mi, cn in hit_brushes:
        hit.append(struct.pack("<i6f", h0, mn[0], mn[1], mn[2], mx[0], mx[1], mx[2]))
    (OUT / "dust2.hit").write_bytes(b"".join(hit))
    print("hit nodes", len(rn), "leaves", len(rl),
          "brushes", len(hit_brushes), "bytes",
          (OUT / "dust2.hit").stat().st_size)

    # ---- 实体 ----
    ents = b.entities()
    ct, t = [], []
    for e in ents:
        cn = e.get("classname")
        org = e.get("origin")
        if not org:
            continue
        x, y, z = [float(v) for v in org.split()]
        if cn == "info_player_start":
            ang = e.get("angles") or e.get("angle") or "0 0 0"
            ct.append([x, y, z, float(ang.split()[1])])
        elif cn == "info_player_deathmatch":
            ang = e.get("angles") or e.get("angle") or "0 0 0"
            t.append([x, y, z, float(ang.split()[1])])

    # 包点来自 brush model 的包围盒
    sites = {}
    for e in ents:
        if e.get("classname") != "func_bomb_target":
            continue
        mdl = e.get("model", "")
        if not mdl.startswith("*"):
            continue
        mi = int(mdl[1:])
        if mi >= len(models):
            continue
        mn, mx = models[mi]["mins"], models[mi]["maxs"]
        c = [(mn[i] + mx[i]) / 2 for i in range(3)]
        sites[e.get("target", "site%d" % mi)] = dict(
            center=c, mins=list(mn), maxs=list(mx))
    print("ct spawns", len(ct), "t spawns", len(t), "sites", list(sites))

    meta = dict(
        map="de_dust2",
        groups=meta_groups,
        ct_spawns=ct,
        t_spawns=t,
        sites=sites,
        bounds=dict(mins=list(models[0]["mins"]), maxs=list(models[0]["maxs"])),
        palette=pal.hex(),
    )
    meta_path = OUT / "dust2.meta.json"
    if meta_path.exists():
        _old = json.loads(meta_path.read_text(encoding="utf-8"))
        if "nav" in _old:
            meta["nav"] = _old["nav"]   # bake_nav 写的导航元数据不能被贴图重烘焙冲掉
    meta_path.write_text(json.dumps(meta), encoding="utf-8")
    print("done")


if __name__ == "__main__":
    main()
