"""从原版 CS 1.5 安装目录提取真实音效, 复制到项目根目录并改名 sfx_<key>.wav"""
import os
import shutil
from pathlib import Path

CS = Path(r"C:\GTGame\cs反恐精英1.5\cstrike\sound")
DST = Path(__file__).resolve().parent.parent

# key -> (相对 sound 目录的路径, 备选列表)
MAP = {
    'shot':   ['weapons/ak47-1.wav', 'weapons/m4a1-1.wav'],
    'awp':    ['weapons/awp1.wav'],
    'hit':    ['player/bhit_flesh-1.wav'],
    'head':   ['player/headshot1.wav'],
    'kill':   ['player/headshot2.wav'],
    'reload': ['weapons/ak47_clipin.wav', 'weapons/clipin1.wav'],
    'hurt':   ['player/pl_pain2.wav', 'player/pl_pain4.wav'],
    'empty':  ['weapons/357_cock1.wav'],
    'buy':    ['items/gunpickup2.wav'],
    'win':    ['radio/ctwin.wav', 'radio/terwin.wav'],
    'lose':   ['radio/rounddraw.wav', 'radio/ct_fireinhole.wav'],
    'footstep': ['player/pl_step1.wav'],
    'knife':  ['weapons/knife_slash1.wav', 'weapons/knife_hit1.wav'],
    'explode': ['weapons/c4_explode1.wav'],
    'flash':  ['weapons/flashbang-1.wav', 'weapons/flashbang-2.wav'],
    'pin':    ['weapons/c4_click.wav'],
    'c4_beep': ['weapons/c4_beep1.wav'],
    'c4_plant': ['weapons/c4_plant.wav'],
    'c4_defuse': ['weapons/c4_disarm.wav'],
    'radio':  ['radio/ct_affirm.wav', 'radio/go.wav'],
    'deploy': ['weapons/ak47_boltpull.wav'],
}


def main():
    ok, miss = [], []
    for key, cands in MAP.items():
        src = None
        for c in cands:
            p = CS / c
            if p.exists():
                src = p
                break
        if src is None:
            miss.append((key, cands))
            continue
        dst = DST / ('sfx_%s.wav' % key)
        shutil.copyfile(src, dst)
        ok.append((key, src.name, dst.stat().st_size))
    for k, n, s in ok:
        print('  %-10s <- %-26s %6d B' % (k, n, s))
    for k, c in miss:
        print('  [miss] %-10s %s' % (k, c))
    (DST / 'sfx.ver').write_text('hl2', encoding='utf-8')
    print('done', len(ok), 'ok', len(miss), 'miss')


if __name__ == '__main__':
    main()
