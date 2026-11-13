"""从原版 CS 1.5 安装目录提取真实音效, 输出到 assets/sfx/<key>.wav。

历史: 早期版本把 64 个 wav 直接倒在项目根目录, 和入口脚本 serve.py、
radar_v2.png 混在一起, 既难浏览也容易误改。现在统一收进 assets/sfx/,
文件名也不再带 sfx_ 前缀 (目录名已经表达了)。
"""
import os
import shutil
from pathlib import Path

CS = Path(r"C:\GTGame\cs反恐精英1.5\cstrike\sound")
DST = Path(__file__).resolve().parent.parent / 'assets' / 'sfx'

# key -> (相对 sound 目录的路径, 备选列表)
MAP = {
    'hit':    ['player/bhit_flesh-1.wav'],
    'head':   ['player/headshot1.wav'],
    'kill':   ['player/headshot2.wav'],
    'reload': ['weapons/ak47_clipin.wav', 'weapons/clipin1.wav'],
    'hurt':   ['player/pl_pain2.wav', 'player/pl_pain4.wav'],
    'empty':  ['weapons/357_cock1.wav'],
    'buy':    ['items/gunpickup2.wav'],
    'win':    ['radio/ctwin.wav', 'radio/terwin.wav'],
    'lose':   ['radio/rounddraw.wav', 'radio/ct_fireinhole.wav'],
    # CS 1.5 的脚步声只有 4 个通用采样 (pl_step1..4), 按随机顺序轮播。
    # 材质区分是 1.6 才引入的, 这个版本里没有对应素材。
    'footstep1': ['player/pl_step1.wav'],
    'footstep2': ['player/pl_step2.wav'],
    'footstep3': ['player/pl_step3.wav'],
    'footstep4': ['player/pl_step4.wav'],
    'knife':  ['weapons/knife_slash1.wav', 'weapons/knife_hit1.wav'],
    'explode': ['weapons/c4_explode1.wav'],
    'flash':  ['weapons/flashbang-1.wav', 'weapons/flashbang-2.wav'],
    'pin':    ['weapons/c4_click.wav'],
    'c4_beep': ['weapons/c4_beep1.wav'],
    'c4_plant': ['weapons/c4_plant.wav'],
    'c4_defuse': ['weapons/c4_disarm.wav'],
    'radio':  ['radio/ct_affirm.wav', 'radio/go.wav'],
    'deploy': ['weapons/ak47_boltpull.wav'],
    # ---- 每把武器自己的开火 / 换弹 / 部署音 ----
    # CS 1.5 里 AK 与 M4 是两套完全不同的枪声, 混用会听不出手里拿的是哪把。
    'fire_glock18':   ['weapons/glock18-1.wav'],
    'fire_usp':       ['weapons/usp1.wav'],
    'fire_p228':      ['weapons/p228-1.wav'],
    'fire_deagle':    ['weapons/deagle-1.wav'],
    'fire_elite':     ['weapons/elite_fire.wav'],
    'fire_fiveseven': ['weapons/fiveseven-1.wav'],
    'fire_m3':        ['weapons/m3-1.wav'],
    'fire_xm1014':    ['weapons/xm1014-1.wav'],
    'fire_tmp':       ['weapons/tmp-1.wav'],
    'fire_mac10':     ['weapons/mac10-1.wav'],
    'fire_mp5':       ['weapons/mp5-1.wav'],
    'fire_ump45':     ['weapons/ump45-1.wav'],
    'fire_p90':       ['weapons/p90-1.wav'],
    'fire_ak47':      ['weapons/ak47-1.wav'],
    'fire_m4a1':      ['weapons/m4a1-1.wav'],
    'fire_sg552':     ['weapons/sg552-1.wav'],
    'fire_aug':       ['weapons/aug-1.wav'],
    'fire_scout':     ['weapons/scout_fire-1.wav'],
    'fire_awp':       ['weapons/awp1.wav'],
    'fire_g3sg1':     ['weapons/g3sg1-1.wav'],
    'fire_sg550':     ['weapons/sg550-1.wav'],
    'fire_m249':      ['weapons/m249-1.wav'],
    'reload_pistol':  ['weapons/clipin1.wav', 'weapons/usp_clipin.wav'],
    'reload_rifle':   ['weapons/ak47_clipin.wav', 'weapons/m4a1_clipin.wav'],
    'reload_shotgun': ['weapons/m3_insertshell.wav'],
    'reload_smg':     ['weapons/mp5_clipin.wav', 'weapons/clipin1.wav'],
    'reload_sniper':  ['weapons/awp_clipin.wav', 'weapons/scout_clipin.wav'],
    'reload_m249':    ['weapons/m249_boxin.wav'],
    # 弹壳落地 / 击中不同材质
    'ric1':   ['weapons/ric1.wav'],
    'ric2':   ['weapons/ric2.wav'],
    'ric_metal': ['weapons/ric_metal-1.wav'],
    'ric_conc':  ['weapons/ric_conc-1.wav'],
    'bullet_hit': ['weapons/bullet_hit1.wav', 'weapons/bullet_hit2.wav'],
    'dryfire_pistol': ['weapons/dryfire_pistol.wav'],
    'dryfire_rifle':  ['weapons/dryfire_rifle.wav'],
    'zoom':   ['weapons/zoom.wav'],
    'knife_stab': ['weapons/knife_stab.wav'],
    'knife_hitwall': ['weapons/knife_hitwall1.wav'],
    'he_bounce': ['weapons/he_bounce-1.wav'],
    'grenade_hit': ['weapons/grenade_hit1.wav'],
    'hegrenade': ['weapons/hegrenade-1.wav'],
}


def main():
    DST.mkdir(parents=True, exist_ok=True)
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
        dst = DST / ('%s.wav' % key)
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
