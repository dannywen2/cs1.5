"""把原版第一人称武器模型(v_*.mdl)烘焙成 Ursina 可用资源

产出 assets/vm/<wid>.geo + assets/vm/tex/<name>_<i>.png + assets/vm/<wid>.json
geo 布局与 dust2.geo 一致: 每组 [nv,nt] + verts(3f) + uvs(2f) + cols(3f) + tris(u32)

坐标: SDK 骨骼姿态烘焙后的模型空间是 (X=枪管前方, Y=右, Z=上), 右手系。
统一用固定的轴置换 (x,y,z)_cam = (Y, Z, X)_model 变换到相机空间
(x=右, y=上, z=前, 枪口朝 +z); 行列式 +1, 不做镜像, 四把武器共用同一基。
之后仅按武器做一次整体平移, 把枪身质心归到 x≈0 / y≈-4.5 / z≈5。
匕首的 idle 姿态是"刀尖朝下", 与枪械的 +z 前轴不一致; 对它额外做一次
固定的刚体旋转(绕质心)把刀刃摆到前上方。刚体旋转不改变几何/手性, 只是
让四把武器共用同一朝向规范, 这样 main.py 里 VMR 只需小幅微调。
"""
import json
import math
import os
import struct
import sys

from panda3d.core import PNMImage, Filename

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mdl  # noqa: E402

SRC = r'C:/GTGame/cs反恐精英1.5/cstrike/models'
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'assets', 'vm')
WEAPONS = {'usp': 'v_usp.mdl', 'ak47': 'v_ak47.mdl', 'awp': 'v_awp.mdl', 'knife': 'v_knife.mdl'}

# 只按贴图名精确匹配手/前臂蒙皮。'handle.bmp'(握把/机匣)、'bolt_handle.bmp'(枪机柄)、
# 'forearm.bmp'(AK 木质护木) 都是枪械部件, 绝对不能被 'hand' 子串误伤。
HAND_STEMS = frozenset(('hand', 'thumb', 'newhand', 'glove', 'sleeve'))

# 规范平移目标: 枪身质心在相机空间的位置
CENTER = (0.0, -4.5, 5.0)

# 匕首刀刃在规范基下的方向 (刀柄->刀尖) 与刀面法线; 由 idle 帧网格 PCA 得到
KNIFE_TIP = (0.5618, -0.8272, 0.0127)
KNIFE_NORMAL = (-0.502, -0.328, 0.800)
# 摆正后的目标: 刀尖朝前偏左上, 刀面宽度方向朝上 (让刀身可见而非一条线)
KNIFE_TARGET = (-0.36, 0.24, 0.90)
KNIFE_ROLL_DEG = -20.0


def _norm(a):
    l = math.sqrt(sum(x * x for x in a)) or 1.0
    return tuple(x / l for x in a)


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0])


def knife_pose_matrix():
    """把 KNIFE_TIP 转到 KNIFE_TARGET 的正交矩阵 (列向量约定, det=+1)。"""
    a0 = _norm(KNIFE_TIP)
    a2 = _norm(KNIFE_NORMAL)
    a1 = _norm(_cross(a2, a0))
    a2 = _norm(_cross(a0, a1))

    t0 = _norm(KNIFE_TARGET)
    up = _norm(_cross(_cross(t0, (0.0, 1.0, 0.0)), t0))
    side = _norm(_cross(up, t0))
    ca = math.cos(math.radians(KNIFE_ROLL_DEG))
    sa = math.sin(math.radians(KNIFE_ROLL_DEG))
    t1 = _norm(tuple(ca * up[i] + sa * side[i] for i in range(3)))
    t2 = _norm(_cross(t0, t1))

    T = [[t0[i], t1[i], t2[i]] for i in range(3)]
    A = [[a0[i], a1[i], a2[i]] for i in range(3)]
    # R = T * A^T
    return [[sum(T[i][k] * A[j][k] for k in range(3)) for j in range(3)]
            for i in range(3)]


def save_tex(tex, path):
    img = PNMImage(tex.width, tex.height, 3)
    rgba = tex.rgba
    for y in range(tex.height):
        for x in range(tex.width):
            j = (y * tex.width + x) * 4
            img.setXel(x, tex.height - 1 - y, rgba[j] / 255, rgba[j + 1] / 255,
                       rgba[j + 2] / 255)
    img.write(Filename.fromOsSpecific(path))


def is_hand(name):
    return os.path.splitext(name.lower().strip())[0] in HAND_STEMS


def to_cam(p):
    """固定规范基: 模型 (X前, Y右, Z上) -> 相机 (x右, y上, z前)"""
    return (p[1], p[2], p[0])


