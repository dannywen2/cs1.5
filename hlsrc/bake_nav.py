"""从 BSP 生成 dust2 导航网格 (每格可站立高度层).

原理:
  1. 把渲染三角形按 XZ 投影, 得到每格的候选表面高度
  2. 用 hull1 clipnode (已按 32x32x72 玩家盒膨胀) 判定该高度处玩家是否穿模
  3. 通过的候选高度即为可站立层
"""
import json
import math
import struct
import sys
from array import array
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from bsp import Bsp, CONTENTS_SOLID

CS = Path(r"C:\GTGame\cs反恐精英1.5\cstrike")
OUT = Path(__file__).resolve().parent.parent / "assets"
CELL = 16.0


def main():
    b = Bsp(CS / "maps" / "de_dust2.bsp")
    models = b.models()
    mn, mx = models[0]["mins"], models[0]["maxs"]
    wx0, wy0 = mn[0], mn[1]
    nx = int(math.ceil((mx[0] - wx0) / CELL))
    ny = int(math.ceil((mx[1] - wy0) / CELL))
    print("grid %dx%d = %d cells" % (nx, ny, nx * ny))

    planes = b.planes()
    clips = b.clipnodes()
    head = models[0]["headnode"][1]

    # brush 实体 (func_breakable 箱子等) 自己也有 hull1 树, 从 model 0 走不到。
    # 不把它们算进来, nav 会把箱子内部当成可站立地面 —— 表现为 bot 想走进箱子、
    # 玩家站在箱子上却又"陷下去"。把它们的根节点一并纳入 solid 测试。
    SOLID_BRUSH = {"func_breakable", "func_wall", "func_door", "func_door_rotating",
                   "func_button", "func_pushable"}
    brush_boxes = []      # (root, x0, y0, z0, x1, y1, z1) 已按玩家盒外扩
    for e in b.entities():
        if e.get("classname") not in SOLID_BRUSH:
            continue
        mdl = e.get("model", "")
        if not mdl.startswith("*"):
            continue
        mi = int(mdl[1:])
        if mi <= 0 or mi >= len(models):
            continue
        h1 = models[mi]["headnode"][1]
        if h1 < 0:
            continue
        mn, mx = models[mi]["mins"], models[mi]["maxs"]
        # hull1 已按 32x32x72 膨胀, 所以点测试只会在 brush 附近命中;
        # 外扩 40 保证筛选不会误杀 (比精确值宽松一点没有代价)。
        brush_boxes.append((h1, mn[0] - 40, mn[1] - 40, mn[2] - 40,
                            mx[0] + 40, mx[1] + 40, mx[2] + 40))
    print("solid brush hull1 roots", len(brush_boxes))

    def _walk(root, x, y, z):
        num = root
        guard = 0
        while num >= 0:
            if num >= len(clips) or guard > 512:
                return False
            guard += 1
            pn, c0, c1 = clips[num]
            n, dist, _t = planes[pn]
            num = c0 if (n[0] * x + n[1] * y + n[2] * z - dist) >= 0 else c1
        return num == CONTENTS_SOLID

    def solid(x, y, z):
        if _walk(head, x, y, z):
            return True
        for root, x0, y0, z0, x1, y1, z1 in brush_boxes:
            if x < x0 or x > x1 or y < y0 or y > y1 or z < z0 or z > z1:
                continue
            if _walk(root, x, y, z):
                return True
        return False

    # ---- 1. 三角形投影得到候选高度 ----
    polys = b.face_polys()
    cand = {}
    for p in polys:
        vs = p["verts"]
        n = p["normal"]
        if abs(n[2]) < 0.05:      # 垂直墙面不当地面
            continue
        xs = [v[0] for v in vs]
        ys = [v[1] for v in vs]
        cx0 = max(0, int((min(xs) - wx0) / CELL))
        cx1 = min(nx - 1, int((max(xs) - wx0) / CELL))
        cy0 = max(0, int((min(ys) - wy0) / CELL))
        cy1 = min(ny - 1, int((max(ys) - wy0) / CELL))
        for k in range(1, len(vs) - 1):
            a, bb, c = vs[0], vs[k], vs[k + 1]
            # 三角形平面: z = -(n.x*x + n.y*y - n.z*?) 用点法式
            for cy in range(cy0, cy1 + 1):
                py = wy0 + (cy + 0.5) * CELL
                for cx in range(cx0, cx1 + 1):
                    px = wx0 + (cx + 0.5) * CELL
                    if _in_tri(px, py, a, bb, c):
                        if abs(n[2]) > 1e-4:
                            z = (n[0] * (a[0] - px) + n[1] * (a[1] - py)) / n[2] + a[2]
                        else:
                            z = a[2]
                        cand.setdefault((cx, cy), []).append(z)
    print("cells with candidates", len(cand))

    # ---- 直接垂直扫描: hull1 已经按 32x32x72 玩家盒膨胀, 空腔底部即"可站中心高度" ----
    offsets = array("I", [0])
    heights = array("h")
    open_cells = 0
    total_layers = 0
    for cy in range(ny):
        py = wy0 + (cy + 0.5) * CELL
        for cx in range(nx):
            px = wx0 + (cx + 0.5) * CELL
            z = 640
            prev = solid(px, py, z)
            layers = []
            while z > -340:
                nz = z - 8
                s = solid(px, py, nz)
                if prev and not s:
                    # 进入空腔: 向下找到腔底, 再细化到 1 单位
                    zz = nz
                    while zz > -340 and not solid(px, py, zz - 8):
                        zz -= 8
                    while zz > -340 and not solid(px, py, zz - 1):
                        zz -= 1
                    ground = int(zz - 36)
                    if not layers or abs(ground - layers[-1]) > 12:
                        layers.append(ground)
                    prev = False
                else:
                    prev = s
                z = nz
            if layers:
                open_cells += 1
                total_layers += len(layers)
                heights.extend(layers)
            offsets.append(len(heights))
    print("open cells", open_cells, "layers", total_layers,
          "avg %.2f" % (total_layers / max(1, open_cells)))

    # ---- 只保留最大连通域: 箱子顶/屋顶等孤岛会让 bot 出生即卡死 ----
    from collections import deque
    seen = set()
    comps = []
    for cy in range(ny):
        for cx in range(nx):
            i = cy * nx + cx
            if (cx, cy) in seen or offsets[i + 1] == offsets[i]:
                continue
            q = deque([(cx, cy)])
            seen.add((cx, cy))
            comp = []
            while q:
                c = q.popleft()
                comp.append(c)
                ci = c[1] * nx + c[0]
                hc = heights[offsets[ci]]
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        nb = (c[0] + dx, c[1] + dy)
                        if nb in seen or not (0 <= nb[0] < nx and 0 <= nb[1] < ny):
                            continue
                        ni = nb[1] * nx + nb[0]
                        if offsets[ni + 1] == offsets[ni]:
                            continue
                        if abs(heights[offsets[ni]] - hc) > 40:
                            continue
                        seen.add(nb)
                        q.append(nb)
            comps.append(comp)
    comps.sort(key=len, reverse=True)
    keep = set(comps[0])
    print("components", [len(c) for c in comps[:5]], "keep", len(keep))
    f_off = array("I", [0])
    f_h = array("h")
    for cy in range(ny):
        for cx in range(nx):
            i = cy * nx + cx
            if (cx, cy) in keep:
                f_h.extend(heights[offsets[i]:offsets[i + 1]])
            f_off.append(len(f_h))
    offsets, heights = f_off, f_h
    print("after filter cells", sum(1 for i in range(nx * ny)
                                    if offsets[i + 1] > offsets[i]))

    nav = [struct.pack("<ii", nx, ny),
           struct.pack("<ff", wx0, wy0),
           struct.pack("<f", CELL),
           struct.pack("<I", len(offsets)),
           offsets.tobytes(),
           struct.pack("<I", len(heights)),
           heights.tobytes()]
    (OUT / "dust2.nav").write_bytes(b"".join(nav))
    print("nav bytes", (OUT / "dust2.nav").stat().st_size)

    meta = json.loads((OUT / "dust2.meta.json").read_text(encoding="utf-8"))
    meta["nav"] = dict(nx=nx, ny=ny, wx0=wx0, wy0=wy0, cell=CELL)
    (OUT / "dust2.meta.json").write_text(json.dumps(meta), encoding="utf-8")


def _in_tri(px, py, a, b, c):
    d1 = (px - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (py - b[1])
    d2 = (px - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (py - c[1])
    d3 = (px - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (py - a[1])
    neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    return not (neg and pos)


if __name__ == "__main__":
    main()
