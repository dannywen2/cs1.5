"""把原版 CS1.5 人物 MDL 烘焙成静态站立姿态网格 (assets/player/)

用法:  python hlsrc/bake_player.py

输出与 assets/vm/usp.geo 完全同格式 (无文件头, 每组依次):
    nv:int32, nt:int32,
    verts: nv*3 float32, uvs: nv*2 float32, colors: nv*3 float32,
    tris: nt*3 uint32
每组顶点独立, tris 是展开的三角形 (索引从 0 开始)。

姿态: 从 idle1 / ref_aim_* 的"第 0 帧"里自动挑一个站得最直、水平包围盒
      能塞进 32x32 碰撞盒的姿态 (HL SDK 骨骼解码, 见 hlsrc/mdl.py)。
坐标: GoldSrc 玩家 MDL 的动画世界是 x=前 / y=左 / z=上 (由头-骨盆、
      脚趾-脚踝方向以及脸部贴图验证)。转到 Ursina 的 右/上/前 右手系:
        X_ursina = +y_mdl, Y_ursina = +z_mdl, Z_ursina = +x_mdl
      这是一个纯旋转 (行列式 +1), 人物不镜像; 脸朝 +z。
      最后按原始包围盒自动把整体等比缩放到 y∈[0,1] (脚底 0 头顶 1),
      水平以身体中心为 0, 三轴用同一个缩放系数以保持真实宽高比。
"""
import json
import math
import os
import struct
import sys

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mdl  # noqa: E402

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = r'C:/GTGame/cs反恐精英1.5/cstrike/models/player'
OUT = os.path.join(BASE, 'assets', 'player')
PLAYERS = ('leet', 'terror', 'sas', 'urban')
MAX_HALF = 0.25          # 归一化后 x/z 的目标半宽 (32 宽 / 72 高 的碰撞盒)

# 候选姿态: (序列名, blend)。全部取第 0 帧; 按顺序选第一个水平放得下的。
POSE_CANDIDATES = (
    ('idle1', 0),
    ('ref_aim_c4', 0),
    ('ref_aim_dualpistols', 2),
    ('ref_aim_ak47', 2),
    ('ref_aim_rifle', 2),
    ('ref_aim_shotgun', 2),
    ('ref_aim_m249', 2),
    ('ref_aim_carbine', 2),
    ('ref_aim_grenade', 8),
)


def _dot(a, b):
    return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]


def _cross(a, b):
    return (a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0])


def _sub(a, b):
    return (a[0]-b[0], a[1]-b[1], a[2]-b[2])


def _norm(a):
    l = math.sqrt(_dot(a, a)) or 1.0
    return (a[0]/l, a[1]/l, a[2]/l)


def _bone_pos(mats, i):
    return (mats[i][0][3], mats[i][1][3], mats[i][2][3])


def _mat_rot(m):
    return [[m[r][c] for c in range(3)] for r in range(3)]


