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
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mdl            # noqa: E402
import bake_player    # noqa: E402

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = r'C:/GTGame/cs反恐精英1.5/cstrike/models/player'
OUT = os.path.join(BASE, 'assets', 'player')
PLAYERS = ('leet', 'terror', 'sas', 'urban')
CLIPS = ('walk', 'run')


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

        def normalise(pverts):
            cverts = [(bake_player._dot(p, right),
                       bake_player._dot(p, up),
                       bake_player._dot(p, fwd)) for p in pverts]
            lo = [min(p[i] for p in cverts) for i in range(3)]
            hi = [max(p[i] for p in cverts) for i in range(3)]
            s = 1.0 / (hi[1] - lo[1])
            cx = (lo[0] + hi[0]) / 2
            cz = (lo[2] + hi[2]) / 2
            return [((c[0] - cx) * s, (c[1] - lo[1]) * s, (c[2] - cz) * s)
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
            frames = []
            for f in idxs:
                pv = m.posed_verts(model, seq=si, frame=f)
                pv = bake_player.align_head(m, model, pv, si, 0, right, up, fwd)
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
