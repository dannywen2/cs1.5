# -*- coding: utf-8 -*-
"""CS 1.5 复刻项目 —— 额外静态资产烘焙脚本 (只新建文件, 绝不改动既有文件)。

用法:
    python hlsrc/bake_extra.py

产物:
    assets/sfx/<15 个新名字>.wav
    assets/sprites/{blood,muzzle,kill_default,kill_headshot,kill_knife,kill_awp,kill_grenade}.png
    assets/overviews/dust2.png
    assets/extra.manifest.json

设计:
  * 幂等: 每次运行都按同一份配方重算并覆盖上述「本脚本自己的」输出文件;
    既有的 64 个 assets/sfx/*.wav、web/、serve.py、radar_v2.png 一律只读或完全不碰。
  * 音频只依赖标准库 wave/struct/math: 原版有的直接复制字节, 原版没有的从
    已有 assets/sfx/*.wav 用低通 / 变调 / 增益 / 截断 / 拼接合成 16bit PCM wav。
  * PNG 优先用 Pillow 做编码与 BMP/PNG 解码; 环境里没有 Pillow 时自动降级到
    纯 zlib+struct 的 PNG 编码器 / BMP 解析器 / PNG 解码器, 不安装任何依赖。
  * 所有贴图用解析式距离场逐像素着色 + 超采样抗锯齿, 因此有无 Pillow 结果一致。
"""
from __future__ import annotations

import json
import math
import struct
import wave
import zlib
from pathlib import Path

# ---------------------------------------------------------------------------
# 路径常量 (原版目录只读; 输出目录只写本脚本清单里的文件)
# ---------------------------------------------------------------------------
ROOT = Path(__file__).resolve().parent.parent
CS_CSTRIKE = Path(r"C:\GTGame\cs反恐精英1.5\cstrike")
CS_SOUND = CS_CSTRIKE / "sound"                 # 原版音效根目录
CS_OVERVIEWS = CS_CSTRIKE / "overviews"         # 原版俯视图目录
OUT_SFX = ROOT / "assets" / "sfx"
OUT_SPRITES = ROOT / "assets" / "sprites"
OUT_OVERVIEWS = ROOT / "assets" / "overviews"
MANIFEST = ROOT / "assets" / "extra.manifest.json"
RADAR_FALLBACK = ROOT / "radar_v2.png"          # 俯视图缺失时的降级素材 (只读)
EXISTING_SFX = OUT_SFX                          # 合成用的现有 wav (只读)

try:  # Pillow 可选: 只用于 PNG 编码 / 原版图片解码, 缺失时走纯标准库实现
    from PIL import Image
except ImportError:  # pragma: no cover - 无第三方依赖时的正常分支
    Image = None

PNG_SIG = b"\x89PNG\r\n\x1a\n"


def clamp(v, lo=0.0, hi=1.0):
    return lo if v < lo else (hi if v > hi else v)


def smoothstep(a, b, x):
    t = clamp((x - a) / (b - a))
    return t * t * (3.0 - 2.0 * t)


def mix(c1, c2, t):
    t = clamp(t)
    return tuple(c1[i] + (c2[i] - c1[i]) * t for i in range(3))


# ===========================================================================
# 一、WAV: 读取 / DSP / 写入 (全部标准库)
# ===========================================================================
def read_wav(path: Path):
    """读 PCM wav -> ([-1,1] 单声道浮点采样, 采样率)。8bit 无符号 / 16bit 有符号。"""
    with wave.open(str(path), "rb") as w:
        if w.getcomptype() != "NONE":
            raise ValueError("非 PCM wav: %s" % path)
        ch, sw, sr = w.getnchannels(), w.getsampwidth(), w.getframerate()
        raw = w.readframes(w.getnframes())
    if sw == 1:
        vals = [(b - 128) / 128.0 for b in raw]
    elif sw == 2:
        vals = [p[0] / 32768.0 for p in struct.iter_unpack("<h", raw)]
    else:
        raise ValueError("不支持的采样宽度 %d: %s" % (sw, path))
    if ch > 1:
        vals = [sum(vals[i:i + ch]) / ch for i in range(0, len(vals) - ch + 1, ch)]
    return vals, sr


def write_wav(path: Path, samples, sr: int):
    """写 16bit PCM mono wav (标准 wave 模块, 浏览器可直接解码)。"""
    buf = bytearray()
    for v in samples:
        buf += struct.pack("<h", int(round(max(-1.0, min(1.0, v)) * 32767.0)))
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(bytes(buf))


def is_pcm_wav(path: Path) -> bool:
    """复制前先确认原版文件确实能被 wave.open() 解码。"""
    try:
        with wave.open(str(path), "rb") as w:
            return w.getcomptype() == "NONE" and w.getnframes() > 0
    except (wave.Error, OSError, EOFError):
        return False


def lowpass(s, sr, fc, passes=1):
    """一阶 IIR 低通; 多级级联得到更闷的消音 / 木质听感。"""
    a = 1.0 - math.exp(-2.0 * math.pi * min(fc, sr * 0.45) / sr)
    out = list(s)
    for _ in range(passes):
        y = out[0] if out else 0.0
        res = []
        for x in out:
            y += a * (x - y)
            res.append(y)
        out = res
    return out


def resample_speed(s, speed):
    """变调: speed<1 变低沉变长, speed>1 变尖变短 (线性插值, 不引入新库)。"""
    if speed == 1.0 or not s:
        return list(s)
    n = max(1, int(len(s) / speed))
    out = []
    last = len(s) - 1
    for i in range(n):
        pos = i * speed
        j = int(pos)
        if j >= last:
            out.append(s[last])
            continue
        f = pos - j
        out.append(s[j] + (s[j + 1] - s[j]) * f)
    return out