def pose_basis(m, seq, blend):
    """从骨骼位置自动求 (right, up, forward) 三个 MDL 空间正交单位向量.

    up      : 绑定姿态 头-骨盆 的最大分量主轴 (人物模型的竖直轴)
    forward : 根骨 'Bip01' 把"绑定姿态的脚尖方向"旋转到当前姿态后的水平分量。
              用根骨而不是脚趾本身, 避免单脚外八/动画抬脚把整个模型转歪;
              也不依赖贴图 (4 个模型的贴图集布局不同)。
    right   : up x forward, 使 (right, up, forward) 构成右手系 (X x Y = Z),
              与 Ursina/Panda3D 一致, 因此不需要镜像。
    """
    names = {bn['name']: i for i, bn in enumerate(m.bones)}
    bind = m.bone_matrices()
    d = _sub(_bone_pos(bind, names['Bip01 Head']),
             _bone_pos(bind, names['Bip01 Pelvis']))
    ax = max(range(3), key=lambda i: abs(d[i]))
    up = [0.0, 0.0, 0.0]
    up[ax] = 1.0 if d[ax] >= 0 else -1.0
    up = tuple(up)

    up0 = tuple(up)
    toe = _sub(_bone_pos(bind, names['Bip01 L Toe0']),
               _bone_pos(bind, names['Bip01 L Foot']))
    toe = _sub(toe, tuple(up[i] * _dot(toe, up) for i in range(3)))
    toe = _norm(toe)                                   # 绑定姿态的世界前方
    rb = _mat_rot(bind[0])
    rp = _mat_rot(m.posed_matrices(seq, 0, blend)[0])
    local = [sum(rb[r][c] * toe[r] for r in range(3)) for c in range(3)]  # R^T v
    fwd = [sum(rp[r][c] * local[c] for c in range(3)) for r in range(3)]
    fwd = _sub(tuple(fwd), tuple(up[i] * _dot(fwd, up) for i in range(3)))
    if _dot(fwd, fwd) < 1e-6:
        raise ValueError('cannot determine forward from root bone')
    fwd = _norm(fwd)
    right = _norm(_cross(up, fwd))
    up = _norm(_cross(fwd, right))          # Z x X = Y, 保证右手系且不翻转 up
    assert _dot(up, up0) > 0.9, 'up axis flipped: %s' % (up,)
    return right, up, fwd


def _bone_descendants(m, root):
    """返回 root 骨及其所有后代骨的索引集合"""
    out = {root}
    changed = True
    while changed:
        changed = False
        for i, bn in enumerate(m.bones):
            if i not in out and bn['parent'] in out:
                out.add(i)
                changed = True
    return out


def align_head(m, model, pverts, seq, blend, right, up, fwd):
    """把头部骨骼上的顶点绕颈轴旋转, 让脸朝向身体正前方 (+z)。

    部分 ref_aim_* 序列第 0 帧会大幅扭头 (C4/瞄准动画的抬头看表),
    身体朝前但脸朝侧面。这是对头骨顶点做的刚体旋转 (以头骨关节为轴),
    不改变形状/贴图, 只把脸转回来。
    """
    names = {bn['name']: i for i, bn in enumerate(m.bones)}
    hi = names.get('Bip01 Head')
    if hi is None:
        return pverts
    bind = m.bone_matrices()
    posed = m.posed_matrices(seq, 0, blend)
    rb, rp = _mat_rot(bind[hi]), _mat_rot(posed[hi])
    toe = _sub(_bone_pos(bind, names['Bip01 L Toe0']),
               _bone_pos(bind, names['Bip01 L Foot']))
    toe = _sub(toe, tuple(up[i] * _dot(toe, up) for i in range(3)))
    toe = _norm(toe)                                    # 绑定姿态下"脸朝"的世界方向
    local = [sum(rb[r][c] * toe[r] for r in range(3)) for c in range(3)]
    hf = tuple(sum(rp[r][c] * local[c] for c in range(3)) for r in range(3))
    hf = _sub(hf, tuple(up[i] * _dot(hf, up) for i in range(3)))
    hf = _norm(hf)
    hr, hd = _dot(hf, right), _dot(hf, fwd)
    if hd > 0.95 and abs(hr) < 0.3:                    # 已经朝前
        return pverts
    ca, sa = hd, -hr                                   # cos/sin of yaw correction
    ll = math.hypot(ca, sa) or 1.0
    ca, sa = ca / ll, sa / ll
    pivot = _bone_pos(posed, hi)
    headset = _bone_descendants(m, hi)
    out = list(pverts)
    for k, (p, bi) in enumerate(zip(pverts, model.vertbone)):
        if bi not in headset:
            continue
        d = _sub(p, pivot)
        dr, df, du = _dot(d, right), _dot(d, fwd), _dot(d, up)
        nr = dr * ca + df * sa
        nf = -dr * sa + df * ca
        out[k] = tuple(pivot[i] + right[i]*nr + fwd[i]*nf + up[i]*du for i in range(3))
    return out


