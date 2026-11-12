"""GoldSrc WAD3 解析 + 贴图解码（只依赖标准库 + PIL）"""
import struct
from pathlib import Path


class Wad:
    def __init__(self, path):
        self.path = Path(path)
        self.raw = self.path.read_bytes()
        if self.raw[:4] != b"WAD3":
            raise ValueError("不是 WAD3: %s" % self.path)
        count, ofs = struct.unpack_from("<ii", self.raw, 4)
        self.entries = {}
        for i in range(count):
            p = ofs + i * 32
            filepos, disksize, size = struct.unpack_from("<iii", self.raw, p)
            typ = self.raw[p + 12:p + 13]
            name = self.raw[p + 16:p + 32].split(b"\0")[0].decode("latin-1")
            self.entries[name.lower()] = dict(pos=filepos, size=size, type=typ)

    def names(self):
        return list(self.entries.keys())

    def miptex(self, name):
        """返回 (w, h, indices_bytes, palette_bytes) 或 None"""
        e = self.entries.get(name.lower())
        if not e or e["type"] != b"C":
            return None
        off, size = e["pos"], e["size"]
        if size < 40:
            return None
        w, h = struct.unpack_from("<ii", self.raw, off + 16)
        mipofs = list(struct.unpack_from("<4i", self.raw, off + 24))
        if w <= 0 or h <= 0 or w > 1024 or h > 1024:
            return None
        base = off + mipofs[0]
        n = w * h
        if base + n > off + size:
            return None
        idx = self.raw[base:base + n]
        # palette 紧跟最后一个 mip: [uint16 colors][768 字节 RGB]
        pal_off = off + mipofs[3] + (w * h // 64) + 2
        pal = self.raw[pal_off:pal_off + 768]
        if len(pal) != 768:
            # 兜底: lump 尾部
            pal = self.raw[off + size - 770:off + size - 2]
        if len(pal) != 768:
            return None
        return w, h, idx, pal


def bsp_miptex_png(bsp, name, palette=None):
    """从 BSP 内嵌 TEXTURES 解一张贴图; 优先使用每张贴图自己的局部调色板。"""
    from PIL import Image
    texs = bsp.textures()
    data = bsp.lump(2)
    for t in texs:
        if not t or t[0].lower() != name.lower():
            continue
        _n, w, h, mipofs, _mip1, pal_off, name_only = t
        if name_only or w <= 0 or h <= 0:
            return None                 # 像素在外部 WAD, 不能把贴图名当像素解
        n = w * h
        if mipofs + n > len(data):
            continue
        pal = (data[pal_off:pal_off + 768]
               if pal_off is not None and pal_off + 768 <= len(data)
               else palette)
        if pal is None or len(pal) < 768:
            continue
        idx = data[mipofs:mipofs + n]
        im = Image.frombytes("P", (w, h), idx)
        im.putpalette(pal[:768])
        return im.convert("RGB")
    return None


def wad_miptex_png(wad, name):
    from PIL import Image
    m = wad.miptex(name)
    if not m:
        return None
    w, h, idx, pal = m
    im = Image.frombytes("P", (w, h), idx)
    im.putpalette(pal)
    return im.convert("RGB")


def load_palette(cstrike_dir):
    p = Path(cstrike_dir) / "gfx" / "palette.lmp"
    if not p.exists():
        p = Path(cstrike_dir).parent / "valve" / "gfx" / "palette.lmp"
    raw = p.read_bytes()
    return raw[:768]


if __name__ == "__main__":
    w = Wad(r"C:\GTGame\cs反恐精英1.5\cstrike\cs_dust.wad")
    ns = w.names()
    print("lumps", len(ns))
    print(ns[:40])
