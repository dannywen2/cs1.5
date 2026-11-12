"""把 GoldSrc 天空盒(gfx/env/<skyname>{up,dn,lf,rt,ft,bk}.tga) 转成 PNG 供 Ursina 使用."""
import os
import sys

from panda3d.core import PNMImage, Filename

SRC = r'C:/GTGame/cs反恐精英1.5/cstrike/gfx/env'
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'assets', 'sky')
FACES = ('rt', 'lf', 'bk', 'ft', 'up', 'dn')


def find_face(skyname, face):
    """大小写混排的原始文件名, 逐个比对"""
    cands = []
    for f in os.listdir(SRC):
        base, ext = os.path.splitext(f)
        if ext.lower() != '.tga':
            continue
        if base.lower() == (skyname + face).lower():
            cands.append(f)
    return cands[0] if cands else None


def convert(skyname):
    os.makedirs(OUT, exist_ok=True)
    ok = 0
    for face in FACES:
        src = find_face(skyname, face)
        if not src:
            print('  MISS %s%s' % (skyname, face))
            continue
        img = PNMImage()
        if not img.read(Filename.fromOsSpecific(os.path.join(SRC, src))):
            print('  READ FAIL', src)
            continue
        # 原版 TGA 的 alpha 通道恒为 0(不参与渲染), 直接丢弃, 否则 PNG 会全透明
        img.alphaFill(1.0)
        img.setNumChannels(3)
        dst = os.path.join(OUT, '%s_%s.png' % (skyname.lower(), face))
        img.write(Filename.fromOsSpecific(dst))
        print('  %-12s -> %s  %dx%d' % (src, os.path.basename(dst), img.getXSize(), img.getYSize()))
        ok += 1
    return ok


if __name__ == '__main__':
    name = sys.argv[1] if len(sys.argv) > 1 else 'des'
    print('bake skybox:', name)
    n = convert(name)
    print('done, %d/6 faces' % n)
