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
# GoldSrc 引擎里 walk/run 是 gait 序列, 引擎先把 ref_aim_*(持枪上身)
# 摆好, 再用 gait 数据只覆盖"该序列有动画数据的骨骼"。walk 只带腿/脊柱
# 数据, 手臂永远持枪; run 虽然带手臂数据, 但那是无枪摆臂的废数据,
# 而且本项目的枪模是独立 mesh 固定在身上, 手臂摆开就会跟枪分离。
ARM_BONE_HINTS = ('clavicle', 'upperarm', 'forearm', 'hand', 'finger',
                  'wrist', 'elbow', 'bicep', 'shoulder', 'knuckle')


def arm_bone_set(m):
    out = set()
    for i, bn in enumerate(m.bones):
        low = bn['name'].lower()
        if any(h in low for h in ARM_BONE_HINTS):
            out.add(i)
    return out


def covered_bones(m, seq):
    """gait 序列带动画数据的骨骼集合 (六个通道 offset 不全为 0)"""
    so = m.seq_index + seq * 176
    animindex = struct.unpack_from('<i', m.raw, so + 124)[0]
    return {bi for bi in range(m.num_bones)
            if any(struct.unpack_from('<6H', m.raw, animindex + bi * 12))}


def merged_bone_values(m, base_vals, seq, frame, gait_bones, skip):
    """原版引擎的 gait 合成: ref_aim 姿态打底, gait 只覆盖它有数据的骨骼.

    跳过根骨 (Bip01 位置由实体坐标驱动, 动画里的位移会造成漂移) 和手臂
    骨骼 (保持持枪)。返回每根骨骼的 6 值列表。
    """
    gv = m.bone_values(seq, frame, 0)
    vals = [list(v) for v in base_vals]
    for bi in gait_bones:
        if bi == 0 or bi in skip:
            continue
        vals[bi] = gv[bi]
    return vals


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
        ref_blend = meta.get('blend', 0)
        seqs_all = m.seq_names()
        ref_seq = seqs_all.index(ref_name) if ref_name in seqs_all else 0
        # gait 合成的打底姿态: 与静态网格完全相同的 ref_aim 帧
        base_vals = m.bone_values(ref_seq, 0, ref_blend)
        skip_bones = arm_bone_set(m)
        ref_pverts = m.posed_verts(model, seq=ref_seq, frame=0, blend=ref_blend)
        ref_pverts = bake_player.align_head(m, model, ref_pverts, ref_seq,
                                            ref_blend, right, up, fwd)
        _ref_c = [(bake_player._dot(p, right),
                   bake_player._dot(p, up),
                   bake_player._dot(p, fwd)) for p in ref_pverts]
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
            # gait 合成后身体朝向由 ref_aim 打底天然正确 (根骨+手臂来自
            # 静态姿态), 不再做任何朝向纠偏 —— 旧的"按跨度匹配解偏航角"
            # 是为早期的全身 walk 数据设计的, 在合并数据上目标函数退化,
            # 会解出 ±90~180 度的乱角把人转歪 (实测 walk 解出 -115 度,
            # run 解出 +152 度)。
            gait_bones = covered_bones(m, si)
            frames = []
            for f in idxs:
                # gait 合成 (原版引擎语义): ref_aim 持枪上身打底, gait 只覆盖
                # 腿/脊柱等有数据的骨骼; 根骨与手臂骨骼跳过。
                vals = merged_bone_values(m, base_vals, si, f,
                                          gait_bones, skip_bones)
                pv = m.posed_verts_from(model, vals)
                # 用静态参考序列算头部朝向, 不能用当前动画的 si ——
                # 否则整个人体会按走路姿态的头向被旋转, 手臂会外展。
                pv = bake_player.align_head(m, model, pv, ref_seq,
                                            ref_blend, right, up, fwd)
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
