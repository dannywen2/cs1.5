"""Bake per-frame skinned vertices for bot locomotion animations (v3).

v3 stores, per clip, the vertex counts of each geometry group so the runtime can
split the expanded vertex stream back into the same per-mesh chunks the static
.geo uses. leak: leet has 2 groups (2220 + 36), so a single flat count does not
line up with the meshes.

Format (little endian):
    char[4] "CSAN"
    u16 version = 3
    u16 nseq
    per clip:
        u16 nameLen ; char[nameLen] name
        u16 nframes
        u8  ngroups ; u16[ngroups] groupVerts   (expanded counts per mesh)
        f32[3] bmin ; f32[3] inv
        i16[nframes*totalVerts*3]
"""
import json
import math
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mdl            # noqa: E402
import bake_player    # noqa: E402

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = r'C:/GTGame/cs反恐精英1.5/cstrike/models/player'
OUT = os.path.join(BASE, 'assets', 'player')
PLAYERS = ('leet', 'terror', 'guerilla', 'arctic',
           'sas', 'urban', 'gsg9', 'gign')
CLIPS = ('walk', 'run')


def solve_upright_angle(cam_verts, ref_span_x):
    """Yaw about CAMERA-Y making the camera-X span match the reference.

    cam_verts are already in camera space (right/up/forward basis); camera-X is
    the horizontal screen axis, so that is the span that must match. Solved ONCE
    per clip — see the module docstring for why per-frame solving spins the body.
    """
    if not cam_verts:
        return 0.0
    cx = (max(p[0] for p in cam_verts) + min(p[0] for p in cam_verts)) / 2
    cz = (max(p[2] for p in cam_verts) + min(p[2] for p in cam_verts)) / 2

    def span_x(deg):
        ca, sa = math.cos(math.radians(deg)), math.sin(math.radians(deg))
        lo, hi = 1e9, -1e9
        for (x, _y, z) in cam_verts:
            dx, dz = x - cx, z - cz
            nx = cx + dx * ca + dz * sa
            if nx < lo:
                lo = nx
            if nx > hi:
                hi = nx
        return hi - lo

    best_deg, best_err = 0.0, abs(span_x(0.0) - ref_span_x)
    for deg in range(-180, 181, 2):
        err = abs(span_x(deg) - ref_span_x)
        if err < best_err:
            best_err, best_deg = err, float(deg)
    for step in range(-4, 5):
        deg = best_deg + step * 0.5
        err = abs(span_x(deg) - ref_span_x)
        if err < best_err:
            best_err, best_deg = err, deg
    return best_deg


def rotate_cam_y(cam_verts, deg):
    """Rotate camera-space vertices about camera-Y by a fixed angle."""
    if not cam_verts or abs(deg) < 1e-6:
        return cam_verts
    cx = (max(p[0] for p in cam_verts) + min(p[0] for p in cam_verts)) / 2
    cz = (max(p[2] for p in cam_verts) + min(p[2] for p in cam_verts)) / 2
    ca, sa = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    out = []
    for (x, y, z) in cam_verts:
        dx, dz = x - cx, z - cz
        out.append((cx + dx * ca + dz * sa, y, cz - dx * sa + dz * ca))
    return out


def to_cam(pverts, right, up, fwd):
    return [(bake_player._dot(p, right), bake_player._dot(p, up),
             bake_player._dot(p, fwd)) for p in pverts]


def from_cam(cam_verts, right, up, fwd):
    return [(c[0] * right[0] + c[1] * up[0] + c[2] * fwd[0],
             c[0] * right[1] + c[1] * up[1] + c[2] * fwd[1],
             c[0] * right[2] + c[1] * up[2] + c[2] * fwd[2])
            for c in cam_verts]



