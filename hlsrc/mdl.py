"""GoldSrc MDL v10 解析器 (只取渲染需要的几何 + 贴图)

关键点:
- model 块 112 字节, 含 vertindex(顶点位置偏移) / normindex(法线偏移), 顶点是 vec3 浮点
- 三角形不是定长表, 而是 strip/fan 序列: 每段开头 <h> N, 正数=strip 负数=fan,
  随后 |N| 个 8 字节 trivert (u16 vert, u16 norm, u16 s, u16 t)
- 贴图: 结构体在 textureindex, 像素在 index(绝对偏移), 每张贴图自己的
  768B 调色板紧跟在像素之后
- 骨骼动画: 角度必须按 SDK AngleQuaternion 的半角构造四元数, 六个通道都是
  value = rest + decompressed * scale (CalcBonePosition / CalcBoneQuaternion)
"""
import os
import struct
import math


def _angle_quat(rx, ry, rz, half=True):
    """GoldSrc AngleQuaternion (mathlib.cpp). angles 用弧度; half=True 是 SDK 用的半角约定."""
    k = 0.5 if half else 1.0
    sy, cy = math.sin(rz * k), math.cos(rz * k)     # angles[2] -> Z
    sp, cp = math.sin(ry * k), math.cos(ry * k)     # angles[1] -> Y
    sr, cr = math.sin(rx * k), math.cos(rx * k)     # angles[0] -> X
    return (sr * cp * cy - cr * sp * sy,
            cr * sp * cy + sr * cp * sy,
            cr * cp * sy - sr * sp * cy,
            cr * cp * cy + sr * sp * sy)


def _quat_matrix(q):
    """GoldSrc QuaternionMatrix (mathlib.cpp) — 列向量约定: v' = M · v + t"""
    x, y, z, w = q
    return [[1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y - w * z), 2.0 * (x * z + w * y)],
            [2.0 * (x * y + w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z - w * x)],
            [2.0 * (x * z - w * y), 2.0 * (y * z + w * x), 1.0 - 2.0 * (x * x + y * y)]]


def _angle_matrix(rx, ry, rz, radians=True):
    """骨骼旋转矩阵 = QuaternionMatrix(AngleQuaternion(angles)), 列向量约定.

    radians 仅为兼容旧诊断脚本的调用签名; SDK 的骨骼角度是弧度且用半角。
    """
    return _quat_matrix(_angle_quat(rx, ry, rz, half=True))


def _concat(m1, m2):
    """R_ConcatTransforms (列向量约定): out = m1 ∘ m2 (先 m2 后 m1)"""
    out = [[0.0] * 4 for _ in range(3)]
    for i in range(3):
        for j in range(4):
            out[i][j] = (m1[i][0] * m2[0][j] + m1[i][1] * m2[1][j]
                         + m1[i][2] * m2[2][j]
                         + (m1[i][3] if j == 3 else 0.0))
    return out


class MdlTexture:
    __slots__ = ('name', 'width', 'height', 'rgba')

    def __init__(self, name, width, height, rgba):
        self.name = name
        self.width = width
        self.height = height
        self.rgba = rgba


class MdlMesh:
    __slots__ = ('skinref', 'triverts')

    def __init__(self, skinref, triverts):
        self.skinref = skinref
        self.triverts = triverts          # [((v,n,s,t), (v,n,s,t), (v,n,s,t)), ...]

    @property
    def tris(self):
        return len(self.triverts)


class MdlModel:
    __slots__ = ('name', 'verts', 'meshes', 'vertbone')

    def __init__(self, name, verts, meshes, vertbone=None):
        self.name = name
        self.verts = verts
        self.meshes = meshes
        self.vertbone = vertbone or []