def scale(s, gain):
    return [v * gain for v in s]


def silence(sr, seconds):
    return [0.0] * int(sr * seconds)


def fade(s, sr, fin=0.004, fout=0.012):
    """首尾短淡入淡出, 避免截断/拼接产生爆音。"""
    out = list(s)
    ni, no = int(sr * fin), int(sr * fout)
    for i in range(min(ni, len(out))):
        out[i] *= i / max(1, ni)
    for i in range(min(no, len(out))):
        out[len(out) - 1 - i] *= i / max(1, no)
    return out


def trim(s, sr, seconds):
    """截取前 N 秒并做尾部淡出。"""
    n = min(len(s), int(sr * seconds))
    return fade(s[:n], sr, 0.002, 0.012)


def hollow(s, sr, delay_ms=4.0, wet=0.30):
    """短延迟叠加, 制造木质/空腔的「咚」感。"""
    d = max(1, int(sr * delay_ms / 1000.0))
    return [0.80 * v + wet * (s[i - d] if i >= d else 0.0) for i, v in enumerate(s)]


def variant_from_existing(name: str, base: str):
    """原版源文件缺失时的通用降级: 从现有 sfx 做一个听感不同的短变体。"""
    s, sr = read_wav(EXISTING_SFX / base)
    idx = sum(ord(c) for c in name) % 5
    s = lowpass(s, sr, 5200 + idx * 400, 2)
    s = resample_speed(s, 1.04 + idx * 0.015)
    s = scale(s, 0.80)
    return trim(s, sr, 0.30), sr


# ---- 原版直接复制的 9 个 -------------------------------------------------
# key: (原版 sound/ 下相对路径, 中文来源说明, 缺失时使用的现有 sfx)
DIRECT_SFX = {
    # CS 1.5 的 player/pl_shell1..3 是三个天然略有不同的弹壳落地采样。
    "shell1":         ("player/pl_shell1.wav", "弹壳落地 1", "footstep1.wav"),
    "shell2":         ("player/pl_shell2.wav", "弹壳落地 2", "footstep2.wav"),
    "shell3":         ("player/pl_shell3.wav", "弹壳落地 3", "footstep3.wav"),
    # 中文版无线电台词: 「发现敌人」/「需要支援」。
    "radio_enemy":    ("radio/ct_enemys.wav", "CT 无线电: 发现敌人", "radio.wav"),
    "radio_needbackup": ("radio/ct_backup.wav", "CT 无线电: 请求支援", "radio.wav"),
    # CS 1.5 的脚步按材质分组: pl_step(硬地/水泥)、pl_metal(金属)、pl_tile(瓷砖)。
    "step_conc":      ("player/pl_step1.wav", "水泥/硬地脚步", "footstep1.wav"),
    "step_metal":     ("player/pl_metal1.wav", "金属地面脚步", "footstep3.wav"),
    "step_tile":      ("player/pl_tile1.wav", "瓷砖地面脚步", "footstep4.wav"),
    # 与既有 c4_defuse.wav (= weapons/c4_disarm.wav, 拆弹过程音) 不同的成功提示音。
    "c4_disarmed":    ("weapons/c4_disarmed.wav", "拆弹成功提示 (原版 c4_disarmed)", "c4_beep.wav"),
}


# ---- 合成的 6 个 ---------------------------------------------------------
def make_fire_usp_sil():
    """USP 消音射击: 原版 weapons/usp1.wav 本身已是消音枪声, 且被既有 fire_usp.wav
    占用; 这里以既有 fire_usp.wav 为素材做二级低通 + 轻微降调 + 降音量 + 截尾,
    得到更闷、明显区别于默认 USP 枪声的消音版本。"""
    s, sr = read_wav(EXISTING_SFX / "fire_usp.wav")
    s = lowpass(s, sr, 2400, 2)
    s = resample_speed(s, 0.94)
    s = scale(s, 0.60)
    return trim(s, sr, 0.24), sr


def make_fire_m4a1_sil():
    """M4A1 消音射击: 同上, 原版 weapons/m4a1-1.wav 已被 fire_m4a1.wav 占用;
    用低通 + 降调 + 降音量把枪声压成消音器特有的闷响。"""
    s, sr = read_wav(EXISTING_SFX / "fire_m4a1.wav")
    s = lowpass(s, sr, 1700, 2)
    s = resample_speed(s, 0.95)
    s = scale(s, 0.52)
    return trim(s, sr, 0.60), sr


def make_step_wood():
    """木头脚步: CS 1.5 没有 pl_wood 采样 (材质脚步是 1.6 才加的);
    由既有 footstep2.wav 低通 + 短延迟空腔 + 降调合成偏暖的木板「咚」声。"""
    s, sr = read_wav(EXISTING_SFX / "footstep2.wav")
    s = lowpass(s, sr, 1100, 2)
    s = hollow(s, sr, 4.0, 0.30)
    s = resample_speed(s, 0.90)
    s = scale(s, 1.15)
    return trim(s, sr, 0.28), sr


def make_ric_wood():
    """木头跳弹: 原版只有 ric_conc / ric_metal / ric1..5; 把既有 ric_conc.wav
    重度低通 + 降调 + 截短, 变成钝而闷的木头「噗」声。"""
    s, sr = read_wav(EXISTING_SFX / "ric_conc.wav")
    s = lowpass(s, sr, 900, 2)
    s = resample_speed(s, 0.88)
    s = scale(s, 0.95)
    return trim(s, sr, 0.32), sr