def bake_full(wid, fname):
    m = mdl.load(os.path.join(SRC, fname))
    model = max(m.models, key=lambda x: len(x.verts))
    # 顶点必须按 idle 第 0 帧的骨骼姿态变换: 原始顶点是蒙皮前的, 手/手臂
    # 与枪械部件都绑在骨骼上, 不烘焙会摊成平板。
    pverts = m.posed_verts(model, seq=0, frame=0)
    cam = [to_cam(p) for p in pverts]

    # 用"可见枪械部件"的三角顶点求质心(含三角形顶点重复 = 按面积加权近似),
    # 得到每把武器唯一的一次整体平移。手/前臂不参与, 避免把枪推离中心。
    gun_idx = set()
    for mesh in model.meshes:
        if not mesh.triverts:
            continue
        tex = m.textures[mesh.skinref] if mesh.skinref < len(m.textures) else m.textures[0]
        if is_hand(tex.name):
            continue
        gun_idx.update(t[0] for tri in mesh.triverts for t in tri)
    n = len(gun_idx) or 1
    c = [sum(cam[i][k] for i in gun_idx) / n for k in range(3)]
    off = tuple(CENTER[k] - c[k] for k in range(3))
    cverts = [(p[0] + off[0], p[1] + off[1], p[2] + off[2]) for p in cam]

    # 匕首: 绕规范质心做一次刚体旋转, 把 idle 的"刀尖朝下"摆成朝 +z。
    # 先减质心 CENTER 再旋转再加回去, 保证平移规范化不变。
    if wid == 'knife':
        R = knife_pose_matrix()
        cverts = [tuple(CENTER[i] + sum(R[i][j] * (p[j] - CENTER[j])
                                       for j in range(3)) for i in range(3))
                  for p in cverts]

    os.makedirs(os.path.join(OUT, 'tex'), exist_ok=True)
    groups = []
    blob = bytearray()
    muz_z = None
    for mi, mesh in enumerate(model.meshes):
        if not mesh.triverts:
            continue
        tex = m.textures[mesh.skinref] if mesh.skinref < len(m.textures) else m.textures[0]
        tname = '%s_%02d_tex%d' % (wid, mi, mesh.skinref)
        save_tex(tex, os.path.join(OUT, 'tex', tname + '.png'))
        v, uv, c3, idx = [], [], [], []
        hand_mesh = is_hand(tex.name)
        for tri in mesh.triverts:
            for (vi, ni, s, t) in tri:
                x, y, z = cverts[vi]
                v += [x, y, z]
                uv += [s / tex.width, t / tex.height]
                c3 += [1.0, 1.0, 1.0]
                if not hand_mesh and (muz_z is None or z > muz_z):
                    muz_z = z
            idx += [len(idx), len(idx) + 1, len(idx) + 2]
        blob += struct.pack('<ii', len(v) // 3, len(idx) // 3)
        blob += struct.pack('<%df' % len(v), *v)
        blob += struct.pack('<%df' % len(uv), *uv)
        blob += struct.pack('<%df' % len(c3), *c3)
        blob += struct.pack('<%dI' % len(idx), *idx)
        groups.append({'tex': tname + '.png', 'tris': len(idx) // 3,
                       'skip': hand_mesh})
    with open(os.path.join(OUT, wid + '.geo'), 'wb') as fh:
        fh.write(blob)
    # bbox/muzzle 只统计实际渲染的枪械部件。round 到 1e-4, 避免某些
    # Python 版本的 float repr 在小数值上产生畸形指数, 也方便人工核对。
    pts = [cverts[i] for i in gun_idx] or cverts
    mz = round(muz_z if muz_z is not None else max(p[2] for p in pts), 4)
    meta = {'name': wid, 'groups': groups,
            'muzzle': [mz],
            'bbox': [[round(min(p[k] for p in pts), 4) for k in range(3)],
                     [round(max(p[k] for p in pts), 4) for k in range(3)]]}
    with open(os.path.join(OUT, wid + '.json'), 'w', encoding='utf-8') as fh:
        json.dump(meta, fh)
    print('%-6s verts=%-4d groups=%d tris=%d hand=%d muzzle=%.2f bbox=%s' % (
        wid, len(model.verts), len(groups), sum(g['tris'] for g in groups),
        sum(1 for g in groups if g['skip']), meta['muzzle'][0],
        [[round(x, 2) for x in meta['bbox'][0]], [round(x, 2) for x in meta['bbox'][1]]]))


if __name__ == '__main__':
    for wid, fname in WEAPONS.items():
        bake_full(wid, fname)