def main():
    for name in PLAYERS:
        meta_path = os.path.join(OUT, name + '.json')
        if not os.path.exists(meta_path):
            print('  skip %s' % name)
            continue
        meta = json.load(open(meta_path, encoding='utf-8'))
        basis = meta['basis']
        right, up, fwd = (basis[k] for k in ('right', 'up', 'forward'))

        m = mdl.load(os.path.join(SRC, name, name + '.mdl'))
        model = max(m.models, key=lambda x: len(x.verts))
        seq_names = m.seq_names()

        # 关键: 所有帧必须共用同一个归一化变换。
        # 早期实现每帧用"当前帧自己的包围盒"求 lo/hi/centre, 走路时手臂
        # 外摆会让包围盒变宽 -> 每帧缩放不同, 结果手臂被横向拉宽 (实测
        # 动画 X 跨度为静态的 2.4 倍, 看起来就是"双臂展开"), 而且整体大小
        # 逐帧呼吸。
        # 现在改为: 用静态姿态 (与 bake_player 同一参考帧) 求一次变换,
        # 之后所有帧都用它。
        # 参考序列必须和静态网格一致 (json 里的 pose 字段, 通常是 ref_aim_c4)。
        # 用 seq=0 会拿到 "dummy" 标定姿态 —— 那个姿态手臂是平举的, 用它做
        # 归一化参考会让动画的手臂比静态宽 2~3 倍 (就是"双臂展开")。
        ref_name = meta.get('pose') or 'ref_aim_c4'
        seqs_all = m.seq_names()
        ref_seq = seqs_all.index(ref_name) if ref_name in seqs_all else 0
        ref_pverts = m.posed_verts(model, seq=ref_seq, frame=0)
        ref_pverts = bake_player.align_head(m, model, ref_pverts, ref_seq, 0, right, up, fwd)
        _ref_c = [(bake_player._dot(p, right),
                   bake_player._dot(p, up),
                   bake_player._dot(p, fwd)) for p in ref_pverts]
        # 屏幕横向 = 相机 X 轴, 用它作为宽度基准 (模型 Y 是竖直方向, 不对)
        ref_span_x = (max(p[0] for p in _ref_c) - min(p[0] for p in _ref_c))
        _lo = [min(p[i] for p in _ref_c) for i in range(3)]
        _hi = [max(p[i] for p in _ref_c) for i in range(3)]
        _s = 1.0 / (_hi[1] - _lo[1])
        _cx = (_lo[0] + _hi[0]) / 2
        _cz = (_lo[2] + _hi[2]) / 2

        def normalise(pverts):
            """用共享的静态参考变换, 保证帧间比例一致。"""
            cverts = [(bake_player._dot(p, right),
                       bake_player._dot(p, up),
                       bake_player._dot(p, fwd)) for p in pverts]
            return [((c[0] - _cx) * _s, (c[1] - _lo[1]) * _s, (c[2] - _cz) * _s)
                    for c in cverts]

        def expanded_with_groups(pverts):
            """Return (flat positions, per-group counts) in .geo mesh order."""
            flat, groups = [], []
            for mesh in model.meshes:
                if not mesh.triverts:
                    continue
                n = 0
                for tri in mesh.triverts:
                    for (vi, _ni, _st, _tt) in tri:
                        flat.append(pverts[vi])
                        n += 1
                groups.append(n)
            return flat, groups

        clips = []
        group_counts = None
        for clip in CLIPS:
            if clip not in seq_names:
                continue
            si = seq_names.index(clip)
            so = m.seq_index + si * 176
            nf = struct.unpack_from('<i', m.raw, so + 56)[0]
            # 30 fps 源动画抽到 20 fps: bot 通常在几米外, 这个采样率肉眼看不出
            # 差别, 但数据量降三分之一。保留末帧, 保证循环闭合。
            keep = max(2, int(round(nf * 20.0 / 30.0)))
            idxs = [int(round(i * (nf - 1) / (keep - 1))) for i in range(keep)]
            # 身体朝向是整段 clip 的属性, 只解一次角 —— 逐帧求解会因为目标函数
            # 在最优附近很平而在等价解间跳动 (实测相邻帧差 174 度), 走路时人
            # 会原地打转。
            _f0 = m.posed_verts(model, seq=si, frame=idxs[0])
            _f0 = bake_player.align_head(m, model, _f0, ref_seq, 0, right, up, fwd)
            clip_angle = solve_upright_angle(to_cam(_f0, right, up, fwd), ref_span_x)
            frames = []
            for f in idxs:
                pv = m.posed_verts(model, seq=si, frame=f)
                # 用静态参考序列(seq=0)算头部朝向, 不能用当前动画的 si ——
                # 否则整个人体会按走路姿态的头向被旋转, 手臂会外展。
                pv = bake_player.align_head(m, model, pv, ref_seq, 0, right, up, fwd)
                # 相机空间绕 Y 轴纠偏 (单角), 再变换回模型空间
                pv = from_cam(rotate_cam_y(to_cam(pv, right, up, fwd), clip_angle),
                              right, up, fwd)
                flat, groups = expanded_with_groups(normalise(pv))
                if group_counts is None:
                    group_counts = groups
                frames.append(flat)
            clips.append((clip, frames))

        if not clips or not group_counts:
            print('  %s: no clips' % name)
            continue

        total = sum(group_counts)
        blob = bytearray()
        blob += b'CSAN'
        blob += struct.pack('<HH', 3, len(clips))
        for clip, frames in clips:
            xs = [p[0] for fr in frames for p in fr]
            ys = [p[1] for fr in frames for p in fr]
            zs = [p[2] for fr in frames for p in fr]
            bmin = (min(xs), min(ys), min(zs))
            bmax = (max(xs), max(ys), max(zs))
            inv = []
            for k in range(3):
                ext = bmax[k] - bmin[k]
                inv.append(ext / 32767.0 if ext > 1e-9 else 0.0)
            nb = clip.encode('ascii')
            blob += struct.pack('<H', len(nb)) + nb
            blob += struct.pack('<H', len(frames))
            blob += struct.pack('<B', len(group_counts))
            for c in group_counts:
                blob += struct.pack('<H', c)
            blob += struct.pack('<3f', *bmin)
            blob += struct.pack('<3f', *inv)
            for fr in frames:
                for p in fr:
                    for k in range(3):
                        q = 0 if inv[k] == 0 else int(round((p[k] - bmin[k]) / inv[k]))
                        blob += struct.pack('<h', max(-32768, min(32767, q)))
            print('  %-8s %-5s frames=%3d groups=%s total=%d' % (
                name, clip, len(frames), group_counts, total))

        path = os.path.join(OUT, name + '.anim')
        with open(path, 'wb') as fh:
            fh.write(blob)
        print('  -> %s %.0f KB' % (os.path.basename(path), len(blob) / 1024))


if __name__ == '__main__':
    main()