def make_blood1():
    """命中血肉 / 血迹短音: 原版无独立blood采样; 取既有 hit.wav
    (= player/bhit_flesh-1.wav) 的前段低通 squelch + 一小段湿润尾巴拼接。"""
    s, sr = read_wav(EXISTING_SFX / "hit.wav")
    s = lowpass(s, sr, 1500, 1)
    head = fade(s[:int(sr * 0.13)], sr, 0.002, 0.010)
    tail = scale(fade(s[int(sr * 0.16):int(sr * 0.23)], sr, 0.004, 0.020), 0.38)
    return head + silence(sr, 0.012) + tail, sr


def make_round_start():
    """回合开始 / 冻结时间结束提示音: 原版没有独立的 round start 事件音;
    由既有 assets/sfx/buy.wav 截出第一段短电子音, 变调拼接成 1.0x / 1.26x /
    1.5x 的上行三音提示, 简洁且不占用无线电台词。"""
    s, sr = read_wav(EXISTING_SFX / "buy.wav")
    s = trim(s[:int(sr * 0.11)], sr, 0.11)

    def note(speed, gain):
        return fade(scale(resample_speed(s, speed), gain), sr, 0.004, 0.015)

    out = (silence(sr, 0.030) + note(1.00, 0.90)
           + silence(sr, 0.055) + note(1.26, 1.00)
           + silence(sr, 0.055) + note(1.50, 0.85)
           + silence(sr, 0.060))
    return out, sr


SYNTH_SFX = {
    "fire_usp_sil":  (make_fire_usp_sil, "合成: 既有 fire_usp.wav 低通/降调/降音量/截尾"),
    "fire_m4a1_sil": (make_fire_m4a1_sil, "合成: 既有 fire_m4a1.wav 低通/降调/降音量/截尾"),
    "step_wood":     (make_step_wood, "合成: 既有 footstep2.wav 低通/空腔延迟/降调"),
    "ric_wood":      (make_ric_wood, "合成: 既有 ric_conc.wav 低通/降调/截短"),
    "blood1":        (make_blood1, "合成: 既有 hit.wav 低通截断 + 湿润尾巴拼接"),
    "round_start":   (make_round_start, "合成: 既有 buy.wav 截取电子音后上行三音拼接"),
}

SFX_ORDER = [
    "fire_usp_sil", "fire_m4a1_sil", "shell1", "shell2", "shell3",
    "radio_enemy", "radio_needbackup", "step_conc", "step_metal",
    "step_wood", "step_tile", "ric_wood", "blood1", "c4_disarmed",
    "round_start",
]


# ===========================================================================
# 二、PNG: 手写编码器 + 图片解码 (Pillow 优先, 纯标准库兜底)
# ===========================================================================
def png_chunk(tag: bytes, payload: bytes) -> bytes:
    return (struct.pack(">I", len(payload)) + tag + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xffffffff))


def write_png_manual(path: Path, w: int, h: int, rgba: bytes):
    """纯 zlib+struct 手写 RGBA8 PNG (filter 0), 不依赖任何第三方库。"""
    raw = bytearray()
    stride = w * 4
    for y in range(h):
        raw.append(0)  # filter type 0 (None)
        raw += rgba[y * stride:(y + 1) * stride]
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    path.write_bytes(PNG_SIG + png_chunk(b"IHDR", ihdr)
                     + png_chunk(b"IDAT", zlib.compress(bytes(raw), 9))
                     + png_chunk(b"IEND", b""))


def write_png(path: Path, w: int, h: int, rgba: bytes):
    """优先用 Pillow 编码 (压缩更好); 没有 Pillow 时用手写 PNG 编码器。"""
    if Image is not None:
        Image.frombytes("RGBA", (w, h), bytes(rgba)).save(str(path), "PNG", optimize=True)
    else:
        write_png_manual(path, w, h, rgba)


