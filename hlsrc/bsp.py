"""GoldSrc BSP (version 30) 解析器 —— 只依赖标准库.

用来把 CS 1.5 的 de_dust2.bsp 拆成: 面/顶点/贴图名/lightmap/精确碰撞树/实体.
"""
import struct
from pathlib import Path

LUMP_ENTITIES = 0
LUMP_PLANES = 1
LUMP_TEXTURES = 2
LUMP_VERTICES = 3
LUMP_VISIBILITY = 4
LUMP_NODES = 5
LUMP_TEXINFO = 6
LUMP_FACES = 7
LUMP_LIGHTING = 8
LUMP_CLIPNODES = 9
LUMP_LEAVES = 10
LUMP_MARKSURFACES = 11
LUMP_EDGES = 12
LUMP_SURFEDGES = 13
LUMP_MODELS = 14

CONTENTS_EMPTY = -1
CONTENTS_SOLID = -2


class Bsp:
    def __init__(self, path):
        self.path = Path(path)
        self.raw = self.path.read_bytes()
        self._read_header()

    # ---------- 基础 ----------
    def _read_header(self):
        raw = self.raw
        self.version, = struct.unpack_from("<i", raw, 0)
        self.lumps = []
        for i in range(15):
            ofs, ln = struct.unpack_from("<ii", raw, 4 + i * 8)
            self.lumps.append((ofs, ln))

    def lump(self, idx):
        ofs, ln = self.lumps[idx]
        return self.raw[ofs:ofs + ln]

    # ---------- 顶点 ----------
    def vertices(self):
        d = self.lump(LUMP_VERTICES)
        n = len(d) // 12
        return [struct.unpack_from("<fff", d, i * 12) for i in range(n)]

    def planes(self):
        d = self.lump(LUMP_PLANES)
        n = len(d) // 20
        out = []
        for i in range(n):
            nx, ny, nz, dist, ptype = struct.unpack_from("<ffffi", d, i * 20)
            out.append(((nx, ny, nz), dist, ptype))
        return out

    def edges(self):
        d = self.lump(LUMP_EDGES)
        n = len(d) // 4
        return [struct.unpack_from("<HH", d, i * 4) for i in range(n)]

    def surfedges(self):
        d = self.lump(LUMP_SURFEDGES)
        n = len(d) // 4
        return list(struct.unpack_from("<%di" % n, d, 0))

    # ---------- 贴图 ----------
    def textures(self):
        """返回 [ (name, w, h, mip0_abs, mip1_abs, local_palette_abs, name_only) ]"""
        data = self.lump(LUMP_TEXTURES)
        if len(data) < 4:
            return []
        count, = struct.unpack_from("<i", data, 0)
        offs = list(struct.unpack_from("<%di" % count, data, 4))
        out = []
        for o in offs:
            # miptex_t 固定 40 字节; 最后一个贴图恰好紧贴 lump 末尾时
            # (o + 40 == len(data)) 仍是合法的, 旧判断 o >= len(data)-40
            # 会把它误判成越界返回 None, 导致该贴图的所有面被整组丢弃
            # (de_dust2 索引 43 SandWllWndw 即如此, A 点 67 个面缺失)。
            if o < 0 or o + 40 > len(data):
                out.append(None)
                continue
            name = data[o:o + 16].split(b"\0")[0].decode("latin-1")
            w, h = struct.unpack_from("<ii", data, o + 16)
            mipofs = list(struct.unpack_from("<4i", data, o + 24))
            if mipofs[0] == 0:
                out.append((name, w, h, o, o, None, True))
                continue
            pal = (o + mipofs[3] + (w * h // 64) + 2
                   if w > 0 and h > 0 else None)
            out.append((name, w, h, o + mipofs[0], o + mipofs[1], pal, False))
        return out

    def texinfo(self):
        d = self.lump(LUMP_TEXINFO)
        n = len(d) // 40
        out = []
        for i in range(n):
            v = struct.unpack_from("<8f", d, i * 40)
            miptex, flags = struct.unpack_from("<ii", d, i * 40 + 32)
            out.append((v, miptex, flags))
        return out

    # ---------- 面 ----------
    def faces(self):
        d = self.lump(LUMP_FACES)
        n = len(d) // 20
        out = []
        for i in range(n):
            planenum, side, firstedge, numedges, texinfo, s0, s1, s2, s3, lightofs = \
                struct.unpack_from("<hhihhBBBBi", d, i * 20)
            out.append(dict(plane=planenum, side=side, firstedge=firstedge,
                            numedges=numedges, texinfo=texinfo,
                            styles=(s0, s1, s2, s3), lightofs=lightofs))
        return out

    # ---------- 树 ----------
    def nodes(self):
        d = self.lump(LUMP_NODES)
        n = len(d) // 24
        out = []
        for i in range(n):
            planenum, c0, c1, mn0, mn1, mn2, mx0, mx1, mx2, ff, nf = \
                struct.unpack_from("<ihh6hHH", d, i * 24)
            out.append(dict(plane=planenum, children=(c0, c1),
                            mins=(mn0, mn1, mn2), maxs=(mx0, mx1, mx2),
                            firstface=ff, numfaces=nf))
        return out

    def clipnodes(self):
        d = self.lump(LUMP_CLIPNODES)
        n = len(d) // 8
        return [struct.unpack_from("<ihh", d, i * 8) for i in range(n)]

    def leaves(self):
        d = self.lump(LUMP_LEAVES)
        n = len(d) // 28
        out = []
        for i in range(n):
            contents, visofs, mn0, mn1, mn2, mx0, mx1, mx2, fms, nms = \
                struct.unpack_from("<ii6hHH", d, i * 28)
            amb = d[i * 28 + 24:i * 28 + 28]
            out.append(dict(contents=contents, visofs=visofs,
                            mins=(mn0, mn1, mn2), maxs=(mx0, mx1, mx2),
                            firstmarksurface=fms, nummarksurfaces=nms,
                            ambient=tuple(amb)))
        return out

    def models(self):
        d = self.lump(LUMP_MODELS)
        n = len(d) // 64
        out = []
        for i in range(n):
            vals = struct.unpack_from("<9f4i3i", d, i * 64)
            out.append(dict(mins=vals[0:3], maxs=vals[3:6], origin=vals[6:9],
                            headnode=vals[9:13], visleafs=vals[13],
                            firstface=vals[14], numfaces=vals[15]))
        return out

    # ---------- 面 -> 多边形 ----------
    def face_polys(self):
        """返回 [{verts:[(x,y,z)], uv:[(u,v)], plane, texname_idx, light:[(r,g,b)] , flags}]"""
        verts = self.vertices()
        edges = self.edges()
        se = self.surfedges()
        texs = self.textures()
        tinfo = self.texinfo()
        planes = self.planes()
        light = self.lump(LUMP_LIGHTING)
        out = []
        for f in self.faces():
            ti = f["texinfo"]
            if ti >= len(tinfo):
                continue
            vecs, miptex, flags = tinfo[ti]
            if miptex >= len(texs) or texs[miptex] is None:
                continue
            tname = texs[miptex][0]
            tw, th = texs[miptex][1], texs[miptex][2]
            if tw <= 0 or th <= 0:
                tw = th = 64
            pts = []
            uvs = []
            for k in range(f["numedges"]):
                se_idx = se[f["firstedge"] + k]
                if se_idx >= 0:
                    v = edges[se_idx][0]
                else:
                    v = edges[-se_idx][1]
                if v >= len(verts):
                    continue
                p = verts[v]
                pts.append(p)
                u = (p[0] * vecs[0] + p[1] * vecs[1] + p[2] * vecs[2] + vecs[3]) / tw
                vv = (p[0] * vecs[4] + p[1] * vecs[5] + p[2] * vecs[6] + vecs[7]) / th
                uvs.append((u, vv))
            if len(pts) < 3:
                continue
            # lightmap 尺寸
            lw = lh = 0
            lcol = ((200, 200, 200),) * len(pts)
            if f["lightofs"] >= 0:
                mn_u, mx_u = min(u for u, _ in uvs), max(u for u, _ in uvs)
                mn_v, mx_v = min(v for _, v in uvs), max(v for _, v in uvs)
                lw = int((mx_u - mn_u) * tw / 16.0) + 1
                lh = int((mx_v - mn_v) * th / 16.0) + 1
                lw = max(1, min(lw, 255))
                lh = max(1, min(lh, 255))
                need = lw * lh * 3
                off = f["lightofs"]
                if off + need <= len(light):
                    chunk = light[off:off + need]
                    r = sum(chunk[0::3]) // (lw * lh)
                    g = sum(chunk[1::3]) // (lw * lh)
                    b = sum(chunk[2::3]) // (lw * lh)
                    # lightmap 偏暗且是 2x 过曝空间, 做温和提亮
                    lcol = ((min(255, int(r * 1.7)), min(255, int(g * 1.7)),
                             min(255, int(b * 1.7))),) * len(pts)
            pn = planes[f["plane"]][0]
            if f["side"]:
                pn = (-pn[0], -pn[1], -pn[2])
            out.append(dict(verts=pts, uvs=uvs, normal=pn, tex=tname,
                            light=lcol, flags=flags, lightofs=f["lightofs"]))
        return out

    # ---------- 实体 ----------
    def entities(self):
        txt = self.lump(LUMP_ENTITIES).split(b"\0")[0].decode("latin-1", "replace")
        ents = []
        cur = None
        for line in txt.splitlines():
            line = line.strip()
            if line.startswith("{"):
                cur = {}
            elif line.startswith("}"):
                if cur is not None:
                    ents.append(cur)
                cur = None
            elif cur is not None and '"' in line:
                parts = line.split('"')
                if len(parts) >= 4:
                    cur[parts[1].lower()] = parts[3]
        return ents

    # ---------- 碰撞 ----------
    def make_hull(self, headnode):
        """返回 (nodes, planes) 供点测试"""
        return self.clipnodes(), self.planes()

    def point_contents(self, hull, planes, p, headnode):
        nodes, _ = hull
        num = headnode
        guard = 0
        while num >= 0:
            if num >= len(nodes) or guard > 4096:
                return CONTENTS_EMPTY
            guard += 1
            planenum, c0, c1 = nodes[num]
            if planenum >= len(planes):
                return CONTENTS_EMPTY
            n, dist, _t = planes[planenum]
            d = n[0] * p[0] + n[1] * p[1] + n[2] * p[2] - dist
            num = c0 if d >= 0 else c1
        return num


if __name__ == "__main__":
    import sys
    b = Bsp(sys.argv[1] if len(sys.argv) > 1 else
            r"C:\GTGame\cs反恐精英1.5\cstrike\maps\de_dust2.bsp")
    print("version", b.version)
    names = ["ENTITIES", "PLANES", "TEXTURES", "VERTICES", "VIS", "NODES", "TEXINFO",
             "FACES", "LIGHTING", "CLIPNODES", "LEAVES", "MARKSURF", "EDGES",
             "SURFEDGES", "MODELS"]
    for i, (o, l) in enumerate(b.lumps):
        print("%-10s ofs=%8d len=%9d" % (names[i], o, l))
    print("faces", len(b.faces()), "verts", len(b.vertices()),
          "tex", len([t for t in b.textures() if t]))
    polys = b.face_polys()
    print("polys", len(polys), "tris", sum(len(p["verts"]) - 2 for p in polys))
    ents = b.entities()
    print("entities", len(ents))
    from collections import Counter
    print(Counter(e.get("classname") for e in ents))