class Mdl:
    def __init__(self, path):
        with open(path, 'rb') as f:
            self.raw = f.read()
        b = self.raw
        if b[:4] != b'IDST' or struct.unpack_from('<i', b, 4)[0] != 10:
            raise ValueError('not a GoldSrc MDL v10: %s' % path)
        self.path = path
        (self.num_bones, self.bone_index,
         _nbc, _bci,
         _nhb, _hbi,
         self.num_seq, self.seq_index,
         self.num_seqgrp, self.seqgrp_index,
         self.num_tex, self.tex_index, self.tex_data,
         self.num_skinref, self.num_skinfam, self.skin_index,
         self.num_bodyparts, self.bodypart_index) = struct.unpack_from('<19i', b, 136)[1:]

        self.textures = self._read_textures()
        self.skins = list(struct.unpack_from('<%dh' % (self.num_skinref * self.num_skinfam),
                                             b, self.skin_index)) if self.num_skinfam else []
        self.bones = self._read_bones()
        self.models = self._read_models()

    # ---------- 骨骼 ----------
    def _read_bones(self):
        """bone 块 112 字节: name[32] parent flags ctrl[6] value[6] scale[6]

        value = [x, y, z, rx, ry, rz], 旋转是弧度制。
        """
        b = self.raw
        out = []
        for i in range(self.num_bones):
            o = self.bone_index + i * 112
            name = b[o:o + 32].split(b'\x00')[0].decode('latin1')
            parent = struct.unpack_from('<i', b, o + 32)[0]
            val = struct.unpack_from('<6f', b, o + 64)
            out.append({'name': name, 'parent': parent, 'value': val})
        return out

    @staticmethod
    def _bone_matrix(v):
        """3x4 矩阵 (列向量约定): SDK 半角四元数 + 位移"""
        m = _angle_matrix(v[3], v[4], v[5])
        m[0].append(v[0])
        m[1].append(v[1])
        m[2].append(v[2])
        return m

    def _parented(self, mats):
        for i, bn in enumerate(self.bones):
            p = bn['parent']
            if 0 <= p < i:
                mats[i] = _concat(mats[p], mats[i])
        return mats

    def bone_matrices(self):
        """绑定姿态下每根骨骼的 3x4 矩阵(列向量约定: v' = M · v + t)"""
        mats = [self._bone_matrix(bn['value']) for bn in self.bones]
        return self._parented(mats)

    def seq_names(self):
        """动作序列名列表"""
        return [self.raw[self.seq_index + s * 176:
                         self.seq_index + s * 176 + 32].split(b'\x00')[0].decode('latin1')
                for s in range(self.num_seq)]

    def _anim_value(self, pos, frame):
        """解压一个动画通道在指定帧的数值 (HL SDK CalcBone* 的 span 逻辑).

        mstudioanimvalue_t 是 2 字节 union: {u8 valid, u8 total} 头或 i16 值。
        span 布局: [valid,total][val0][val1]...[val(valid-1)], 每个 2 字节;
        帧 k 的值是元素 k+1 (即 pos + (k+1)*2), 跨 total 帧。
        """
        b = self.raw
        k = frame
        guard = 0
        valid = 0
        while guard < 4096:
            guard += 1
            valid = b[pos]
            total = b[pos + 1]
            if total == 0 or total > k:
                break
            k -= total
            pos += (valid + 1) * 2
        if valid > k:                                   # 帧在有效区间内
            e = k + 1
        else:                                           # 帧超出 -> 取最后一个有效值
            e = valid
        return struct.unpack_from('<h', b, pos + e * 2)[0]

    def bone_values(self, seq=0, frame=0, blend=0):
        """某序列某帧每根骨骼的 6 个值 (位移 + 欧拉角), 已解压缩放。

        HL SDK: 六个通道全部是 rest + decompressed*scale, 旋转再经
        AngleQuaternion 半角四元数 (CalcBoneQuaternion)。过去的 "旋转绝对替换"
        会让 CS1.5 人物 MDL 的头/四肢彻底散架, 武器 MDL 也只是碰巧近似。
        """
        raw = self.raw
        so = self.seq_index + seq * 176
        numblends = struct.unpack_from('<i', raw, so + 120)[0]
        animindex = struct.unpack_from('<i', raw, so + 124)[0]
        blend = min(blend, max(numblends - 1, 0))
        base = animindex
        vals = []
        for bi in range(self.num_bones):
            bo = self.bone_index + bi * 112
            rest = struct.unpack_from('<6f', raw, bo + 64)
            scl = struct.unpack_from('<6f', raw, bo + 88)
            v = list(rest)
            ao = base + (blend * self.num_bones + bi) * 12
            if ao + 12 <= len(raw):
                offs = struct.unpack_from('<6H', raw, ao)
                for j in range(6):
                    if offs[j] and ao + offs[j] + 4 <= len(raw):
                        v[j] = rest[j] + self._anim_value(ao + offs[j], frame) * scl[j]
            vals.append(v)
        return vals

    def posed_matrices(self, seq=0, frame=0, blend=0):
        """某序列某帧每根骨骼的世界 3x4 矩阵 (列向量约定)"""
        mats = [self._bone_matrix(v) for v in self.bone_values(seq, frame, blend)]
        return self._parented(mats)

    def posed_verts(self, model, seq=0, frame=0, blend=0):
        """把某个动作序列某一帧的骨骼姿态应用到顶点上.

        这是关键: MDL 原始顶点是"蒙皮前/绑定姿态下"的, 手/手臂/头部等部件
        都绑在骨骼上; 静态导出前必须把动画姿态烘焙进顶点。
        """
        if not self.bones or not model.vertbone or self.num_seq <= 0:
            return model.verts
        mats = self.posed_matrices(seq, frame, blend)
        out = []
        for v, bi in zip(model.verts, model.vertbone):
            m = mats[bi] if bi < len(mats) else None
            if m is None:
                out.append(v)
                continue
            x, y, z = v
            out.append((m[0][0] * x + m[0][1] * y + m[0][2] * z + m[0][3],
                        m[1][0] * x + m[1][1] * y + m[1][2] * z + m[1][3],
                        m[2][0] * x + m[2][1] * y + m[2][2] * z + m[2][3]))
        return out

    # ---------- 贴图 ----------
    def _read_textures(self):
        b = self.raw
        out = []
        for i in range(self.num_tex):
            o = self.tex_index + i * 80
            name = b[o:o + 64].split(b'\x00')[0].decode('latin1')
            _flags, w, h, idx = struct.unpack_from('<4i', b, o + 64)
            n = w * h
            px = b[idx:idx + n]
            # GoldSrc v10: 每张贴图自己的 768B 调色板紧跟在其像素之后
            pal = b[idx + n:idx + n + 768]
            if len(pal) < 768:
                pal = bytes(768)
            rgba = bytearray(n * 4)
            for k in range(n):
                c = px[k] * 3
                j = k * 4
                rgba[j] = pal[c]
                rgba[j + 1] = pal[c + 1]
                rgba[j + 2] = pal[c + 2]
                rgba[j + 3] = 255
            out.append(MdlTexture(name, w, h, bytes(rgba)))
        return out

    # ---------- 模型/网格 ----------
    def _read_models(self):
        b = self.raw
        models = []
        for bp in range(self.num_bodyparts):
            o = self.bodypart_index + bp * 76
            _name, nummodels, _base, modelindex = struct.unpack_from('<64siii', b, o)
            for mi in range(nummodels):
                mo = modelindex + mi * 112
                name = b[mo:mo + 64].split(b'\x00')[0].decode('latin1')
                (_typ, _rad, nummesh, meshindex,
                 numverts, vertinfo, vertindex,
                 numnorms, _norminfo, normindex,
                 _ng, _gi) = struct.unpack_from('<ifiiiiiiiiii', b, mo + 64)
                verts = [struct.unpack_from('<3f', b, vertindex + i * 12) for i in range(numverts)]
                vb = list(b[vertinfo:vertinfo + numverts]) if numverts else []
                meshes = []
                for k in range(nummesh):
                    numtris, triindex, skinref, _nn, _ni = struct.unpack_from('<5i', b, meshindex + k * 20)
                    meshes.append(MdlMesh(skinref, self._read_tris(triindex, numtris)))
                models.append(MdlModel(name, verts, meshes, vb))
        return models

    def _read_tris(self, off, numtris):
        """解析 strip/fan 序列 -> 三角形列表 (顶点索引三元组)"""
        b = self.raw
        pos = off
        out = []
        got = 0
        guard = 0
        while got < numtris and pos + 2 <= len(b) and guard < 8192:
            guard += 1
            n = struct.unpack_from('<h', b, pos)[0]
            pos += 2
            if n == 0:
                break
            cnt = abs(n)
            if pos + cnt * 8 > len(b):
                break
            tv = [struct.unpack_from('<4H', b, pos + i * 8) for i in range(cnt)]
            pos += cnt * 8
            if n > 0:                                  # strip
                for i in range(cnt - 2):
                    a, c = tv[i], tv[i + 2]
                    tri = (a, tv[i + 1], c) if i % 2 == 0 else (tv[i + 1], a, c)
                    out.append(tri)
                    got += 1
                    if got >= numtris:
                        break
            else:                                      # fan
                for i in range(1, cnt - 1):
                    out.append((tv[0], tv[i], tv[i + 1]))
                    got += 1
                    if got >= numtris:
                        break
        return out


def load(path):
    return Mdl(path)


if __name__ == '__main__':
    import sys
    m = Mdl(sys.argv[1] if len(sys.argv) > 1 else '_hl_glock.mdl')
    print('bones', m.num_bones, 'textures', m.num_tex, 'models', len(m.models))
    for t in m.textures:
        print('  tex', t.name, t.width, 'x', t.height)
    for md in m.models:
        print('  model', md.name, 'verts', len(md.verts),
              'meshes', [(x.skinref, len(x.tris)) for x in md.meshes])