def read_bmp_rgb(path: Path):
    """读原版 8bit 调色板 / 24bit BMP -> ([(r,g,b)...], w, h)。"""
    if Image is not None:
        im = Image.open(str(path)).convert("RGB")
        return list(im.get_flattened_data()), im.size[0], im.size[1]

    data = path.read_bytes()
    if data[:2] != b"BM":
        raise ValueError("不是 BMP: %s" % path)
    offset = struct.unpack_from("<I", data, 10)[0]
    hdr_size, w, h, _planes, bpp, comp = struct.unpack_from("<IiiHHI", data, 14)
    if comp != 0 or bpp not in (8, 24) or hdr_size < 40:
        raise ValueError("不支持的 BMP 格式 (bpp=%d comp=%d)" % (bpp, comp))
    bottom_up = h > 0
    h = abs(h)
    palette = []
    if bpp == 8:
        ncolors = struct.unpack_from("<I", data, 46)[0] or 256
        for i in range(min(ncolors, (offset - 14 - hdr_size) // 4)):
            b, g, r, _a = data[14 + hdr_size + 4 * i: 18 + hdr_size + 4 * i]
            palette.append((r, g, b))
    stride = ((w * bpp // 8 + 3) // 4) * 4
    px = []
    for y in range(h):
        row = (h - 1 - y) if bottom_up else y
        off = offset + row * stride
        if bpp == 8:
            px.extend(palette[data[off + x]] for x in range(w))
        else:
            for x in range(w):
                b, g, r = data[off + 3 * x: off + 3 * x + 3]
                px.append((r, g, b))
    return px, w, h


def read_png_rgb(path: Path):
    """读 RGB/RGBA8 PNG -> ([(r,g,b)...], w, h); 纯标准库实现 (含 filter 0..4)。"""
    if Image is not None:
        im = Image.open(str(path)).convert("RGB")
        return list(im.get_flattened_data()), im.size[0], im.size[1]

    data = path.read_bytes()
    if data[:8] != PNG_SIG:
        raise ValueError("不是 PNG: %s" % path)
    pos, idat, w, h, ct, bd, interlace = 8, bytearray(), 0, 0, 0, 0, 0
    while pos + 8 <= len(data):
        ln = struct.unpack_from(">I", data, pos)[0]
        tag = data[pos + 4:pos + 8]
        payload = data[pos + 8:pos + 8 + ln]
        pos += 12 + ln
        if tag == b"IHDR":
            w, h, bd, ct, _cm, _fm, interlace = struct.unpack(">IIBBBBB", payload)
        elif tag == b"IDAT":
            idat += payload
        elif tag == b"IEND":
            break
    if bd != 8 or ct not in (2, 6) or interlace != 0:
        raise ValueError("不支持的 PNG (bitdepth=%d colortype=%d)" % (bd, ct))
    bpp = 3 if ct == 2 else 4
    stride = w * bpp
    raw = zlib.decompress(bytes(idat))
    prev = bytearray(stride)
    pixels, p = [], 0
    for _y in range(h):
        f = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        for i in range(stride):
            a = line[i - bpp] if i >= bpp else 0
            b = prev[i]
            c = prev[i - bpp] if i >= bpp else 0
            if f == 1:
                line[i] = (line[i] + a) & 255
            elif f == 2:
                line[i] = (line[i] + b) & 255
            elif f == 3:
                line[i] = (line[i] + ((a + b) >> 1)) & 255
            elif f == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pred = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pred) & 255
            elif f != 0:
                raise ValueError("不支持的 PNG filter %d" % f)
        for i in range(0, stride, bpp):
            pixels.append((line[i], line[i + 1], line[i + 2]))
        prev = line
    return pixels, w, h


def resize_box(pixels, w, h, tw, th, tint=None):
    """盒式平均缩小 (原版 1024x768 -> 512x384 正好 2x2); tint 为可选着色系数。"""
    out = []
    for j in range(th):
        y0, y1 = h * j // th, max(h * j // th + 1, h * (j + 1) // th)
        for i in range(tw):
            x0, x1 = w * i // tw, max(w * i // tw + 1, w * (i + 1) // tw)
            r = g = b = n = 0
            for y in range(y0, min(y1, h)):
                base = y * w
                for x in range(x0, min(x1, w)):
                    cr, cg, cb = pixels[base + x]
                    r += cr
                    g += cg
                    b += cb
                    n += 1
            r, g, b = r / n, g / n, b / n
            if tint:
                r, g, b = r * tint[0], g * tint[1], b * tint[2]
            out.append((int(min(255, r)), int(min(255, g)), int(min(255, b))))
    return out


def key_out_green(pixels):
    """原版 overviews/*.bmp 用纯绿 (0,255,0) 表示地图外区域; 网页里显示成
    刺眼荧光绿很突兀, 这里在缩小前把它换成深色 HUD 底色, 避免边缘出现绿晕。"""
    def conv(c):
        r, g, b = c
        if g > 170 and r < 140 and b < 140:
            return (24, 28, 26)
        return c
    return [conv(c) for c in pixels]


def rgb_to_rgba_bytes(pixels):
    buf = bytearray()
    for r, g, b in pixels:
        buf += bytes((r, g, b, 255))
    return bytes(buf)


# ===========================================================================
# 三、解析式距离场贴图 (逐像素着色 + 超采样, 有无 Pillow 结果一致)
# ===========================================================================
def ink(d, aa):
    """把有符号距离转成抗锯齿覆盖率 (d<0 在形状内部)。"""
    return 1.0 - smoothstep(-aa, aa, d)


def over(px, color, a):
    """src-over 合成; px / 返回值为 (r,g,b,alpha), alpha∈[0,1]。"""
    a = clamp(a)
    if a <= 0.0:
        return px
    r, g, b, pa = px
    na = a + pa * (1.0 - a)
    if na <= 0.0:
        return (0.0, 0.0, 0.0, 0.0)
    k = pa * (1.0 - a) / na
    return (color[0] * a / na + r * k,
            color[1] * a / na + g * k,
            color[2] * a / na + b * k, na)


def _box_raw(X, Y, cx, cy, hw, hh):
    qx, qy = abs(X - cx) - hw, abs(Y - cy) - hh
    return min(max(qx, qy), 0.0) + math.hypot(max(qx, 0.0), max(qy, 0.0))


def sd_box(x, y, cx, cy, hw, hh, ang=0.0):
    c, s = math.cos(-ang), math.sin(-ang)
    dx, dy = x - cx, y - cy
    return _box_raw(dx * c - dy * s, dx * s + dy * c, 0, 0, hw, hh)


def sd_ellipse(x, y, cx, cy, rx, ry, ang=0.0):
    c, s = math.cos(-ang), math.sin(-ang)
    dx, dy = x - cx, y - cy
    X, Y = dx * c - dy * s, dx * s + dy * c
    return (math.hypot(X / rx, Y / ry) - 1.0) * min(rx, ry)


def sd_seg(x, y, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy + 1e-12))
    return math.hypot(x - ax - t * dx, y - ay - t * dy)


def sd_ring(x, y, cx, cy, r, w):
    return abs(math.hypot(x - cx, y - cy) - r) - w


def shape(px, d, color, aa, outline=0.016):
    """带深色描边的实心形状, 保证透明背景上轮廓清晰。"""
    px = over(px, (24, 18, 14), ink(d - outline, aa * 1.2))
    return over(px, color, ink(d, aa))


YELLOW = (255, 198, 48)
WHITE = (248, 244, 228)
RED = (214, 42, 36)
DARK = (26, 20, 16)


def sh_blood(x, y, aa):
    """暗红血迹贴花: 不规则主血泊 + 卫星血滴 + 柔化边缘, 透明背景。"""
    r = math.hypot(x, y)
    th = math.atan2(y, x)
    rr = (0.295 + 0.045 * math.sin(3 * th + 0.7)
          + 0.030 * math.sin(7 * th + 2.1) + 0.022 * math.cos(11 * th + 0.4))
    d = r - rr
    a = 1.0 - smoothstep(-0.016, 0.016, d)
    col = mix((70, 5, 8), (142, 18, 20), clamp(r / 0.34))
    mott = 1.0 + 0.16 * math.sin(31 * x + 9 * y) * math.sin(23 * y - 17 * x)
    px = over((0.0, 0.0, 0.0, 0.0), tuple(c * mott for c in col), a * 0.94)
    # 固定位置的飞溅血滴, 让贴花边缘不呆板
    drops = [(-0.34, -0.20, 0.045), (0.33, -0.27, 0.032), (0.36, 0.18, 0.055),
             (-0.28, 0.31, 0.038), (0.12, 0.40, 0.026), (-0.40, 0.10, 0.028),
             (0.24, 0.36, 0.020), (-0.12, -0.38, 0.024), (0.42, -0.05, 0.018),
             (-0.43, -0.31, 0.015), (0.05, -0.43, 0.013)]
    for cx, cy, rad in drops:
        da = 1.0 - smoothstep(-aa, aa * 2.0, math.hypot(x - cx, y - cy) - rad)
        px = over(px, (124, 11, 14), da * 0.88)
    return px


def sh_muzzle(x, y, aa):
    """黄白枪口焰: 五角星芒 + 十道细芒 + 高亮核心 + 橙色辉光, 透明背景。"""
    r = math.hypot(x, y)
    th = math.atan2(y, x)
    R = (0.110 + 0.260 * max(0.0, math.cos(5 * th + 0.15)) ** 5
         + 0.090 * max(0.0, math.cos(10 * th + 0.4)) ** 10)
    glow = 0.40 * math.exp(-((r / 0.225) ** 2))
    px = over((0.0, 0.0, 0.0, 0.0), (255, 112, 24), glow)
    col = mix((255, 128, 26), (255, 214, 82), 1.0 - smoothstep(0.10, 0.30, r))
    col = mix(col, (255, 252, 222), 1.0 - smoothstep(0.02, 0.12, r))
    a = 1.0 - smoothstep(-0.012, 0.012, r - R)
    px = over(px, col, a)
    px = over(px, (255, 255, 238), 1.0 - smoothstep(0.010, 0.085, r))
    return over(px, (255, 255, 255), 1.0 - smoothstep(0.0, 0.035, r))


def sh_kill_default(x, y, aa):
    """击杀图标-默认: 黄色步枪剪影 + 白色高光 + 红色枪口火花。"""
    parts = [
        sd_box(x, y, 0.150, -0.100, 0.270, 0.032),        # 枪管
        sd_box(x, y, -0.020, -0.010, 0.145, 0.085),      # 机匣
        sd_box(x, y, -0.270, 0.035, 0.120, 0.055, -0.18),  # 枪托
        sd_box(x, y, 0.020, 0.150, 0.045, 0.115, 0.22),   # 弹匣
        sd_box(x, y, -0.100, 0.130, 0.032, 0.085, 0.28),  # 握把
        sd_box(x, y, 0.310, -0.160, 0.012, 0.045),        # 准星
    ]
    px = shape((0.0, 0.0, 0.0, 0.0), min(parts), YELLOW, aa, 0.016)
    px = over(px, WHITE, ink(sd_seg(x, y, -0.10, -0.125, 0.40, -0.125) - 0.007, aa) * 0.9)
    px = over(px, WHITE, ink(sd_box(x, y, -0.02, -0.048, 0.085, 0.010), aa) * 0.85)
    px = over(px, RED, ink(math.hypot(x - 0.435, y + 0.100) - 0.030, aa))
    return over(px, YELLOW, ink(sd_ring(x, y, 0.435, -0.100, 0.052, 0.008), aa))


def sh_kill_headshot(x, y, aa):
    """击杀图标-爆头: 白色头部剪影 + 红色命中点 + 黄色准星环。"""
    head = sd_ellipse(x, y, -0.020, -0.020, 0.215, 0.255)
    neck = sd_box(x, y, -0.020, 0.235, 0.090, 0.075)
    shoulder = sd_ellipse(x, y, 0.000, 0.420, 0.330, 0.140)
    px = shape((0.0, 0.0, 0.0, 0.0), min(head, neck, shoulder), WHITE, aa, 0.018)
    px = over(px, (212, 214, 208), ink(sd_ellipse(x, y, -0.13, -0.10, 0.055, 0.09), aa) * 0.5)
    # 命中点与十字线
    px = over(px, RED, ink(math.hypot(x - 0.075, y + 0.045) - 0.058, aa))
    px = over(px, YELLOW, ink(sd_ring(x, y, 0.075, -0.045, 0.082, 0.011), aa))
    for a1, b1, a2, b2 in [(0.075, -0.235, 0.075, -0.145),
                           (0.075, 0.055, 0.075, 0.145),
                           (-0.120, -0.045, -0.010, -0.045),
                           (0.160, -0.045, 0.270, -0.045)]:
        px = over(px, YELLOW, ink(sd_seg(x, y, a1, b1, a2, b2) - 0.010, aa))
    return px


def sh_kill_knife(x, y, aa):
    """击杀图标-刀杀: 银白刀身 + 黄色刀柄 + 红色血滴。"""
    ang = -math.pi / 4.0
    c, s = math.cos(-ang), math.sin(-ang)
    X, Y = x * c - y * s, x * s + y * c
    t = clamp((X - 0.020) / 0.480)
    w = 0.075 * (1.0 - t ** 1.3)
    d_blade = max(0.020 - X, X - 0.500, abs(Y) - w)
    d_handle = _box_raw(X, Y, -0.140, 0.0, 0.160, 0.055)
    d_guard = _box_raw(X, Y, 0.020, 0.0, 0.016, 0.105)
    px = shape((0.0, 0.0, 0.0, 0.0), d_blade, (236, 240, 244), aa, 0.014)
    px = shape(px, d_handle, (206, 154, 58), aa, 0.013)
    px = shape(px, d_guard, YELLOW, aa, 0.010)
    # 刀刃高光与柄部铆钉
    px = over(px, WHITE, ink(sd_seg(x, y, 0.02, -0.02, 0.36, -0.36) - 0.008, aa) * 0.75)
    # 刀柄铆钉: 局部坐标 (hx, 0) 反旋转回屏幕坐标
    for hx in (-0.21, -0.09):
        sx, sy = hx * c, -hx * s
        px = over(px, DARK, ink(math.hypot(x - sx, y - sy) - 0.013, aa) * 0.8)
    px = over(px, RED, ink(math.hypot(x - 0.395, y + 0.395) - 0.030, aa))
    return px


def sh_kill_awp(x, y, aa):
    """击杀图标-AWP: 黄白狙击准星 (双环 + 密位刻度 + 红点)。"""
    px = (0.0, 0.0, 0.0, 0.0)
    outer = sd_ring(x, y, 0, 0, 0.310, 0.028)
    px = over(px, DARK, ink(outer - 0.014, aa))
    px = over(px, YELLOW, ink(outer, aa))
    inner = sd_ring(x, y, 0, 0, 0.165, 0.011)
    px = over(px, WHITE, ink(inner, aa))
    lines = [(0.0, -0.430, 0.0, -0.060), (0.0, 0.060, 0.0, 0.430),
             (-0.430, 0.0, -0.060, 0.0), (0.060, 0.0, 0.430, 0.0)]
    for a1, b1, a2, b2 in lines:
        px = over(px, DARK, ink(sd_seg(x, y, a1, b1, a2, b2) - 0.020, aa))
        px = over(px, WHITE, ink(sd_seg(x, y, a1, b1, a2, b2) - 0.010, aa))
    ticks = [(0.0, -0.250, 0.0, -0.185), (0.0, 0.185, 0.0, 0.250),
             (-0.250, 0.0, -0.185, 0.0), (0.185, 0.0, 0.250, 0.0)]
    for a1, b1, a2, b2 in ticks:
        px = over(px, YELLOW, ink(sd_seg(x, y, a1, b1, a2, b2) - 0.012, aa))
    return over(px, RED, ink(math.hypot(x, y) - 0.038, aa))


def sh_kill_grenade(x, y, aa):
    """击杀图标-手雷: 橄榄黄弹体 + 引信/拉环/保险杆 + 红色爆星。"""
    body = sd_ellipse(x, y, 0.010, 0.090, 0.205, 0.225)
    px = shape((0.0, 0.0, 0.0, 0.0), body, (166, 164, 62), aa, 0.016)
    for gy in (0.060, 0.120, 0.180):
        px = over(px, (236, 230, 150),
                  ink(sd_seg(x, y, -0.130, gy, 0.150, gy) - 0.008, aa) * 0.65)
    px = shape(px, sd_box(x, y, 0.010, -0.155, 0.095, 0.045), YELLOW, aa, 0.012)
    px = shape(px, sd_box(x, y, -0.155, -0.035, 0.028, 0.160, 0.18), (198, 190, 96), aa, 0.010)
    px = over(px, DARK, ink(sd_ring(x, y, 0.165, -0.215, 0.048, 0.013) - 0.008, aa))
    px = over(px, WHITE, ink(sd_ring(x, y, 0.165, -0.215, 0.048, 0.013), aa))
    # 右上角红色爆星
    sx, sy = 0.305, -0.300
    sr = math.hypot(x - sx, y - sy)
    sth = math.atan2(y - sy, x - sx)
    sr_max = 0.030 + 0.070 * max(0.0, math.cos(4 * sth)) ** 6
    return over(px, RED, 1.0 - smoothstep(-0.010, 0.010, sr - sr_max))


SPRITES = {
    # key: (文件名, 尺寸, 超采样倍数, 着色函数, 中文来源说明)
    "blood":         ("blood.png", 128, 2, sh_blood, "程序化: 暗红不规则血泊 + 卫星血滴, 柔边透明"),
    "muzzle":        ("muzzle.png", 128, 2, sh_muzzle, "程序化: 五角星芒 + 白黄核心 + 橙色辉光, 透明"),
    "kill_default":  ("kill_default.png", 48, 3, sh_kill_default, "程序化: 黄色步枪剪影图标"),
    "kill_headshot": ("kill_headshot.png", 48, 3, sh_kill_headshot, "程序化: 头部剪影 + 红色命中点"),
    "kill_knife":    ("kill_knife.png", 48, 3, sh_kill_knife, "程序化: 银白刀身 + 黄色刀柄"),
    "kill_awp":      ("kill_awp.png", 48, 3, sh_kill_awp, "程序化: 狙击准星 (双环 + 密位刻度)"),
    "kill_grenade":  ("kill_grenade.png", 48, 3, sh_kill_grenade, "程序化: 手雷 + 拉环 + 红色爆星"),
}


def render_sprite(size: int, ss: int, shader):
    """解析式距离场 + ss×ss 超采样 -> RGBA8 bytes。"""
    S = size * ss
    aa = 1.25 / S
    n = size * size
    acc_r, acc_g, acc_b, acc_a = [0.0] * n, [0.0] * n, [0.0] * n, [0.0] * n
    for j in range(S):
        y = (j + 0.5) / S - 0.5
        row = (j // ss) * size
        for i in range(S):
            x = (i + 0.5) / S - 0.5
            r, g, b, a = shader(x, y, aa)
            k = row + (i // ss)
            acc_r[k] += r * a
            acc_g[k] += g * a
            acc_b[k] += b * a
            acc_a[k] += a
    out = bytearray()
    for k in range(n):
        if acc_a[k] > 0.0:
            out += bytes((int(clamp(acc_r[k] / acc_a[k], 0, 255)),
                          int(clamp(acc_g[k] / acc_a[k], 0, 255)),
                          int(clamp(acc_b[k] / acc_a[k], 0, 255)),
                          int(clamp(acc_a[k] / (ss * ss), 0, 1) * 255)))
        else:
            out += b"\x00\x00\x00\x00"
    return bytes(out)


# ===========================================================================
# 四、de_dust2 俯视图
# ===========================================================================
def bake_overview():
    """优先原版 de_dust2.bmp -> 512x384 PNG; 缺失则用 radar_v2.png 缩放着色;
    两者都缺时生成一张沙色占位图, 保证产物一定存在。"""
    bmp = CS_OVERVIEWS / "de_dust2.bmp"
    tga = CS_OVERVIEWS / "de_dust2.tga"
    png = CS_OVERVIEWS / "de_dust2.png"
    src = None
    for p in (bmp, tga, png):
        if p.is_file():
            src = p
            break
    if src is not None and src.suffix.lower() == ".bmp":
        pixels, w, h = read_bmp_rgb(src)
        out = resize_box(key_out_green(pixels), w, h, 512, 384)
        note = ("原版 cstrike/overviews/%s (%dx%d) 转换为 512x384 PNG, "
                "并把地图外的纯绿底色替换为深色" % (src.name, w, h))
        ow, oh = 512, 384
    elif src is not None and src.suffix.lower() == ".png":
        pixels, w, h = read_png_rgb(src)
        out = resize_box(pixels, w, h, 512, 384)
        note = "原版 cstrike/overviews/%s 转换为 512x384 PNG" % src.name
        ow, oh = 512, 384
    elif RADAR_FALLBACK.is_file():
        pixels, w, h = read_png_rgb(RADAR_FALLBACK)
        oh = 512
        ow = max(1, min(512, round(w * 512.0 / h)))
        out = resize_box(pixels, w, h, ow, oh, tint=(1.10, 1.02, 0.82))
        note = "降级: 未找到原版俯视图, 用现有 radar_v2.png 缩放并沙色着色为 %dx%d" % (ow, oh)
    else:
        ow, oh = 512, 384
        out = []
        for j in range(oh):
            for i in range(ow):
                base = (196, 170, 120)
                if i % 64 == 0 or j % 64 == 0:
                    base = (168, 142, 98)
                for cx, cy in ((150, 110), (380, 290)):
                    d = math.hypot(i - cx, j - cy)
                    if d < 34:
                        base = (206, 66, 52) if d < 22 else (238, 206, 92)
                out.append(base)
        note = "降级: 原版俯视图与 radar_v2.png 均缺失, 生成沙色网格占位图 512x384"
    write_png(OUT_OVERVIEWS / "dust2.png", ow, oh, rgb_to_rgba_bytes(out))
    return note, (ow, oh)


# ===========================================================================
# 五、manifest + 自检 + 主流程
# ===========================================================================
def build_manifest(origins, overview_note, overview_size):
    sfx = {k: "assets/sfx/%s.wav" % k for k in SFX_ORDER}
    sprites = {k: "assets/sprites/%s" % v[0] for k, v in SPRITES.items()}
    direct = [k for k in SFX_ORDER if k in DIRECT_SFX and "原版复制" in origins[k]]
    synth = [k for k in SFX_ORDER if k not in direct]
    lines = [
        "由 hlsrc/bake_extra.py 烘焙的额外静态资产; 只新增文件, 不改动 web/、serve.py 与原有 assets/ 内容。",
        "音效共 %d 个, 全部为可直接被 wave.open() 解码的标准 PCM mono wav:" % len(SFX_ORDER),
        "  A. 原版直接复制 %d 个 (%s): 来自 cstrike/sound/ 下的 player/pl_shell1~3、radio/ct_enemys、"
        "radio/ct_backup、player/pl_step1、pl_metal1、pl_tile1、weapons/c4_disarmed; "
        "保持原版 8bit PCM / 采样率 (多为 22050Hz, 脚步为 11025Hz)。" % (len(direct), ", ".join(direct)),
        "  B. 标准库合成 %d 个 (%s): 全部由既有 assets/sfx/*.wav 经一阶低通、"
        "线性变调、增益、截断淡出、短延迟空腔、拼接生成; 输出 16bit PCM mono, "
        "采样率 22050Hz (step_wood 保持来源 11025Hz)。" % (len(synth), ", ".join(synth)),
        "  说明: 原版 weapons/usp1.wav 与 weapons/m4a1-1.wav 本身即消音射击声, "
        "但已被既有 fire_usp.wav / fire_m4a1.wav 占用, 故两个 *_sil 采用二次闷化合成版本以听感区分; "
        "CS 1.5 无独立木头脚步/木头跳弹/blood/回合开始采样, 这些按上述方式补齐。",
        "贴图共 %d 张 RGBA8 PNG (filter 0 或 Pillow 编码): blood/muzzle 为 128x128 透明柔边贴花, "
        "5 个 kill_* 图标为 48x48 透明底, 配色用 CS 黄白红; 全部由解析式距离场 + 超采样程序化绘制, "
        "未取用原版 .spr (其私有调色板格式不适合直接当网页贴图)。" % len(SPRITES),
        "俯视图: %s; 尺寸 %dx%d, 不超过 512x512。" % (overview_note, overview_size[0], overview_size[1]),
        "图片解码/编码优先使用 Pillow (若已安装), 否则自动降级为纯 zlib+struct 的 PNG 编码器与 BMP/PNG 解析器; 无需安装依赖。",
        "逐资源来源: " + "; ".join("%s=%s" % (k, origins[k]) for k in SFX_ORDER),
        "贴图来源: " + "; ".join("%s=%s" % (k, v[4]) for k, v in SPRITES.items()),
    ]
    return {
        "generated_by": "hlsrc/bake_extra.py",
        "sfx": sfx,
        "sprites": sprites,
        "overviews": {"dust2": "assets/overviews/dust2.png"},
        "notes": "\n".join(lines),
    }


def verify_outputs():
    """自检: 每个 wav 能 wave.open() 且非空; 每个 PNG 头 8 字节为签名且 IHDR 合法。"""
    for key in SFX_ORDER:
        p = OUT_SFX / ("%s.wav" % key)
        if not p.is_file() or p.stat().st_size == 0:
            raise RuntimeError("音效缺失或为空: %s" % p)
        with wave.open(str(p), "rb") as w:
            if w.getnframes() <= 0 or w.getcomptype() != "NONE":
                raise RuntimeError("wav 无法解码: %s" % p)
    pngs = [OUT_SPRITES / v[0] for v in SPRITES.values()]
    pngs.append(OUT_OVERVIEWS / "dust2.png")
    for p in pngs:
        d = p.read_bytes()
        if len(d) < 33 or d[:8] != PNG_SIG or d[12:16] != b"IHDR":
            raise RuntimeError("PNG 签名/IHDR 非法: %s" % p)
        w, h, bd, ct = struct.unpack_from(">IIBB", d, 16)
        if not (0 < w <= 512 and 0 < h <= 512 and bd == 8 and ct in (2, 6)):
            raise RuntimeError("PNG 尺寸/格式非法: %s %dx%d bd=%d ct=%d" % (p, w, h, bd, ct))
    if not MANIFEST.is_file():
        raise RuntimeError("manifest 缺失: %s" % MANIFEST)
    json.loads(MANIFEST.read_text(encoding="utf-8"))


def main():
    for d in (OUT_SFX, OUT_SPRITES, OUT_OVERVIEWS):
        d.mkdir(parents=True, exist_ok=True)

    origins = {}
    print("[sfx] 输出目录: %s" % OUT_SFX)
    for key in SFX_ORDER:
        dst = OUT_SFX / ("%s.wav" % key)
        if key in DIRECT_SFX:
            rel, desc, fallback = DIRECT_SFX[key]
            src = CS_SOUND / rel
            if is_pcm_wav(src):
                # 直接复制字节: 保留原版 8bit PCM 与原始采样率
                dst.write_bytes(src.read_bytes())
                origins[key] = "原版复制 cstrike/sound/%s (%s)" % (rel, desc)
            else:
                s, sr = variant_from_existing(key, fallback)
                write_wav(dst, s, sr)
                origins[key] = ("降级合成 (原版 %s 缺失): 既有 %s 低通/变调/截短" % (rel, fallback))
        else:
            make, note = SYNTH_SFX[key]
            s, sr = make()
            write_wav(dst, s, sr)
            origins[key] = note
        with wave.open(str(dst), "rb") as w:
            print("  %-18s %7d B  %5dHz %dbit  %-6s  <- %s"
                  % (dst.name, dst.stat().st_size, w.getframerate(),
                     w.getsampwidth() * 8, w.getnchannels() == 1 and "mono" or "stereo",
                     origins[key]))

    print("[sprites] 输出目录: %s" % OUT_SPRITES)
    for key, (fname, size, ss, shader, desc) in SPRITES.items():
        p = OUT_SPRITES / fname
        write_png(p, size, size, render_sprite(size, ss, shader))
        print("  %-22s %7d B  %dx%d RGBA8  <- %s" % (p.name, p.stat().st_size, size, size, desc))

    print("[overviews] 输出目录: %s" % OUT_OVERVIEWS)
    overview_note, overview_size = bake_overview()
    p = OUT_OVERVIEWS / "dust2.png"
    print("  %-22s %7d B  %dx%d       <- %s"
          % (p.name, p.stat().st_size, overview_size[0], overview_size[1], overview_note))

    MANIFEST.write_text(
        json.dumps(build_manifest(origins, overview_note, overview_size),
                   ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8")
    print("  %-22s %7d B" % (MANIFEST.name, MANIFEST.stat().st_size))

    verify_outputs()
    print("done: %d wav + %d sprites + 1 overview + manifest, 自检通过 (Pillow=%s)"
          % (len(SFX_ORDER), len(SPRITES), Image is not None))


if __name__ == "__main__":
    main()