def _posed_extent(m, seq, blend, basis):
    """某姿态(含头部校正)在目标基下的包围盒跨度, 用于挑姿态/算缩放"""
    right, up, fwd = basis
    model = m.models[0]
    pverts = m.posed_verts(model, seq, 0, blend)
    pverts = align_head(m, model, pverts, seq, blend, right, up, fwd)
    lo = [1e9, 1e9, 1e9]
    hi = [-1e9, -1e9, -1e9]
    for p in pverts:
        for k, axis in enumerate(basis):
            q = _dot(p, axis)
            lo[k] = min(lo[k], q)
            hi[k] = max(hi[k], q)
    return lo, hi


def choose_pose(m):
    names = m.seq_names()
    best = None
    for want, blend in POSE_CANDIDATES:
        if want not in names:
            continue
        seq = names.index(want)
        basis = pose_basis(m, seq, blend)
        lo, hi = _posed_extent(m, seq, blend, basis)
        h = hi[1] - lo[1]
        if h <= 0:
            continue
        halves = ((hi[0]-lo[0])/2/h, (hi[2]-lo[2])/2/h)
        cand = (max(halves) <= MAX_HALF, -h, want, seq, blend, basis, lo, hi, halves)
        if cand[0]:
            return cand
        if best is None or max(halves) < max(best[8]):
            best = cand
    return best or (False, 0, m.seq_names()[0], 0, 0, None, [0]*3, [1]*3, (1, 1))


def save_tex(tex, path):
    """MDL 内嵌调色板解码 -> RGB PNG (无 alpha).

    与 assets/vm/tex 一致: MDL 像素第 0 行对应 UV t=0, 而 Panda3D 的
    V=0 在图片底部, 因此把行序上下翻转, uv 仍写 s/w, t/h。
    """
    im = Image.frombytes('RGBA', (tex.width, tex.height), tex.rgba)
    im = im.transpose(Image.Transpose.FLIP_TOP_BOTTOM).convert('RGB')
    im.save(path)


def bake(name):
    path = os.path.join(SRC, name, name + '.mdl')
    m = mdl.load(path)
    fit, _, pose_name, seq, blend, basis, _lo, _hi, halves = choose_pose(m)
    if basis is None:
        raise ValueError('%s: no usable pose' % name)
    right, up, fwd = basis
    print('%s  pose=%s f0 blend=%d  basis right=%s up=%s fwd=%s  half=(%.3f,%.3f)' % (
        name, pose_name, blend,
        tuple(round(x, 3) for x in right),
        tuple(round(x, 3) for x in up),
        tuple(round(x, 3) for x in fwd), halves[0], halves[1]))

    # 只取第 0 个 bodypart 的人物本体。第 1 个 bodypart 是背部 C4/拆弹包,
    # 默认变体 'blank' 为空; 那个挂件绑在 Bomber/Defuser 骨上, 静态烘焙会游离。
    model = m.models[0]
    pverts = m.posed_verts(model, seq, 0, blend)
    pverts = align_head(m, model, pverts, seq, blend, right, up, fwd)
    # MDL -> Ursina: X=right, Y=up, Z=forward
    cverts = [(_dot(p, right), _dot(p, up), _dot(p, fwd)) for p in pverts]

    # 按姿态后的整体包围盒自动归一化, 三轴等比 (保持真实宽高比)
    lo = [min(p[i] for p in cverts) for i in range(3)]
    hi = [max(p[i] for p in cverts) for i in range(3)]
    height = hi[1] - lo[1]
    if height <= 0:
        raise ValueError('%s: degenerate height' % name)
    s = 1.0 / height
    cx, cz = (lo[0] + hi[0]) / 2, (lo[2] + hi[2]) / 2
    fverts = [((p[0]-cx)*s, (p[1]-lo[1])*s, (p[2]-cz)*s) for p in cverts]

    os.makedirs(os.path.join(OUT, 'tex'), exist_ok=True)
    blob = bytearray()
    groups = []
    tex_files = {}
    for mesh in model.meshes:
        if not mesh.triverts:
            continue
        sr = mesh.skinref
        tex = m.textures[sr] if sr < len(m.textures) else m.textures[0]
        if sr not in tex_files:
            tname = '%s_tex%d.png' % (name, sr)
            save_tex(tex, os.path.join(OUT, 'tex', tname))
            tex_files[sr] = tname
        v, uv, col, idx = [], [], [], []
        for tri in mesh.triverts:
            for (vi, ni, st, tt) in tri:
                if vi >= len(fverts):
                    raise ValueError('%s: vertex index %d out of range' % (name, vi))
                x, y, z = fverts[vi]
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

    with open(os.path.join(OUT, name + '.geo'), 'wb') as fh:
        fh.write(blob)
    blo = [min(p[i] for p in fverts) for i in range(3)]
    bhi = [max(p[i] for p in fverts) for i in range(3)]
    meta = {'name': name, 'groups': groups, 'bbox': [blo, bhi],
            'pose': pose_name, 'frame': 0, 'blend': blend,
            'src_bbox': [lo, hi],
            'basis': {'right': list(right), 'up': list(up), 'forward': list(fwd)}}
    with open(os.path.join(OUT, name + '.json'), 'w', encoding='utf-8') as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=2)
    print('  verts=%d tris=%d groups=%d bbox=%s' % (
        len(fverts), sum(g['tris'] for g in groups), len(groups),
        [[round(x, 4) for x in blo], [round(x, 4) for x in bhi]]))
    return meta


