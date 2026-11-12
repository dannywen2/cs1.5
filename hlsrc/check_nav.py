"""校验导航网格: 出生点/包点可站立性 + T->A/T->B A* 连通性"""
import heapq
import json
import math
import struct
import sys
from array import array
from collections import deque
from pathlib import Path

A = Path(__file__).resolve().parent.parent / "assets"


class Nav:
    def __init__(self, path):
        raw = path.read_bytes()
        pos = 0
        self.nx, self.ny = struct.unpack_from("<ii", raw, pos)
        pos += 8
        self.wx0, self.wy0 = struct.unpack_from("<ff", raw, pos)
        pos += 8
        self.cell, = struct.unpack_from("<f", raw, pos)
        pos += 4
        n, = struct.unpack_from("<I", raw, pos)
        pos += 4
        self.offsets = list(struct.unpack_from("<%dI" % n, raw, pos))
        pos += n * 4
        m, = struct.unpack_from("<I", raw, pos)
        pos += 4
        self.heights = list(struct.unpack_from("<%dh" % m, raw, pos))
        self.ncell = self.nx * self.ny

    def layers(self, cx, cy):
        if not (0 <= cx < self.nx and 0 <= cy < self.ny):
            return ()
        i = cy * self.nx + cx
        return self.heights[self.offsets[i]:self.offsets[i + 1]]

    def cell_of(self, wx, wy):
        return (int((wx - self.wx0) // self.cell), int((wy - self.wy0) // self.cell))

    def world_of(self, cx, cy, z):
        return (self.wx0 + (cx + 0.5) * self.cell,
                self.wy0 + (cy + 0.5) * self.cell, z)

    def walkable(self, cx, cy):
        return len(self.layers(cx, cy)) > 0


def astar(nav, start, goal, max_iter=400000, max_step=26):
    """多层 A*: 状态 = (cx, cy, layer). 同格不同层可切换, 相邻格高度差 <= max_step"""
    def h(a, b):
        return math.hypot(a[0] - b[0], a[1] - b[1])

    def zof(c):
        ls = nav.layers(c[0], c[1])
        return ls[c[2]] if c[2] < len(ls) else None

    # 起点/终点取最接近地面的层
    s = (start[0], start[1], 0)
    gz = nav.layers(*goal)
    if not nav.layers(*start) or not gz:
        return None
    # 目标: 任意层都可以
    goals = {(goal[0], goal[1], i) for i in range(len(gz))}

    openq = [(0.0, s)]
    gsc = {s: 0.0}
    came = {}
    seen = set()
    it = 0
    while openq:
        it += 1
        if it > max_iter:
            return None
        _f, cur = heapq.heappop(openq)
        if cur in seen:
            continue
        seen.add(cur)
        if cur in goals:
            path = [cur]
            while cur in came:
                cur = came[cur]
                path.append(cur)
            return path[::-1]
        hc = zof(cur)
        cx, cy, li = cur
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1),
                       (1, 1), (1, -1), (-1, 1), (-1, -1)):
            nb2 = (cx + dx, cy + dy)
            nls = nav.layers(*nb2)
            if not nls:
                continue
            step = 1.0 if dx == 0 or dy == 0 else 1.414
            for lj, hz in enumerate(nls):
                if abs(hz - hc) > max_step:
                    continue
                nb = (nb2[0], nb2[1], lj)
                ng = gsc[cur] + step
                if ng < gsc.get(nb, 1e18):
                    gsc[nb] = ng
                    came[nb] = cur
                    heapq.heappush(openq, (ng + h(nb2, goal), nb))
    return None


def main():
    nav = Nav(A / "dust2.nav")
    meta = json.loads((A / "dust2.meta.json").read_text(encoding="utf-8"))
    print("grid %dx%d  cell=%.0f  origin=(%.0f,%.0f)"
          % (nav.nx, nav.ny, nav.cell, nav.wx0, nav.wy0))

    def probe(label, wx, wy):
        c = nav.cell_of(wx, wy)
        ls = nav.layers(*c)
        print("  %-14s world(%7.1f,%7.1f) cell%s layers=%s" %
              (label, wx, wy, c, list(ls)))
        return c, ls

    print("── 出生点 ──")
    ctb = meta["ct_spawns"][0]
    tb = meta["t_spawns"][0]
    ct_c, ct_l = probe("CT spawn", ctb[0], ctb[1])
    t_c, t_l = probe("T spawn", tb[0], tb[1])
    ok_ct = sum(1 for s in meta["ct_spawns"] if nav.walkable(*nav.cell_of(s[0], s[1])))
    ok_t = sum(1 for s in meta["t_spawns"] if nav.walkable(*nav.cell_of(s[0], s[1])))
    print("  CT 可站 %d/%d   T 可站 %d/%d"
          % (ok_ct, len(meta["ct_spawns"]), ok_t, len(meta["t_spawns"])))

    print("── 包点 ──")
    sites = {}
    for k, v in meta["sites"].items():
        c = v["center"]
        cell, ls = probe(k, c[0], c[1])
        sites[k] = cell

    print("── 连通性 ──")
    for name, goal in sites.items():
        p = astar(nav, t_c, goal)
        if p:
            print("  T -> %s : %d 步 (%.0f 单位)"
                  % (name, len(p), len(p) * nav.cell))
        else:
            print("  T -> %s : 不可达!" % name)
    p = astar(nav, t_c, ct_c)
    print("  T -> CT spawn :", "%d 步" % len(p) if p else "不可达!")

    # 连通域大小
    seen = set()
    comps = []
    for cy in range(nav.ny):
        for cx in range(nav.nx):
            if (cx, cy) in seen or not nav.walkable(cx, cy):
                continue
            q = deque([(cx, cy)])
            seen.add((cx, cy))
            size = 0
            base = nav.layers(cx, cy)[0]
            while q:
                c = q.popleft()
                size += 1
                hc = nav.layers(*c)[0]
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        nb = (c[0] + dx, c[1] + dy)
                        if nb in seen or not nav.walkable(*nb):
                            continue
                        if abs(nav.layers(*nb)[0] - hc) > 20:
                            continue
                        seen.add(nb)
                        q.append(nb)
            comps.append(size)
    comps.sort(reverse=True)
    print("  连通域 top5:", comps[:5], " 共", len(comps), "个")


if __name__ == "__main__":
    main()
