"""把原版第三人称武器模型 (p_*.mdl) 烘焙成 bot 手上可见的枪械资源。

GoldSrc 的 p_ 模型带一整套精简骨骼, 其 idle 姿态已把武器摆成"握在右手"的相对
位置; 但骨骼根原点比玩家模型高约 36 单位。按两个模型 root 骨的位移差对齐后,
再套用 bake_player.py 的同一姿态基/等比归一化, 武器就落在玩家局部 y∈[0,1]
空间的右手与胸前, 枪口朝 +z。输出格式与 assets/player/*.geo 完全相同。
"""
import json
import os
import struct
import sys

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mdl  # noqa: E402

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = r'C:/GTGame/cs反恐精英1.5/cstrike/models'
PLAYER = os.path.join(SRC, 'player', 'leet', 'leet.mdl')
OUT = os.path.join(BASE, 'assets', 'player')
WEAPONS = {
    # 手枪
    'glock18': 'p_glock18.mdl', 'usp': 'p_usp.mdl', 'p228': 'p_p228.mdl',
    'deagle': 'p_deagle.mdl', 'elite': 'p_elite.mdl', 'fiveseven': 'p_fiveseven.mdl',
    # 霰弹枪
    'm3': 'p_m3.mdl', 'xm1014': 'p_xm1014.mdl',
    # 冲锋枪
    'tmp': 'p_tmp.mdl', 'mac10': 'p_mac10.mdl', 'mp5': 'p_mp5.mdl',
    'ump45': 'p_ump45.mdl', 'p90': 'p_p90.mdl',
    # 步枪
    'ak47': 'p_ak47.mdl', 'm4a1': 'p_m4a1.mdl', 'sg552': 'p_sg552.mdl', 'aug': 'p_aug.mdl',
    # 狙击枪
    'scout': 'p_scout.mdl', 'awp': 'p_awp.mdl', 'g3sg1': 'p_g3sg1.mdl', 'sg550': 'p_sg550.mdl',
    # 机枪 / 近战
    'm249': 'p_m249.mdl', 'knife': 'p_knife.mdl',
}


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def save_tex(tex, path):
    im = Image.frombytes('RGBA', (tex.width, tex.height), tex.rgba)
    im = im.transpose(Image.Transpose.FLIP_TOP_BOTTOM).convert('RGB')
    im.save(path)


def main():
    meta = json.load(open(os.path.join(OUT, 'leet.json'), encoding='utf-8'))
    right, up, fwd = (meta['basis'][k] for k in ('right', 'up', 'forward'))
    lo, hi = meta['src_bbox']
    s = 1.0 / (hi[1] - lo[1])
    cx, cz = (lo[0] + hi[0]) / 2, (lo[2] + hi[2]) / 2

    def norm(p):
        c = (dot(p, right), dot(p, up), dot(p, fwd))
        return ((c[0] - cx) * s, (c[1] - lo[1]) * s, (c[2] - cz) * s)

    pm = mdl.load(PLAYER)
    seq = pm.seq_names().index(meta['pose'])
    proot = [pm.posed_matrices(seq, 0, meta['blend'])[0][k][3] for k in range(3)]
    os.makedirs(os.path.join(OUT, 'tex'), exist_ok=True)

    for wid, fname in WEAPONS.items():
        wm = mdl.load(os.path.join(SRC, fname))
        model = max(wm.models, key=lambda x: len(x.verts))
        wroot = [wm.posed_matrices(0, 0, 0)[0][k][3] for k in range(3)]
        diff = [wroot[k] - proot[k] for k in range(3)]
        pv = wm.posed_verts(model, seq=0, frame=0)
        cverts = [norm([p[k] - diff[k] for k in range(3)]) for p in pv]

        blob = bytearray()
        groups = []
        tex_files = {}
        for mi, mesh in enumerate(model.meshes):
            if not mesh.triverts:
                continue
            sr = mesh.skinref
            tex = wm.textures[sr] if sr < len(wm.textures) else wm.textures[0]
            if sr not in tex_files:
                tname = 'w_%s_tex%d.png' % (wid, sr)
                save_tex(tex, os.path.join(OUT, 'tex', tname))
                tex_files[sr] = tname
            v, uv, col, idx = [], [], [], []
            for tri in mesh.triverts:
                for (vi, ni, st, tt) in tri:
                    x, y, z = cverts[vi]
                    v += [x, y, z]
                    uv += [st / tex.width, tt / tex.height]
                    col += [1.0, 1.0, 1.0]
                    idx.append(len(idx))
            blob += struct.pack('<ii', len(v) // 3, len(idx) // 3)
            blob += struct.pack('<%df' % len(v), *v)
            blob += struct.pack('<%df' % len(uv), *uv)
            blob += struct.pack('<%df' % len(col), *col)
            blob += struct.pack('<%dI' % len(idx), *idx)
            groups.append({'tex': tex_files[sr], 'tris': len(idx) // 3, 'skinref': sr})
        with open(os.path.join(OUT, 'w_' + wid + '.geo'), 'wb') as fh:
            fh.write(blob)
        blo = [min(p[i] for p in cverts) for i in range(3)]
        bhi = [max(p[i] for p in cverts) for i in range(3)]
        with open(os.path.join(OUT, 'w_' + wid + '.json'), 'w', encoding='utf-8') as fh:
            json.dump({'name': wid, 'groups': groups, 'bbox': [blo, bhi]}, fh)
        print('%-6s groups=%d tris=%d bbox=%s..%s' % (
            wid, len(groups), sum(g['tris'] for g in groups),
            [round(x, 3) for x in blo], [round(x, 3) for x in bhi]))


if __name__ == '__main__':
    main()