def verify(name):
    """读回 .geo 校验格式/范围/索引; 校验贴图 PNG 可打开"""
    with open(os.path.join(OUT, name + '.geo'), 'rb') as fh:
        raw = fh.read()
    with open(os.path.join(OUT, name + '.json'), encoding='utf-8') as fh:
        meta = json.load(fh)
    pos = 0
    allpts = []
    for gi, g in enumerate(meta['groups']):
        nv, nt = struct.unpack_from('<ii', raw, pos)
        pos += 8
        need = nv*12 + nv*8 + nv*12 + nt*12
        assert nv > 0 and nt > 0, (name, gi, nv, nt)
        assert pos + need <= len(raw), (name, gi, 'truncated')
        verts = struct.unpack_from('<%df' % (nv*3), raw, pos)
        pos += nv*12
        uvs = struct.unpack_from('<%df' % (nv*2), raw, pos)
        pos += nv*8
        cols = struct.unpack_from('<%df' % (nv*3), raw, pos)
        pos += nv*12
        tris = struct.unpack_from('<%dI' % (nt*3), raw, pos)
        pos += nt*12
        assert nt == g['tris'], (name, gi, nt, g['tris'])
        assert all(0 <= i < nv for i in tris), (name, gi, 'index out of range')
        assert all(0.0 <= u <= 1.001 and 0.0 <= v <= 1.001
                   for u, v in zip(uvs[::2], uvs[1::2])), (name, gi, 'uv out of range')
        assert all(abs(c - 1.0) < 1e-6 for c in cols), (name, gi, 'color')
        allpts.extend([verts[i:i+3] for i in range(0, len(verts), 3)])
        with Image.open(os.path.join(OUT, 'tex', g['tex'])) as im:
            assert im.mode == 'RGB', (g['tex'], im.mode)
            im.load()
    assert pos == len(raw), (name, 'trailing bytes', pos, len(raw))
    xs, ys, zs = ([p[i] for p in allpts] for i in range(3))
    assert abs(min(ys)) < 1e-5 and abs(max(ys) - 1.0) < 1e-5, (name, 'y', min(ys), max(ys))
    assert -0.26 < min(xs) and max(xs) < 0.26, (name, 'x', min(xs), max(xs))
    assert -0.26 < min(zs) and max(zs) < 0.26, (name, 'z', min(zs), max(zs))
    bb = meta['bbox']
    assert abs(bb[0][1]) < 1e-5 and abs(bb[1][1] - 1.0) < 1e-5
    print('  verify OK  x=[%.3f,%.3f] y=[%.3f,%.3f] z=[%.3f,%.3f]' % (
        min(xs), max(xs), min(ys), max(ys), min(zs), max(zs)))


if __name__ == '__main__':
    for n in PLAYERS:
        bake(n)
    print('--- verification ---')
    for n in PLAYERS:
        verify(n)
