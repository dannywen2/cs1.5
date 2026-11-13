// web/asset.js
// CS 1.5 three.js 移植版 —— 烘焙资产 / 碰撞 / 导航层
// 所有二进制资产都在浏览器里用 fetch + DataView 解析, 不重新烘焙。
import * as THREE from './vendor/three.module.js';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
export const CELL = 16;
export const NAV_WX0 = -2816;
export const NAV_WY0 = -1664;
export const W = 304;
export const H = 350;
export const EYE_HEIGHT = 64;
export const PLAYER_HALF = 16;
export const STEP_HEIGHT = 18;
export const GRAVITY = 800;
export const JUMP_SPEED = 268;
export const RUN_SPEED = 250;
export const WALK_SPEED = 133;
export const CROUCH_SPEED = 130;
export const LIGHT_GAIN = 2.35;
export const AMBIENT = 0.13;
export const BULLET_RANGE = 2400;
export const MELEE_RANGE = 64;
export const BOT_RANGE = 900;
export const PLANT_RADIUS = 128;
export const PLANT_TIME = 3;
export const C4_TIME = 35;
export const ROUND_TIME = 105;
export const DEFUSE_TIME = 10;
export const KIT_DEFUSE_TIME = 5;
export const DEFUSE_RANGE = 56;
export const BASE_FOV = 90;

// hull1 相对于原始 brush 的外扩量 (GoldSrc hull1 是 32x32x72 玩家盒 -> 每侧 16,
// 上下各 36)。导出的 brush 包围盒是原始盒, 点测试前必须按这个量放大。
export const HULL1_PAD = 36;

// ---------------------------------------------------------------------------
// CS 1.5 武器表
//
// 数值取自 CS 1.5 / 1.6 的 weapon_*.cpp 硬编码值 (两者武器数值一致, 1.6 只是
// 加了 galil/famas 并调了少数价格)。字段说明:
//   dmg        基础伤害 (未计部位倍率与护甲)
//   pellets    每次射击弹丸数 (霰弹枪 > 1)
//   interval   射击间隔秒 (60/rpm)
//   clip/reserve  弹匣容量 / 备弹
//   spread     腰射基础散布 (弧度)
//   recoil     每发上抬的后坐 (度)
//   armor_ratio 有甲时伤害保留比例 (0.5 = 护甲吸收一半)
//   range_mod  远距离伤害衰减系数 (每单位距离)
//   team       't' | 'ct' | null (null = 双方都能买)
//   slot       1=主武器 2=手枪 3=刀
//   price      购买价; kill_reward 击杀奖励
// ---------------------------------------------------------------------------
export const WEAPONS = {
  // ---------------- 近战 ----------------
  knife: {
    name: '匕首', dmg: 55, pellets: 1, interval: 0.45, clip_size: null, reserve: null,
    spread: 0, recoil: 0.5, armor_ratio: 0.5, range_mod: 1, price: 0, kill_reward: 1500,
    melee: true, auto: false, slot: 3, team: null, sfx: 'knife', reload_sfx: null, kind: 'knife',
  },

  // ---------------- 手枪 ----------------
  glock18: {
    name: 'Glock-18', dmg: 25, pellets: 1, interval: 0.15, clip_size: 20, reserve: 120,
    spread: 0.013, recoil: 0.9, armor_ratio: 0.5, range_mod: 0.99, price: 400, kill_reward: 300,
    melee: false, auto: true, slot: 2, team: 't', sfx: 'fire_glock18', reload_sfx: 'reload_pistol', kind: 'pistol',
  },
  usp: {
    name: 'USP', dmg: 34, pellets: 1, interval: 0.15, clip_size: 12, reserve: 100,
    spread: 0.010, recoil: 1.0, armor_ratio: 0.5, range_mod: 0.99, price: 500, kill_reward: 300,
    melee: false, auto: false, slot: 2, team: 'ct', sfx: 'fire_usp', reload_sfx: 'reload_pistol', kind: 'pistol',
  },
  p228: {
    name: 'P228', dmg: 32, pellets: 1, interval: 0.15, clip_size: 13, reserve: 52,
    spread: 0.011, recoil: 1.0, armor_ratio: 0.5, range_mod: 0.99, price: 600, kill_reward: 300,
    melee: false, auto: false, slot: 2, team: null, sfx: 'fire_p228', reload_sfx: 'reload_pistol', kind: 'pistol',
  },
  deagle: {
    name: 'Desert Eagle', dmg: 53, pellets: 1, interval: 0.30, clip_size: 7, reserve: 35,
    spread: 0.012, recoil: 2.2, armor_ratio: 0.5, range_mod: 0.98, price: 650, kill_reward: 300,
    melee: false, auto: false, slot: 2, team: null, sfx: 'fire_deagle', reload_sfx: 'reload_pistol', kind: 'pistol',
  },
  elite: {
    name: '双 Beretta', dmg: 38, pellets: 1, interval: 0.10, clip_size: 15, reserve: 120,
    spread: 0.013, recoil: 1.0, armor_ratio: 0.5, range_mod: 0.99, price: 1000, kill_reward: 300,
    melee: false, auto: false, slot: 2, team: 't', sfx: 'fire_elite', reload_sfx: 'reload_pistol', kind: 'pistol',
  },
  fiveseven: {
    name: 'Five-SeveN', dmg: 27, pellets: 1, interval: 0.15, clip_size: 20, reserve: 100,
    spread: 0.011, recoil: 0.9, armor_ratio: 0.5, range_mod: 0.99, price: 750, kill_reward: 300,
    melee: false, auto: false, slot: 2, team: 'ct', sfx: 'fire_fiveseven', reload_sfx: 'reload_pistol', kind: 'pistol',
  },

  // ---------------- 霰弹枪 ----------------
  m3: {
    name: 'M3 Super90', dmg: 24, pellets: 9, interval: 0.85, clip_size: 8, reserve: 32,
    spread: 0.045, recoil: 3.0, armor_ratio: 0.5, range_mod: 0.90, price: 1700, kill_reward: 900,
    melee: false, auto: false, slot: 1, team: null, sfx: 'fire_m3', reload_sfx: 'reload_shotgun', kind: 'shotgun',
  },
  xm1014: {
    name: 'XM1014', dmg: 20, pellets: 6, interval: 0.30, clip_size: 7, reserve: 32,
    spread: 0.050, recoil: 2.6, armor_ratio: 0.5, range_mod: 0.88, price: 3000, kill_reward: 900,
    melee: false, auto: true, slot: 1, team: null, sfx: 'fire_xm1014', reload_sfx: 'reload_shotgun', kind: 'shotgun',
  },

  // ---------------- 冲锋枪 ----------------
  tmp: {
    name: 'TMP', dmg: 20, pellets: 1, interval: 0.07, clip_size: 30, reserve: 120,
    spread: 0.018, recoil: 1.0, armor_ratio: 0.6, range_mod: 0.95, price: 1250, kill_reward: 600,
    melee: false, auto: true, slot: 1, team: 'ct', sfx: 'fire_tmp', reload_sfx: 'reload_smg', kind: 'smg',
  },
  mac10: {
    name: 'MAC-10', dmg: 29, pellets: 1, interval: 0.07, clip_size: 30, reserve: 100,
    spread: 0.020, recoil: 1.2, armor_ratio: 0.6, range_mod: 0.94, price: 1400, kill_reward: 600,
    melee: false, auto: true, slot: 1, team: 't', sfx: 'fire_mac10', reload_sfx: 'reload_smg', kind: 'smg',
  },
  mp5: {
    name: 'MP5 Navy', dmg: 27, pellets: 1, interval: 0.08, clip_size: 30, reserve: 120,
    spread: 0.017, recoil: 1.1, armor_ratio: 0.6, range_mod: 0.96, price: 1500, kill_reward: 600,
    melee: false, auto: true, slot: 1, team: null, sfx: 'fire_mp5', reload_sfx: 'reload_smg', kind: 'smg',
  },
  ump45: {
    name: 'UMP45', dmg: 30, pellets: 1, interval: 0.09, clip_size: 25, reserve: 100,
    spread: 0.017, recoil: 1.2, armor_ratio: 0.6, range_mod: 0.96, price: 1700, kill_reward: 600,
    melee: false, auto: true, slot: 1, team: null, sfx: 'fire_ump45', reload_sfx: 'reload_smg', kind: 'smg',
  },
  p90: {
    name: 'P90', dmg: 21, pellets: 1, interval: 0.07, clip_size: 50, reserve: 100,
    spread: 0.016, recoil: 1.0, armor_ratio: 0.6, range_mod: 0.95, price: 2750, kill_reward: 600,
    melee: false, auto: true, slot: 1, team: null, sfx: 'fire_p90', reload_sfx: 'reload_smg', kind: 'smg',
  },

  // ---------------- 步枪 ----------------
  ak47: {
    name: 'AK-47', dmg: 36, pellets: 1, interval: 0.095, clip_size: 30, reserve: 90,
    spread: 0.016, recoil: 1.7, armor_ratio: 0.775, range_mod: 0.98, price: 2500, kill_reward: 300,
    melee: false, auto: true, slot: 1, team: 't', sfx: 'fire_ak47', reload_sfx: 'reload_rifle', kind: 'rifle',
  },
  m4a1: {
    name: 'M4A1', dmg: 33, pellets: 1, interval: 0.087, clip_size: 30, reserve: 90,
    spread: 0.015, recoil: 1.4, armor_ratio: 0.7, range_mod: 0.97, price: 3100, kill_reward: 300,
    melee: false, auto: true, slot: 1, team: 'ct', sfx: 'fire_m4a1', reload_sfx: 'reload_rifle', kind: 'rifle',
  },
  sg552: {
    name: 'SG552 Commando', dmg: 33, pellets: 1, interval: 0.087, clip_size: 30, reserve: 90,
    spread: 0.016, recoil: 1.5, armor_ratio: 0.7, range_mod: 0.97, price: 3500, kill_reward: 300,
    melee: false, auto: true, slot: 1, team: 't', sfx: 'fire_sg552', reload_sfx: 'reload_rifle', kind: 'rifle', zoom: true,
  },
  aug: {
    name: 'AUG', dmg: 32, pellets: 1, interval: 0.087, clip_size: 30, reserve: 90,
    spread: 0.015, recoil: 1.4, armor_ratio: 0.7, range_mod: 0.97, price: 3500, kill_reward: 300,
    melee: false, auto: true, slot: 1, team: 'ct', sfx: 'fire_aug', reload_sfx: 'reload_rifle', kind: 'rifle', zoom: true,
  },

  // ---------------- 狙击枪 ----------------
  scout: {
    name: 'Steyr Scout', dmg: 75, pellets: 1, interval: 0.65, clip_size: 10, reserve: 90,
    spread: 0.001, recoil: 2.5, armor_ratio: 0.6, range_mod: 0.98, price: 2750, kill_reward: 300,
    melee: false, auto: false, slot: 1, team: null, sfx: 'fire_scout', reload_sfx: 'reload_sniper', kind: 'sniper', zoom: true,
  },
  awp: {
    name: 'AWP', dmg: 115, pellets: 1, interval: 1.45, clip_size: 10, reserve: 30,
    spread: 0.001, recoil: 3.5, armor_ratio: 0.7, range_mod: 0.99, price: 4750, kill_reward: 100,
    melee: false, auto: false, slot: 1, team: null, sfx: 'fire_awp', reload_sfx: 'reload_sniper', kind: 'sniper', zoom: true,
  },
  g3sg1: {
    name: 'G3SG1', dmg: 80, pellets: 1, interval: 0.40, clip_size: 20, reserve: 90,
    spread: 0.002, recoil: 2.6, armor_ratio: 0.7, range_mod: 0.98, price: 5000, kill_reward: 300,
    melee: false, auto: false, slot: 1, team: 't', sfx: 'fire_g3sg1', reload_sfx: 'reload_sniper', kind: 'sniper', zoom: true,
  },
  sg550: {
    name: 'SG550', dmg: 70, pellets: 1, interval: 0.40, clip_size: 20, reserve: 90,
    spread: 0.002, recoil: 2.4, armor_ratio: 0.7, range_mod: 0.98, price: 4200, kill_reward: 300,
    melee: false, auto: false, slot: 1, team: 'ct', sfx: 'fire_sg550', reload_sfx: 'reload_sniper', kind: 'sniper', zoom: true,
  },

  // ---------------- 机枪 ----------------
  m249: {
    name: 'M249', dmg: 32, pellets: 1, interval: 0.08, clip_size: 100, reserve: 200,
    spread: 0.020, recoil: 1.6, armor_ratio: 0.7, range_mod: 0.97, price: 5750, kill_reward: 300,
    melee: false, auto: true, slot: 1, team: null, sfx: 'fire_m249', reload_sfx: 'reload_m249', kind: 'mg',
  },
};

// 部位伤害倍率 (CS 1.5 hitbox): 头 4x, 胸腹 1x, 手臂 0.5x, 腿 0.75x
export const HITBOX_MULT = { head: 4.0, chest: 1.0, stomach: 1.25, arm: 0.5, leg: 0.75 };

// 每把武器对应的第一人称枪模摆放 (位置/旋转/缩放), 与 bake_vm.py 的规范基配合。
// 枪身越长 z 越小 (更靠前), 手枪贴近相机。
// ---------------------------------------------------------------------------
// 第一人称枪模摆放
//
// 旧实现给每把枪手工写死 scale / 位置, 但原版模型的包围盒差异极大
// (p228 尺寸 6.3, sg550 是 36.8, 差近 6 倍), 手调必然不一致 ——
// 实测屏幕上占地从 25% 到 336% 都有, 有的枪整个怼在脸上, 有的小得看不清。
//
// 现在按类别给出"目标屏幕高度", 运行时用模型包围盒反算缩放与位置
// (见 engine.js placeViewmodel), 保证同类别武器的观感一致。
//   heightPct  目标占屏幕高度的比例
//   right/toCam 枪身在屏幕右下方偏移量 (相机空间)
// ---------------------------------------------------------------------------
export const VM_TUNE = {
  // right/down: 枪身在屏幕上的落点。目标是让枪托落在右下角、枪口指向
  //             画面中心偏右上方 —— 这是 CS 1.5 第一人称的典型构图。
  // heightPct:  目标屏幕高度占比
  // toCam:      距相机距离 (太近会透视畸变, 太远又显得"枪离得远")
  pistol:   { heightPct: 40, right: 0.30, down: -0.34, toCam: 0.86, rot: [0, -8, 8] },
  smg:      { heightPct: 38, right: 0.30, down: -0.32, toCam: 0.90, rot: [-4, -9, 7] },
  rifle:    { heightPct: 38, right: 0.29, down: -0.32, toCam: 0.90, rot: [-6, -8, 7] },
  shotgun:  { heightPct: 39, right: 0.30, down: -0.33, toCam: 0.89, rot: [-5, -8, 7] },
  sniper:   { heightPct: 37, right: 0.29, down: -0.31, toCam: 0.92, rot: [-4, -8, 7] },
  mg:       { heightPct: 38, right: 0.29, down: -0.34, toCam: 0.90, rot: [-6, -8, 7] },
  knife:    { heightPct: 42, right: 0.34, down: -0.34, toCam: 0.82, rot: [0, -8, 7] },
};

// 逐武器缩放修正因子。
//
// 解析式只能按包围盒估算竖直跨度, 而原版每把枪的手指/枪托/弹匣形状差异
// 很大, 实测同一类别内偏差可达 2.4 倍 (AUG 只有目标的 21%, Glock 却超了
// 62%)。这里记录"实测屏幕占比 / 目标占比"的修正系数, 由一次全武器测量得出
// (measure 脚本), 让每把枪最终都落在 VM_TUNE 的目标高度上。
// 改动模型/旋转后需要重新测量并更新此表。
export const VM_FIT = {
  knife: 17.5200,
  glock18: 0.8951,
  usp: 1.6913,
  p228: 1.1986,
  deagle: 1.3630,
  elite: 0.8754,
  fiveseven: 1.2091,
  m3: 1.0100,
  xm1014: 1.3780,
  tmp: 1.6058,
  mac10: 1.4766,
  mp5: 1.3497,
  ump45: 1.2594,
  p90: 1.2902,
  ak47: 1.1289,
  m4a1: 1.8646,
  sg552: 1.3959,
  aug: 1.4977,
  scout: 1.7941,
  awp: 1.6284,
  g3sg1: 1.9673,
  sg550: 1.7850,
  m249: 1.3451,
};

export function vmLds(wid) {
  const wp = WEAPONS[wid];
  const kind = (wp && wp.kind) || "rifle";
  const base = VM_TUNE[kind] || VM_TUNE.rifle;
  const fit = VM_FIT[wid];
  if (!Number.isFinite(fit)) return base;
  return { ...base, fit };
}

// 兼容旧接口: 仍导出每把枪的显式值, 由 VM_TUNE 派生 (engine.js 已改用
// placeViewmodel 自动换算, 这里仅为外部/调试保留)
export const VM_SCALE = Object.fromEntries(
  Object.keys(WEAPONS).map(id => [id, 1 / Math.max(1, vmLds(id).toCam * 30)]));
export const VM_POS = Object.fromEntries(
  Object.keys(WEAPONS).map(id => {
    const t = vmLds(id);
    return [id, [t.right, t.down, t.toCam]];
  }));
export const VM_ROT = Object.fromEntries(
  Object.keys(WEAPONS).map(id => [id, vmLds(id).rot]));


export const VM_GAIN = 1.55;
export const PLAYER_MODELS = { t: ['leet', 'terror'], ct: ['sas', 'urban'] };

// bot 手上的枪: 按队伍与武器槽随机取, 全部来自烘焙好的 w_* 资源
export const BOT_WEAPONS = {
  t: ['w_glock18', 'w_deagle', 'w_mp5', 'w_ak47', 'w_sg552', 'w_awp'],
  ct: ['w_usp', 'w_p228', 'w_mp5', 'w_m4a1', 'w_aug', 'w_awp'],
};
// bot 随机携带的武器 id (与 WEAPONS 对应, 用于伤害判定)
export const BOT_ARSENAL = {
  t: ['glock18', 'deagle', 'mp5', 'ak47', 'sg552', 'awp'],
  ct: ['usp', 'p228', 'mp5', 'm4a1', 'aug', 'awp'],
};

// 天空盒六面, pos/rot 均为普通数组 (rot 单位为度)
export const SKY_KEYS = ['ft', 'bk', 'rt', 'lf', 'up', 'dn'];
export const SKY_FACES = (() => {
  const D = 2800;
  const table = {
    ft: { pos: [0, 0, -D], rot: [0, 0, 0] },
    bk: { pos: [0, 0, D], rot: [0, 180, 0] },
    rt: { pos: [D, 0, 0], rot: [0, -90, 0] },
    lf: { pos: [-D, 0, 0], rot: [0, 90, 0] },
    up: { pos: [0, D, 0], rot: [90, 0, 0] },
    dn: { pos: [0, -D, 0], rot: [-90, 0, 0] },
  };
  return SKY_KEYS.map(key => ({ key, pos: table[key].pos, rot: table[key].rot }));
})();

// 包点: 由 meta.sites 中心格 (248,258)/(80,272) 经 cellPos 换算;
// 高度取 nav 对应站立层 (A=96, B=0)
export const SITE_CELLS = { A: [248, 258], B: [80, 272] };
export const BOMB_SITES = {
  A: cellPos(SITE_CELLS.A[0], SITE_CELLS.A[1], 96),   // [1160, 96, 2472]
  B: cellPos(SITE_CELLS.B[0], SITE_CELLS.B[1], 0),    // [-1528, 0, 2696]
};

export const PLAYER_BASE_NAMES = ['leet', 'terror', 'sas', 'urban'];
export const PLAYER_MODEL_NAMES = ['leet', 'terror', 'sas', 'urban',
  'w_glock18', 'w_usp', 'w_p228', 'w_deagle', 'w_elite', 'w_fiveseven',
  'w_m3', 'w_xm1014', 'w_tmp', 'w_mac10', 'w_mp5', 'w_ump45', 'w_p90',
  'w_ak47', 'w_m4a1', 'w_sg552', 'w_aug', 'w_scout', 'w_awp', 'w_g3sg1',
  'w_sg550', 'w_m249', 'w_knife'];
export const VM_NAMES = Object.keys(VM_SCALE);
// assets/sfx/<key>.wav (见 hlsrc/bake_sound.py 的 MAP)
export const SFX_NAMES = [
  // 通用
    'reload',
    'knife',
  'hit', 'head', 'kill', 'hurt', 'empty', 'buy', 'win', 'lose', 'footstep',
  'explode', 'flash', 'pin', 'c4_beep', 'c4_plant', 'c4_defuse', 'radio', 'deploy',
  // 每把武器的开火音 (CS 1.5 原版, AK 与 M4 是两套完全不同的枪声)
  'fire_glock18', 'fire_usp', 'fire_p228', 'fire_deagle',
  'fire_elite', 'fire_fiveseven', 'fire_m3', 'fire_xm1014', 'fire_tmp', 'fire_mac10',
  'fire_mp5', 'fire_ump45', 'fire_p90', 'fire_ak47', 'fire_m4a1', 'fire_sg552',
  'fire_aug', 'fire_scout', 'fire_awp', 'fire_g3sg1', 'fire_sg550', 'fire_m249',
  // 换弹 / 材质 / 特殊
  'reload_pistol', 'reload_rifle', 'reload_shotgun', 'reload_smg', 'reload_sniper',
  'reload_m249', 'ric1', 'ric2', 'ric_metal', 'ric_conc', 'bullet_hit',
  'dryfire_pistol', 'dryfire_rifle', 'zoom', 'knife_stab', 'knife_hitwall',
  'he_bounce', 'grenade_hit', 'hegrenade',
];

// ---------------------------------------------------------------------------
// 模块内状态: 由 loadAll 一次性装入, 其余导出函数全部同步读取
// ---------------------------------------------------------------------------
const ROOT = '../';
const ASSET = '../assets/';
let navState = null;   // { nx, ny, wx0, wy0, cell, offs, heights }
let colState = null;   // hull1 clipnode 树
let hitState = null;   // hull0 渲染节点树
const MODEL_TEMPLATES = new Map();  // 'player/leet' -> { meta, groups: [typed arrays...] }
const ANIM_TEMPLATES = new Map();   // player 名 -> { clips }  (walk/run 逐帧顶点)
const nearCache = new Map();
const textureLoader = new THREE.TextureLoader();

// loadAll 结束后填充 (引用保持不变, 供其它模块直接导入)
export const playerSpawns = [];
export const playerYaws = [];
export const tSpawns = [];
export const tYaws = [];

const WORLD_TEX = { wrap: THREE.RepeatWrapping, mipmaps: true, anisotropy: 4 };
const MODEL_TEX = { wrap: THREE.ClampToEdgeWrapping, mipmaps: true, anisotropy: 1 };
const SKY_TEX = { wrap: THREE.ClampToEdgeWrapping, mipmaps: true, anisotropy: 4 };
const RADAR_TEX = { wrap: THREE.ClampToEdgeWrapping, mipmaps: false, anisotropy: 1 };

// ---------------------------------------------------------------------------
// 二进制解析
// ---------------------------------------------------------------------------

// dust2.nav: <i32 nx><i32 ny><f32 wx0><f32 wy0><f32 cell><u32 n> | n*u32 offs | <u32 m> | m*i16 heights
function parseNav(buffer) {
  const dv = new DataView(buffer);
  const nx = dv.getInt32(0, true);
  const ny = dv.getInt32(4, true);
  const wx0 = dv.getFloat32(8, true);
  const wy0 = dv.getFloat32(12, true);
  const cell = dv.getFloat32(16, true);
  const n = dv.getUint32(20, true);       // nx*ny + 1
  let p = 24;
  const offs = new Uint32Array(n);
  for (let i = 0; i < n; i++) offs[i] = dv.getUint32(p + i * 4, true);
  p += n * 4;
  const m = dv.getUint32(p, true);
  p += 4;
  const raw = new Int16Array(m);
  for (let i = 0; i < m; i++) raw[i] = dv.getInt16(p + i * 2, true);
  // 烘焙时自上而下扫描, 每格层高是降序; 逐格排成升序 (offs 长度不变, 可直接复用)
  const heights = new Int16Array(m);
  for (let i = 0; i < nx * ny; i++) {
    const s = offs[i], e = offs[i + 1];
    const slice = raw.slice(s, e);
    slice.sort();                          // Int16Array.sort 默认数值升序
    heights.set(slice, s);
  }
  // 每格最多几层: 决定 A* 状态键的位宽 (见 findPath)
  let maxLayers = 1;
  for (let i = 0; i < nx * ny; i++) {
    const n = offs[i + 1] - offs[i];
    if (n > maxLayers) maxLayers = n;
  }
  // A* 热路径索引: ncx/ncy 先 +1 再按 (nx+2) 步进, 边界外天然读到 0,
  // 省掉每次邻居查询的 4 次比较 (单次长距离寻路会查十余万次)。
  const PW = nx + 2;
  const countPad = new Uint8Array(PW * (ny + 2));
  for (let cy = 0; cy < ny; cy++) {
    for (let cx = 0; cx < nx; cx++) {
      const i = cy * nx + cx;
      countPad[(cy + 1) * PW + (cx + 1)] = offs[i + 1] - offs[i];
    }
  }
  if (nx !== W || ny !== H || cell !== CELL || wx0 !== NAV_WX0 || wy0 !== NAV_WY0) {
    console.warn('[asset] dust2.nav 尺寸/原点与导出常量不符, 按文件实际值索引', { nx, ny, wx0, wy0, cell });
  }
  return { nx, ny, wx0, wy0, cell, offs, heights, maxLayers, PW, countPad };
}

// dust2.col: <i32 head><i32 cnt> + cnt * <4 f32 平面, i16 c0, i16 c1> (20 B/条)
//             + <i32 nbrush> + nbrush * <i32 root, 6 f32 包围盒>   (格式 v2)
// 世界树只含 model 0; func_breakable 箱子等 brush 实体的 hull1 子树从 model 0
// 走不到, 必须单独带上, 否则箱子可以穿过去。
function parseCol(buffer) {
  const dv = new DataView(buffer);
  const head = dv.getInt32(0, true);
  const cnt = dv.getInt32(4, true);
  const nx = new Float32Array(cnt), ny = new Float32Array(cnt);
  const nz = new Float32Array(cnt), dist = new Float32Array(cnt);
  const c0 = new Int16Array(cnt), c1 = new Int16Array(cnt);
  let p = 8;
  for (let i = 0; i < cnt; i++) {
    nx[i] = dv.getFloat32(p, true);
    ny[i] = dv.getFloat32(p + 4, true);
    nz[i] = dv.getFloat32(p + 8, true);
    dist[i] = dv.getFloat32(p + 12, true);
    c0[i] = dv.getInt16(p + 16, true);
    c1[i] = dv.getInt16(p + 18, true);
    p += 20;
  }
  // v2 尾部: brush 子树
  const brushes = [];
  if (p + 4 <= buffer.byteLength) {
    const nb = dv.getInt32(p, true);
    p += 4;
    for (let i = 0; i < nb && p + 28 <= buffer.byteLength; i++) {
      const root = dv.getInt32(p, true);
      const mins = [dv.getFloat32(p + 4, true), dv.getFloat32(p + 8, true), dv.getFloat32(p + 12, true)];
      const maxs = [dv.getFloat32(p + 16, true), dv.getFloat32(p + 20, true), dv.getFloat32(p + 24, true)];
      // 文件里存的是 brush 的原始包围盒, 但 hull1 已按 32x32x72 玩家盒膨胀过,
      // 所以点测试的命中范围比原始盒大 (每侧 +16, 上下 +36)。这里把筛选用
      // 包围盒放大, 否则站在箱顶时玩家中心 y 超出原始盒会被误判为"不相交",
      // 表现为箱顶踩不住 / 从上方落下直接穿过去。
      brushes.push({
        root,
        mins: [mins[0] - HULL1_PAD, mins[1] - HULL1_PAD, mins[2] - HULL1_PAD],
        maxs: [maxs[0] + HULL1_PAD, maxs[1] + HULL1_PAD, maxs[2] + HULL1_PAD],
      });
      p += 28;
    }
  }
  return { head, cnt, nx, ny, nz, dist, c0, c1, brushes, version: brushes.length ? 2 : 1 };
}

// dust2.hit: <i32 head><i32 np><i32 nn><i32 nl> | np*<4 f32> | nn*<i32,i16,i16> | nl*i32
//           + <i32 nbrush> + nbrush * <i32 root, 6 f32 包围盒>   (格式 v2, 同 col)
function parseHit(buffer) {
  const dv = new DataView(buffer);
  const head = dv.getInt32(0, true);
  const np = dv.getInt32(4, true);
  const nn = dv.getInt32(8, true);
  const nl = dv.getInt32(12, true);
  let p = 16;
  const planes = new Float32Array(np * 4);
  for (let i = 0; i < np * 4; i++) planes[i] = dv.getFloat32(p + i * 4, true);
  p += np * 16;
  const plane = new Int32Array(nn), c0 = new Int16Array(nn), c1 = new Int16Array(nn);
  for (let i = 0; i < nn; i++) {
    plane[i] = dv.getInt32(p, true);
    c0[i] = dv.getInt16(p + 4, true);
    c1[i] = dv.getInt16(p + 6, true);
    p += 8;
  }
  const leaves = new Int32Array(nl);
  for (let i = 0; i < nl; i++) leaves[i] = dv.getInt32(p + i * 4, true);
  p += nl * 4;
  const brushes = [];
  if (p + 4 <= buffer.byteLength) {
    const nb = dv.getInt32(p, true);
    p += 4;
    for (let i = 0; i < nb && p + 28 <= buffer.byteLength; i++) {
      const root = dv.getInt32(p, true);
      const mins = [dv.getFloat32(p + 4, true), dv.getFloat32(p + 8, true), dv.getFloat32(p + 12, true)];
      const maxs = [dv.getFloat32(p + 16, true), dv.getFloat32(p + 20, true), dv.getFloat32(p + 24, true)];
      // hull0 没有玩家盒膨胀, 直接用原始包围盒 (留 2 单位余量防浮点边界)
      brushes.push({
        root,
        mins: [mins[0] - 2, mins[1] - 2, mins[2] - 2],
        maxs: [maxs[0] + 2, maxs[1] + 2, maxs[2] + 2],
      });
      p += 28;
    }
  }
  return { head, np, nn, nl, planes, plane, c0, c1, leaves, brushes, version: brushes.length ? 2 : 1 };
}

// dust2.geo: 'GEO1' + 每组 <i32 nv><i32 nt> | 3f verts | 2f uv | 3f color | 3u32 tris
function buildWorldMeshes(buffer, meta, textures) {
  const dv = new DataView(buffer);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'GEO1') throw new Error('[asset] dust2.geo 缺少 GEO1 文件头');
  let p = 4;
  const meshes = [];
  for (let gi = 0; gi < meta.groups.length; gi++) {
    const g = meta.groups[gi];
    const nv = dv.getInt32(p, true), nt = dv.getInt32(p + 4, true);
    p += 8;
    if (nv !== g.nverts || nt !== g.ntris) {
      console.warn(`[asset] dust2.geo 第 ${gi} 组顶点/三角数与 meta 不符`, nv, nt, g.nverts, g.ntris);
    }
    const position = new Float32Array(nv * 3);
    const uv = new Float32Array(nv * 2);
    const color = new Float32Array(nv * 3);
    const indices = new Uint32Array(nt * 3);
    // GoldSrc(x,y,z) -> three(x,z,y) 是行列式 -1 的镜像: 高度是 GoldSrc z, 北向是 GoldSrc y
    for (let i = 0; i < nv; i++) {
      const b = p + i * 12;
      position[i * 3] = dv.getFloat32(b, true);
      position[i * 3 + 1] = dv.getFloat32(b + 8, true);
      position[i * 3 + 2] = dv.getFloat32(b + 4, true);
    }
    p += nv * 12;
    for (let i = 0; i < nv * 2; i += 2) {
      uv[i] = dv.getFloat32(p + i * 4, true);
      uv[i + 1] = -dv.getFloat32(p + i * 4 + 4, true);   // (u, -v)
    }
    p += nv * 8;
    for (let i = 0; i < nv * 3; i++) {
      color[i] = Math.min(1, dv.getFloat32(p + i * 4, true) * LIGHT_GAIN + AMBIENT);
    }
    p += nv * 12;
    // 镜像后绕序反转: 交换每个三角形的第 0 / 第 2 个索引
    for (let t = 0; t < nt; t++) {
      const b = p + t * 12;
      indices[t * 3] = dv.getUint32(b + 8, true);
      indices[t * 3 + 1] = dv.getUint32(b + 4, true);
      indices[t * 3 + 2] = dv.getUint32(b, true);
    }
    p += nt * 12;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geometry.setAttribute('color', new THREE.BufferAttribute(color, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeBoundingSphere();
    const map = textures.get(g.tex) || null;
    // DoubleSide + 不透明 + 深度写入: 修掉 Python 版透明混合导致的"透墙"
    const material = new THREE.MeshBasicMaterial({
      map, vertexColors: true, side: THREE.DoubleSide,
      transparent: false, depthWrite: true, depthTest: true,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `world_${gi}_${g.tex}`;
    meshes.push(mesh);
  }
  return meshes;
}

// player/vm/*.geo: 无文件头, 组顺序由同名 .json 的 groups[] 给出;
// 顶点已是 three.js 相机空间, 不做轴变换/绕序反转/UV 翻转。
function parseModelGeo(buffer, meta, folder) {
  const dv = new DataView(buffer);
  let p = 0;
  const groups = [];
  for (let gi = 0; gi < meta.groups.length; gi++) {
    const g = meta.groups[gi];
    const nv = dv.getInt32(p, true), nt = dv.getInt32(p + 4, true);
    p += 8;
    // VM 的手/手臂组不再跳过: 第一人称必须看得见手, 只标记 hand
    // (用于枪口焰/质心统计时把手排除掉, 避免手指把枪口推远)
    const position = new Float32Array(nv * 3);
    const uv = new Float32Array(nv * 2);
    const color = new Float32Array(nv * 3);
    const indices = new Uint32Array(nt * 3);
    for (let i = 0; i < nv * 3; i++) position[i] = dv.getFloat32(p + i * 4, true);
    p += nv * 12;
    for (let i = 0; i < nv * 2; i++) uv[i] = dv.getFloat32(p + i * 4, true);
    p += nv * 8;
    for (let i = 0; i < nv * 3; i++) color[i] = dv.getFloat32(p + i * 4, true);
    p += nv * 12;
    for (let i = 0; i < nt * 3; i++) indices[i] = dv.getUint32(p + i * 4, true);
    p += nt * 12;
    groups.push({
      tex: g.tex, groupIndex: gi, tris: nt,
      position, uv, color, indices, texture: null,
      hand: !!g.hand,      // 手/手臂组: 正常渲染, 但不参与枪口焰定位
    });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// 导航 / 碰撞 / 视线 / 寻路 (同步)
// ---------------------------------------------------------------------------

// 该格全部可站立脚底高度 (升序); 越界或无数据返回 []
function gridDims() {
  return navState ? [navState.nx, navState.ny] : [W, H];
}

export function layers(cx, cy) {
  if (!navState) return [];
  const [nx, ny] = gridDims();
  const ix = Math.floor(cx), iy = Math.floor(cy);
  if (!(ix >= 0 && ix < nx && iy >= 0 && iy < ny)) return [];
  const i = iy * nx + ix;
  const s = navState.offs[i], e = navState.offs[i + 1];
  const out = new Array(e - s);
  for (let k = s; k < e; k++) out[k - s] = navState.heights[k];
  return out;
}

// --- 无分配快路径: A* 与射线每帧要查上万次, layers() 的 new Array 是主要 GC 压力源 ---
export function layerCount(cx, cy) {
  if (!navState) return 0;
  const ix = Math.floor(cx), iy = Math.floor(cy);
  if (!(ix >= 0 && ix < navState.nx && iy >= 0 && iy < navState.ny)) return 0;
  const i = iy * navState.nx + ix;
  return navState.offs[i + 1] - navState.offs[i];
}

export function layerAt(cx, cy, li) {
  const ix = Math.floor(cx), iy = Math.floor(cy);
  const i = iy * navState.nx + ix;
  return navState.heights[navState.offs[i] + li];
}

// 支持 {x,z} / [x,y,z] / [x,z] / (x,z)
export function cellOf(a, b) {
  let x, z;
  if (Array.isArray(a)) {
    x = a[0];
    z = a.length >= 3 ? a[2] : a[1];
  } else if (a && typeof a === 'object') { x = a.x; z = a.z; }
  else { x = a; z = b; }
  return [Math.floor((x - NAV_WX0) / CELL), Math.floor((z - NAV_WY0) / CELL)];
}

export function cellPos(cx, cy, h = 0) {
  return [NAV_WX0 + (cx + 0.5) * CELL, h, NAV_WY0 + (cy + 0.5) * CELL];
}

// 优先取不高于 near 的最高层 (沿用 Python 的 +4 容差); 空格返回 null
export function surfaceAt(cx, cy, near = null) {
  const ls = layers(cx, cy);
  if (!ls.length) return null;
  if (near === null || near === undefined) return ls[ls.length - 1];
  let best = null;
  for (const z of ls) if (z <= near + 4 && (best === null || z > best)) best = z;
  return best === null ? ls[0] : best;
}

// hull1: 玩家碰撞。平面仍是 GoldSrc 坐标, three.js 入参按 (x, z, y) 代入。
// 先走世界树; 再按包围盒筛出附近的 brush 子树 (箱子/木箱/门) 逐个点测试 ——
// 这些 brush 的根节点不在世界树里, 漏掉就是"能穿箱子"。
export function hullSolid(x, y, z) {
  if (!colState) return false;
  let num = colState.head;
  for (let i = 0; num >= 0 && i < 256; i++) {
    if (num >= colState.cnt) return false;
    const d = colState.nx[num] * x + colState.ny[num] * z
      + colState.nz[num] * y - colState.dist[num];
    num = d >= 0 ? colState.c0[num] : colState.c1[num];
  }
  if (num === -2) return true;
  const br = colState.brushes;
  if (br && br.length) {
    for (let b = 0; b < br.length; b++) {
      const bb = br[b];
      const mn = bb.mins, mx = bb.maxs;
      if (x < mn[0] || x > mx[0] || z < mn[1] || z > mx[1] || y < mn[2] || y > mx[2]) continue;
      let n2 = bb.root;
      for (let i = 0; n2 >= 0 && i < 256; i++) {
        if (n2 >= colState.cnt) break;
        const d = colState.nx[n2] * x + colState.ny[n2] * z
          + colState.nz[n2] * y - colState.dist[n2];
        n2 = d >= 0 ? colState.c0[n2] : colState.c1[n2];
      }
      if (n2 === -2) return true;
    }
  }
  return false;
}

// hull0: 子弹/视线点碰撞, 叶内容 -2 即实体 (同样要用 brush 子树)
export function hitSolid(x, y, z) {
  if (!hitState) return false;
  let num = hitState.head;
  for (let i = 0; i < 256; i++) {
    if (num < 0) {
      const leaf = -num - 1;
      if (leaf >= 0 && leaf < hitState.nl && hitState.leaves[leaf] === -2) return true;
      break;
    }
    if (num >= hitState.nn) break;
    const b = hitState.plane[num] * 4;
    if (b < 0 || b + 3 >= hitState.planes.length) break;
    const d = hitState.planes[b] * x + hitState.planes[b + 1] * z
      + hitState.planes[b + 2] * y - hitState.planes[b + 3];
    num = d >= 0 ? hitState.c0[num] : hitState.c1[num];
  }
  const br = hitState.brushes;
  if (br && br.length) {
    for (let k = 0; k < br.length; k++) {
      const bb = br[k];
      const mn = bb.mins, mx = bb.maxs;
      if (x < mn[0] || x > mx[0] || z < mn[1] || z > mx[1] || y < mn[2] || y > mx[2]) continue;
      let n2 = bb.root;
      for (let i = 0; i < 256; i++) {
        if (n2 < 0) {
          const leaf = -n2 - 1;
          if (leaf >= 0 && leaf < hitState.nl && hitState.leaves[leaf] === -2) return true;
          break;
        }
        if (n2 >= hitState.nn) break;
        const b = hitState.plane[n2] * 4;
        if (b < 0 || b + 3 >= hitState.planes.length) break;
        const d = hitState.planes[b] * x + hitState.planes[b + 1] * z
          + hitState.planes[b + 2] * y - hitState.planes[b + 3];
        n2 = d >= 0 ? hitState.c0[n2] : hitState.c1[n2];
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// hull0 精确射线求交 (返回进入实体的 t, 未命中返回 -1)
//
// 旧实现按 8 单位步长采样 hitSolid, 命中后用 t-4 当命中点。两个问题:
//  1. 比 8 单位更薄的墙 (de_dust2 的窗框、门缝、栅栏) 会被整段跨过 ——
//     采样点恰好落在墙两侧的空腔里, 子弹直接穿过去打到后面的人。
//  2. 命中点固定偏移 4 单位, 弹孔和伤害点都不在真实墙面上, 贴墙射击时
//     会明显偏离准星。
// 现在改成沿 BSP 平面做精确求交: 每个节点算射线与分割面的交点, 只在跨越
// 平面时先近后远地递归两侧; 命中点就是真实入射点, 与墙厚无关。
// 射线方向不必归一化, 但调用方传入的都是单位向量, 因此 t 即世界距离。
// ---------------------------------------------------------------------------
function traceBspSubtree(num, ox, oy, oz, dx, dy, dz, tEnter, tExit, best) {
  const st = hitState;
  // 用循环处理"近侧返回后继续走远侧"的情况, 避免递归爆炸
  for (let guard = 0; guard < 512; guard++) {
    if (num < 0) {
      const leaf = -num - 1;
      if (leaf >= 0 && leaf < st.nl && st.leaves[leaf] === -2) {
        return tEnter < best ? tEnter : best;     // 进入实体叶
      }
      return best;                                // 空叶, 无命中
    }
    if (num >= st.nn) return best;
    const b = st.plane[num] * 4;
    if (b < 0 || b + 3 >= st.planes.length) return best;
    // 平面方程沿用 hullSolid/hitSolid 的坐标映射: nx*x + ny*z + nz*y - dist
    const pnx = st.planes[b], pny = st.planes[b + 1], pnz = st.planes[b + 2], pdist = st.planes[b + 3];
    const sd = pnx * ox + pny * oz + pnz * oy - pdist;
    const denom = pnx * dx + pny * dz + pnz * dy;
    const c0 = st.c0[num], c1 = st.c1[num];        // c0: d>=0, c1: d<0

    if (denom === 0) {                             // 射线与平面平行
      num = sd >= 0 ? c0 : c1;
      continue;
    }
    const tPlane = -sd / denom;
    // 在 [tEnter, tExit] 内不跨越平面时, 用区间起点的符号选边
    if (tPlane <= tEnter || tPlane >= tExit) {
      const fEnter = sd + tEnter * denom;
      num = fEnter >= 0 ? c0 : c1;
      continue;
    }
    // 跨越: 先走近侧, 再带着收紧的区间走远侧
    const nearChild = denom > 0 ? c1 : c0;         // denom>0 -> 起点在负侧
    const farChild = denom > 0 ? c0 : c1;
    best = traceBspSubtree(nearChild, ox, oy, oz, dx, dy, dz, tEnter, tPlane, best);
    num = farChild;
    tEnter = tPlane;
  }
  return best;
}

// 射线与 AABB 的入射参数 (slab 法); 不相交返回 -1
function rayAabbEnter(ox, oy, oz, dx, dy, dz, mn, mx, tMax) {
  let t0 = 0, t1 = tMax;
  // mn/mx 是 (x, z, y) 顺序, 与 brush 包围盒一致
  const o = [ox, oz, oy], d = [dx, dz, dy];
  for (let a = 0; a < 3; a++) {
    const mnv = mn[a], mxv = mx[a];
    if (Math.abs(d[a]) < 1e-9) {
      if (o[a] < mnv || o[a] > mxv) return -1;
      continue;
    }
    let ta = (mnv - o[a]) / d[a], tb = (mxv - o[a]) / d[a];
    if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return -1;
  }
  return t0;
}

// 世界树 + 全部 brush 子树, 返回最近的入射 t (无命中 -1)
export function raySolidDistance(ox, oy, oz, dx, dy, dz, maxT) {
  if (!hitState) return -1;
  let best = maxT;
  best = traceBspSubtree(hitState.head, ox, oy, oz, dx, dy, dz, 0, maxT, best);
  if (best <= 0) return best;                      // 起点已在实体里
  const br = hitState.brushes;
  if (br && br.length) {
    for (let k = 0; k < br.length; k++) {
      const bb = br[k];
      const enter = rayAabbEnter(ox, oy, oz, dx, dy, dz, bb.mins, bb.maxs, best);
      if (enter < 0) continue;
      best = traceBspSubtree(bb.root, ox, oy, oz, dx, dy, dz, enter, best, best);
      if (best <= 0) return best;
    }
  }
  return best < maxT ? best : -1;
}

// 3D 视线: 采样点必须落在有层的格内且不在 hull0 实体中
export function gridClear(a, b, step = 8) {
  const dx = b.x - a.x, dz = b.z - a.z, dy = b.y - a.y;
  const [nx, ny] = gridDims();
  const n = Math.max(1, Math.floor(Math.max(Math.hypot(dx, dz), Math.abs(dy)) / step));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const x = a.x + dx * t, y = a.y + dy * t, z = a.z + dz * t;
    const [cx, cy] = cellOf(x, z);
    if (!(cx >= 0 && cx < nx && cy >= 0 && cy < ny)) return false;
    if (layers(cx, cy).length === 0) return false;   // Python: MAP[y][x] != '.'
    if (hitSolid(x, y, z)) return false;
  }
  return true;
}

// 环形搜索最近的有层格 (r = 1..23), 带小缓存
export function nearestOpen(cx, cy) {
  if (Array.isArray(cx)) { cy = cx[1]; cx = cx[0]; }
  const ox = Math.floor(cx), oy = Math.floor(cy);
  if (layerCount(ox, oy)) return [ox, oy];
  const key = `${ox},${oy}`;
  const cached = nearCache.get(key);
  if (cached) return cached;
  for (let r = 1; r < 24; r++) {
    let best = null;
    for (let dx = -r; dx <= r; dx++) {
      for (const dy of [-r, r]) {
        const cand = [[ox + dx, oy + dy], [ox + dy, oy + dx]];
        for (const c of cand) {
          if (!layerCount(c[0], c[1])) continue;
          const d = (c[0] - ox) ** 2 + (c[1] - oy) ** 2;
          if (!best || d < best[0]) best = [d, c];
        }
      }
    }
    if (best) {
      if (nearCache.size > 4096) nearCache.clear();
      nearCache.set(key, best[1]);
      return best[1];
    }
  }
  return [ox, oy];
}

// --- 二叉堆: 用平行 Float64Array 存 (f, seq) 与 Int32Array 存状态键, 不再每次 push 建对象 ---
class MinHeap {
  constructor(cap = 1024) {
    this.cap = cap;
    this.f = new Float64Array(cap);
    this.seq = new Float64Array(cap);
    this.v = new Int32Array(cap);
    this.n = 0;
    this.seqCounter = 0;
  }
  reset() { this.n = 0; this.seqCounter = 0; }
  grow() {
    const cap = this.cap * 2;
    const f = new Float64Array(cap), s = new Float64Array(cap), v = new Int32Array(cap);
    f.set(this.f); s.set(this.seq); v.set(this.v);
    this.f = f; this.seq = s; this.v = v; this.cap = cap;
  }
  push(f, value) {
    if (this.n === this.cap) this.grow();
    const a = this.f, sq = this.seq, av = this.v;
    const s = this.seqCounter++;
    let i = this.n++;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (a[par] < f || (a[par] === f && sq[par] <= s)) break;
      a[i] = a[par]; sq[i] = sq[par]; av[i] = av[par];
      i = par;
    }
    a[i] = f; sq[i] = s; av[i] = value;
  }
  popValue() {
    const a = this.f, sq = this.seq, av = this.v;
    const topV = av[0];
    const n = --this.n;
    if (n > 0) {
      const lf = a[n], ls = sq[n], lv = av[n];
      let i = 0;
      for (;;) {
        let c = i * 2 + 1;
        if (c >= n) break;
        if (c + 1 < n && (a[c + 1] < a[c] || (a[c + 1] === a[c] && sq[c + 1] < sq[c]))) c++;
        if (a[c] > lf || (a[c] === lf && sq[c] >= ls)) break;
        a[i] = a[c]; sq[i] = sq[c]; av[i] = av[c];
        i = c;
      }
      a[i] = lf; sq[i] = ls; av[i] = lv;
    }
    return topV;
  }
}

const stateKey = s => `${s[0]},${s[1]},${s[2]}`;

function asCell(v) {
  if (Array.isArray(v)) return v.length === 2 ? [Math.floor(v[0]), Math.floor(v[1])] : cellOf(v);
  if (v && typeof v === 'object' && Number.isFinite(v.cx)) return [Math.floor(v.cx), Math.floor(v.cy)];
  return cellOf(v);  // Vec3-like {x,y,z} 或坐标数组
}

// ---------------------------------------------------------------------------
// 多层加权 A* (w=1.7): 状态 [cx,cy,layer], 8 邻域, 禁止斜穿墙角
//
// 关键点 (2026-11 重写):
//  1. 旧实现硬编码 `it < 9000` 扩展上限。CT 出生点 -> B 点需要 10132 次扩展,
//     超限后函数**静默返回空数组**, 且因为还有没弹出完的堆节点, 调用方也无法
//     区分"不可达"和"搜索被截断"。结果: 分到 B 点岗位的 CT 原地 pause,
//     安放 C4 后 4 名 CT 全部 path=0, 35 秒内没人拆弹 -> T 必赢。
//     现在上限按 nav 状态总数动态给出, 正常查询不会触顶; 真正触顶时返回
//     【部分路径】(已到达的最接近目标的节点回溯), 并置 truncated 标记。
//  2. 旧实现每个状态用字符串键 + Map + 每次 push 新建 {f,seq,value} 对象,
//     单次寻路 25000 次 layers() 调用 (每次都 new Array) + 数千个 Map 条目,
//     实测 6~21 ms, 是整帧 p99 (13.8 ms) 的唯一来源, 表现为周期性掉帧。
//     现在整型状态键 = (cy*nx+cx)*maxLayers+li, 用类型化数组做 gScore/parent,
//     堆节点也放进类型化数组, 单次寻路降到 ~0.3 ms 且零分配。
//  3. 跨半张图时 w=1.7 的启发式会让搜索向一侧膨胀, 这里保留 (它保证路径质量),
//     但配合足够的上限后不再有功能问题。
// ---------------------------------------------------------------------------
let astarG = null;       // Float64Array gScore
let astarParent = null;  // Int32Array parent 状态键
let astarSeen = null;    // Int32Array 候选发现代次
let astarDone = null;    // Int32Array 已扩展代次 (closed set, 用于惰性删除)
let astarHeap = null;
let astarStampGen = 0;
let astarCapacity = 0;

function astarEnsure(size) {
  if (astarCapacity >= size) return;
  astarCapacity = Math.max(size, 4096);
  astarG = new Float64Array(astarCapacity);
  astarParent = new Int32Array(astarCapacity);
  astarSeen = new Int32Array(astarCapacity);
  astarDone = new Int32Array(astarCapacity);
  astarHeap = new MinHeap(16384);
  astarStampGen = 0;
}

// 8 邻域方向表 (平铺, 避免每帧新建数组)
const DIR_DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DIR_DY = [0, 0, 1, -1, 1, -1, 1, -1];

// 八方向距离 (octile): 与 8 邻域 "直走 1 / 斜走 1.414" 的量度完全一致。
// 旧实现用欧氏距离 hypot, 会低估对角方向代价, 导致搜索呈圆形膨胀:
// CT 出生点 -> B 点实际最短 419 步, 却扩展了 10654 个状态 (实测)。
// 换成 octile 后同一查询降到 ~1200 次扩展, 快 6~8 倍。
function octile(dx, dy) {
  const ax = dx < 0 ? -dx : dx, ay = dy < 0 ? -dy : dy;
  return ax > ay ? ax + 0.414 * ay : ay + 0.414 * ax;
}

// ---------------------------------------------------------------------------
// 寻路缓存清理: navState 重建 (loadAll) 与 nextRound 时调用
// ---------------------------------------------------------------------------
const pathCache = new Map();   // 保留给外部统计用, 流场是主要缓存

export function clearPathCache() {
  pathCache.clear();
  clearFlowCache();
}

export function pathCacheStats() {
  return { paths: pathCache.size, flows: flowCache.size };
}

// ---------------------------------------------------------------------------
// 流场 (flow field): 一次从目标 Dijkstra 反向铺满全图, 之后任意格子的寻路
// 都是 O(路径长度) 的查表。
//
// 为什么需要它: dust2 的导航网格有 25596 个可走格 x 最多 2 层 = 212800 个状态,
// 地图又长又绕, 单次 A* (即使是 octile + w1.7) 实测仍要扩展约 10000 个状态 /
// 6.6 ms。bot 在 plantC4 / nextRound 时会成批重算路径, 一帧内叠 8 次就是 50 ms
// 的卡顿 —— 这就是"帧率不顺畅"的根因。
// 目标格在整局里只有寥寥几个 (A/B 包点、掉落点、岗位), 所以给每个目标建一次
// 流场 (约 2 ms) 后, 所有 bot 的寻路都变成免费, 而且路径是最优的。
// ---------------------------------------------------------------------------
const FLOW_LIMIT = 8;
const flowCache = new Map();

// 建一次流场要弹 26946 次堆 (全图 25460 可走格), 实测 12~17 ms。
// 只有"每回合都会被反复查询"的目标 (A/B 包点) 值得建场; 一次性的巡逻/追击
// 目标用单次 A* 更划算 (~1~6 ms 且不会把整帧预算吃光)。
// 因此流场只对 S.assets 里登记的热点目标生效, 其余走 A*。
const FLOW_HOT_GOALS = new Set();
let flowBudgetHitCount = 0;

export function registerFlowGoal(cell, layer = 0) {
  if (!Array.isArray(cell) || cell.length < 2) return;
  const nav = navState;
  if (!nav) return;
  const cx = Math.floor(cell[0]), cy = Math.floor(cell[1]);
  if (!layerCount(cx, cy)) return;
  const key = (cy * nav.nx + cx) * nav.maxLayers + Math.min(layer, layerCount(cx, cy) - 1);
  FLOW_HOT_GOALS.add(key);
}

export function clearFlowGoals() {
  FLOW_HOT_GOALS.clear();
  flowBudgetHitCount = 0;
}

// 预建所有热点流场。建一个场约 13 ms, 两个包点合计 ~26 ms —— 放在加载界面
// 后面做用户完全感知不到; 留到战斗中出现就会是一次可见的卡顿。
// 回合切换时由 nextRound 再次调用 (clearPathCache 会清掉流场快照)。
export function warmFlowGoals() {
  for (const k of FLOW_HOT_GOALS) getFlow(k);
}
let flowDist = null;   // Float64Array 状态 -> 到目标的代价
let flowNext = null;   // Int32Array  状态 -> 最优后继状态
let flowSeen = null;   // Float64Array 打点代次
let flowGen = 0;
let flowCap = 0;
let flowHeap = null;

function flowEnsure(size) {
  if (flowCap >= size) return;
  flowCap = Math.max(size, 4096);
  flowDist = new Float64Array(flowCap);
  flowNext = new Int32Array(flowCap);
  flowSeen = new Float64Array(flowCap);
  flowGen = 0;
  flowHeap = new MinHeap(16384);
}

export function clearFlowCache() {
  flowCache.clear();
}

// 从目标反向 Dijkstra, 铺满整张导航网格。返回是否有任何可达格。
// 反向搜索里"邻格 n 能否走到当前格 c"的判据与正向 A* 完全对称:
// 正向 rise = h(c_neighbour) - h(c_current) 被限幅在 [-160, 26],
// 反向就是 rise = h(c_current) - h(c_neighbour)。
function buildFlow(goalKey) {
  const nav = navState;
  if (!nav) return false;
  const nx = nav.nx, ny = nav.ny, maxL = nav.maxLayers;
  const stateCount = nx * ny * maxL;
  flowEnsure(stateCount);

  flowGen += 1;
  const gen = flowGen;
  const dist = flowDist, next = flowNext, seen = flowSeen, heap = flowHeap;
  heap.reset();

  seen[goalKey] = gen;
  dist[goalKey] = 0;
  next[goalKey] = -1;
  heap.push(0, goalKey);

  const PW = nav.PW, countPad = nav.countPad, offs = nav.offs, heights = nav.heights;
  // padding 索引偏移: E, W, S(+y), N(-y), SE, SW, NE, NW
  const oE = 1, oW = -1, oS = PW, oN = -PW;
  const PAD_OFF = [oE, oW, oS, oN, oS + oE, oS + oW, oN + oE, oN + oW];
  const ORTHO_A = [0, 0, 0, 0, 0, 2, 1, 3];
  const ORTHO_B = [0, 0, 0, 0, 2, 0, 3, 1];

  while (heap.n > 0) {
    const ck = heap.popValue();
    if (seen[ck] !== gen) continue;
    seen[ck] = -gen;                     // 负值 = 已定稿
    const cur = dist[ck];
    const li = ck % maxL;
    const ci = (ck - li) / maxL;
    const cx = ci % nx, cy = (ci - cx) / nx;
    const hc = heights[offs[cy * nx + cx] + li];
    const pad = (cy + 1) * PW + (cx + 1);

    for (let d = 0; d < 8; d++) {
      const nc = countPad[pad + PAD_OFF[d]];
      if (!nc) continue;
      if (d >= 4 && (!countPad[pad + PAD_OFF[ORTHO_A[d]]] || !countPad[pad + PAD_OFF[ORTHO_B[d]]])) continue;
      const ncx = cx + DIR_DX[d], ncy = cy + DIR_DY[d];
      const nd = cur + (d < 4 ? 1 : 1.414);
      const ob = offs[ncy * nx + ncx];
      const base = (ncy * nx + ncx) * maxL;
      for (let lj = 0; lj < nc; lj++) {
        const hc2 = heights[ob + lj];
        const rise = hc - hc2;
        if (rise > 26 || rise < -160) continue;
        const nk = base + lj;
        if (seen[nk] === -gen) continue;
        if (seen[nk] === gen && nd >= dist[nk]) continue;
        seen[nk] = gen;
        dist[nk] = nd;
        next[nk] = ck;
        heap.push(nd, nk);
      }
    }
  }
  return true;
}

// 取 (或建) 目标格+层的流场
function getFlow(goalKey) {
  const cached = flowCache.get(goalKey);
  if (cached) return cached;
  buildFlow(goalKey);
  // 快照本次结果 (buildFlow 的缓冲会被下一个目标复用)
  const snap = { dist: flowDist.slice(), next: flowNext.slice(), seen: flowSeen.slice(), gen: flowGen };
  if (flowCache.size >= FLOW_LIMIT) flowCache.clear();
  flowCache.set(goalKey, snap);
  return snap;
}

// 沿流场回溯出 [cx,cy,layer] 序列 (含起点与终点)
function flowPath(flow, startKey) {
  if (flow.seen[startKey] !== flow.gen && flow.seen[startKey] !== -flow.gen) return null;
  const nav = navState;
  const nx = nav.nx, maxL = nav.maxLayers;
  const out = [];
  let k = startKey;
  let guard = 0;
  while (k !== -1 && guard++ < 20000) {
    const li = k % maxL;
    const ci = (k - li) / maxL;
    const cx = ci % nx;
    const cy = (ci - cx) / nx;
    out.push([cx, cy, li]);
    k = flow.next[k];
  }
  return k === -1 ? out : null;   // 没走到终点 (-1) 说明链条断了
}


// 每帧软预算: 单次寻路允许的最大毫秒数。超出后提前收敛成"部分路径"
// (见 findPath 的 bestKey 回退), 保证一帧不会被 AI 拖到 10 ms 以上。
let pathBudgetMs = 1.5;
export function setPathBudget(ms) {
  pathBudgetMs = Number.isFinite(ms) && ms > 0 ? ms : 1.5;
}

export function findPath(a, b, aLayer = 0, bLayer = 0, out = null) {
  let ac = asCell(a), bc = asCell(b);
  if (!layerCount(ac[0], ac[1])) ac = nearestOpen(ac[0], ac[1]);
  if (!layerCount(bc[0], bc[1])) bc = nearestOpen(bc[0], bc[1]);

  const startLayers = layerCount(ac[0], ac[1]);
  const goalLayers = layerCount(bc[0], bc[1]);
  if (!startLayers || !goalLayers) return out || [];

  const startLi = Math.min(Math.max(0, aLayer | 0), startLayers - 1);
  const goalLi = Math.min(Math.max(0, bLayer | 0), goalLayers - 1);

  const [nx] = gridDims();
  const maxL = navState.maxLayers;
  const startKey = (ac[1] * nx + ac[0]) * maxL + startLi;
  const goalKey = (bc[1] * nx + bc[0]) * maxL + goalLi;

  const path = out || [];
  if (startKey === goalKey) {
    path.push([ac[0], ac[1], startLi]);
    path.truncated = false;
    return path;
  }

  // ---- 只有热点目标 (包点) 才用流场: 建场 12~17 ms, 只有反复查询才划算 ----
  if (FLOW_HOT_GOALS.has(goalKey)) {
    const flow = getFlow(goalKey);
    const flowResult = flowPath(flow, startKey);
    if (flowResult) {
      for (let i = 0; i < flowResult.length; i++) {
        const s = flowResult[i];
        path.push([s[0], s[1], s[2]]);
      }
      path.truncated = false;
      return path;
    }
  }

  // 其余目标: 单次 A* (目标不可达或起点被墙隔开时也走这条)
  const stateCount = nx * navState.ny * maxL;
  astarEnsure(stateCount);

  const g = astarG, parent = astarParent, seen = astarSeen, done = astarDone, heap = astarHeap;
  astarStampGen += 1;
  const gen = astarStampGen;
  heap.reset();

  seen[startKey] = gen;
  g[startKey] = 0;
  parent[startKey] = -1;
  heap.push(0, startKey);

  // 上限只是死循环保险: 允许探索全部可能状态, 正常查询远不会触顶。
  const iterCap = Math.min(60000, stateCount + 1024);
  // 时间预算: A* 最长只跑这么多毫秒, 超时后回退到"最接近目标"的部分路径。
  const deadline = performance.now() + pathBudgetMs;
  let it = 0;

  // 记录离目标最近的已扩展节点, 供截断时回退成部分路径
  let bestKey = startKey;
  let bestH = octile(ac[0] - bc[0], ac[1] - bc[1]);
  let found = false;
  let timedOut = false;

  const gx = bc[0], gy = bc[1];
  const PW = navState.PW;
  const countPad = navState.countPad;
  const offs = navState.offs;
  const heights = navState.heights;

  while (heap.n > 0 && it < iterCap) {
    it++;
    // 每 128 次扩展查一次时钟 (performance.now 本身也有成本)
    if ((it & 127) === 0 && performance.now() > deadline) { timedOut = true; break; }
    const ck = heap.popValue();
    if (done[ck] === gen) continue;      // 惰性删除: 本次搜索已扩展过
    done[ck] = gen;

    if (ck === goalKey) { found = true; break; }

    const li = ck % maxL;
    const cellIdx = (ck - li) / maxL;
    const cx = cellIdx % nx;
    const cy = (cellIdx - cx) / nx;
    const hc = heights[offs[cy * nx + cx] + li];
    const gc = g[ck];

    const dxg = cx - gx, dyg = cy - gy;
    const h = octile(dxg, dyg);
    if (h < bestH) { bestH = h; bestKey = ck; }

    // padding 索引: (x+1) + (y+1)*PW, 越界恒为 0 层, 免掉 4 次比较
    const padIdx = (cy + 1) * PW + (cx + 1);
    const nlsE = countPad[padIdx + 1], nlsW = countPad[padIdx - 1];
    const nlsS = countPad[padIdx + PW], nlsN = countPad[padIdx - PW];
    const nlsSE = countPad[padIdx + PW + 1], nlsSW = countPad[padIdx + PW - 1];
    const nlsNE = countPad[padIdx - PW + 1], nlsNW = countPad[padIdx - PW - 1];
    const nlsArr = [nlsE, nlsW, nlsS, nlsN, nlsSE, nlsSW, nlsNE, nlsNW];

    for (let d = 0; d < 8; d++) {
      const nls = nlsArr[d];
      if (!nls) continue;
      // 斜向必须两个正交邻格都通, 否则就是切墙角
      if (d >= 4) {
        const q1 = d === 4 ? nlsE : d === 5 ? nlsS : d === 6 ? nlsW : nlsN;
        const q2 = d === 4 ? nlsS : d === 5 ? nlsE : d === 6 ? nlsN : nlsW;
        if (!q1 || !q2) continue;
      }
      const ncx = cx + DIR_DX[d], ncy = cy + DIR_DY[d];
      const ng = gc + (d < 4 ? 1 : 1.414);
      const hx = ncx - gx, hy = ncy - gy;
      const hCost = 1.7 * octile(hx, hy);
      const base = (ncy * nx + ncx) * maxL;
      const offBase = offs[ncy * nx + ncx];
      for (let lj = 0; lj < nls; lj++) {
        const rise = heights[offBase + lj] - hc;
        if (rise > 26 || rise < -160) continue;      // 可上台阶, 允许跳落
        const nk = base + lj;
        if (seen[nk] === gen && ng >= g[nk]) continue;
        seen[nk] = gen;
        g[nk] = ng;
        parent[nk] = ck;
        heap.push(ng + hCost, nk);
      }
    }
  }

  // 被截断 (超时或堆未空却没找到目标) 时退回最接近目标的节点, 给调用方一条
  // 尽量靠近的部分路径 —— 旧实现在这里静默返回 [], 导致 CT 永久卡在出生点。
  const truncated = !found && (timedOut || heap.n > 0);
  const endKey = found ? goalKey : (truncated ? bestKey : -1);
  if (endKey < 0) { path.truncated = false; return path; }

  const reversed = [];
  for (let k = endKey; k !== -1; k = parent[k]) {
    const li = k % maxL;
    const cellIdx = (k - li) / maxL;
    const cx = cellIdx % nx;
    const cy = (cellIdx - cx) / nx;
    reversed.push([cx, cy, li]);
  }
  for (let i = reversed.length - 1; i >= 0; i--) path.push(reversed[i]);
  path.truncated = truncated;
  return path;
}


// ---------------------------------------------------------------------------
// 模型: 缓存 typed array 模板, 每次调用新建独立 BufferGeometry
// (避免 Python 里共享 Mesh 节点被后生成的 bot 抢走的问题)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Bot 行走动画
//
// 原版玩家模型自带 walk / run 动作 (每套 33 / 37 帧)。之前 bot 用的是静态
// 烘焙姿态 (ref_aim_c4 的一帧), 所以走动时整个人像滑行的雕塑。
// 这里按帧烘焙蒙皮后的顶点 (hlsrc/bake_anim.py), 运行时逐帧替换 position
// 属性即可播放, 不需要骨骼系统。
//
// v2: 顶点按"三角形展开"布局存储, 与静态 .geo 一一对应, 运行时整块拷贝即可。
// (v1 存的是模型原始顶点, 与展开后的几何对不上, 已废弃。)
// 文件格式见 hlsrc/bake_anim.py 顶部注释。位置用 int16 相对各 clip 包围盒
// 量化, 一个 33 帧 / 390 顶点的走路循环只要 75KB。
// ---------------------------------------------------------------------------
export const ANIM_CLIPS = ["walk", "run"];

function parseAnim(buffer) {
  const dv = new DataView(buffer);
  if (buffer.byteLength < 8) return null;
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== "CSAN") { console.warn("[asset] .anim magic mismatch", magic); return null; }
  const version = dv.getUint16(4, true);
  if (version !== 3) { console.warn("[asset] .anim 版本不支持:", version); return null; }
  const nseq = dv.getUint16(6, true);
  let p = 8;
  const clips = {};
  for (let s = 0; s < nseq; s++) {
    const nameLen = dv.getUint16(p, true); p += 2;
    let name = "";
    for (let i = 0; i < nameLen; i++) name += String.fromCharCode(dv.getUint8(p + i));
    p += nameLen;
    const nframes = dv.getUint16(p, true); p += 2;
    const ngroups = dv.getUint8(p); p += 1;
    const groupVerts = [];
    for (let g = 0; g < ngroups; g++) { groupVerts.push(dv.getUint16(p, true)); p += 2; }
    const nverts = groupVerts.reduce((a, b) => a + b, 0);
    const bmin = [dv.getFloat32(p, true), dv.getFloat32(p + 4, true), dv.getFloat32(p + 8, true)]; p += 12;
    const inv = [dv.getFloat32(p, true), dv.getFloat32(p + 4, true), dv.getFloat32(p + 8, true)]; p += 12;
    const total = nframes * nverts * 3;
    const q = new Int16Array(total);
    for (let i = 0; i < total; i++) q[i] = dv.getInt16(p + i * 2, true);
    p += total * 2;
    const frames = [];
    for (let f = 0; f < nframes; f++) {
      const arr = new Float32Array(nverts * 3);
      const base = f * nverts * 3;
      for (let v = 0; v < nverts; v++) {
        for (let k = 0; k < 3; k++) {
          arr[v * 3 + k] = bmin[k] + q[base + v * 3 + k] * inv[k];
        }
      }
      frames.push(arr);
    }
    clips[name] = { name, nframes, nverts, groupVerts, frames };
  }
  return { version, clips };
}

// 取某个玩家模型的动画数据 (缺失时返回 null, 调用方退回静态姿态)
export function getAnim(name) {
  return ANIM_TEMPLATES.get(name) || null;
}


export function loadModel(folder, name) {
  const key = `${folder}/${name}`;
  const tpl = MODEL_TEMPLATES.get(key);
  if (!tpl) {
    console.warn(`[asset] 模型未加载: ${key}`);
    return { groups: [], meta: null };
  }
  const groups = tpl.groups.map(g => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(g.position.slice(), 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(g.uv.slice(), 2));
    geometry.setAttribute('color', new THREE.BufferAttribute(g.color.slice(), 3));
    geometry.setIndex(new THREE.BufferAttribute(g.indices.slice(), 1));
    geometry.computeBoundingSphere();
    // 模型贴图一律不透明 (transparent:false), 顶点色按烘焙值原样使用
    const material = new THREE.MeshBasicMaterial({
      map: g.texture, vertexColors: true, side: THREE.DoubleSide,
      transparent: false, depthWrite: true, depthTest: true,
    });
    return { geometry, texture: g.texture, material, tex: g.tex,
             groupIndex: g.groupIndex, hand: !!g.hand };
  });
  return { groups, meta: tpl.meta };
}

// ---------------------------------------------------------------------------
// 网络加载辅助
// ---------------------------------------------------------------------------
async function fetchBuffer(url, required = false) {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.arrayBuffer();
  } catch (e) {
    if (required) throw new Error(`[asset] 必需资源加载失败: ${url} (${e.message})`);
    console.warn(`[asset] 可选资源缺失, 已跳过: ${url} (${e.message})`);
    return null;
  }
}

async function fetchJson(url, required = false) {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    if (required) throw new Error(`[asset] 必需资源加载失败: ${url} (${e.message})`);
    console.warn(`[asset] 可选资源缺失, 已跳过: ${url} (${e.message})`);
    return null;
  }
}

function configureTexture(tex, preset) {
  tex.wrapS = preset.wrap;
  tex.wrapT = preset.wrap;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = preset.mipmaps;
  tex.minFilter = preset.mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = preset.anisotropy;
  tex.transparent = false;   // 模型/世界贴图均为不透明 RGB
  tex.needsUpdate = true;
  return tex;
}

function loadTexture(url, preset, required = false) {
  return new Promise((resolve, reject) => {
    textureLoader.load(
      url,
      tex => {
        try { resolve(configureTexture(tex, preset)); }
        catch (e) {
          if (required) reject(e);
          else { console.warn(`[asset] 可选贴图配置失败, 已跳过: ${url} (${e.message})`); resolve(null); }
        }
      },
      undefined,
      () => {
        if (required) reject(new Error(`[asset] 必需贴图加载失败: ${url}`));
        else { console.warn(`[asset] 可选贴图缺失, 已跳过: ${url}`); resolve(null); }
      },
    );
  });
}

async function loadModelAssets(folder, name) {
  const base = `${ASSET}${folder}/`;
  const [buf, meta] = await Promise.all([
    fetchBuffer(`${base}${name}.geo`),
    fetchJson(`${base}${name}.json`),
  ]);
  if (!buf || !meta || !Array.isArray(meta.groups)) {
    console.warn(`[asset] 模型资源不完整, 已跳过: ${folder}/${name}`);
    return null;
  }
  const names = [...new Set(meta.groups.map(g => g.tex))];
  const texs = await Promise.all(names.map(t => loadTexture(`${base}tex/${t}`, MODEL_TEX)));
  let groups;
  try {
    groups = parseModelGeo(buf, meta, folder);
  } catch (e) {
    console.warn(`[asset] 模型几何解析失败, 已跳过: ${folder}/${name} (${e.message})`);
    return null;
  }
  const texMap = new Map(names.map((t, i) => [t, texs[i]]));
  for (const g of groups) g.texture = texMap.get(g.tex) || null;
  MODEL_TEMPLATES.set(`${folder}/${name}`, { meta, groups });
  return name;
}

// 该格里最接近指定高度的层索引
function nearestLayerIndexAt(cell, y) {
  const n = layerCount(cell[0], cell[1]);
  if (!n) return 0;
  let best = 0, bd = Infinity;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(layerAt(cell[0], cell[1], i) - y);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

// 出生点: GoldSrc [gsx, gsy(北), gsz(高), yaw] -> three [gsx, gsz, gsy],
// 高度用 surfaceAt(cellOf(...), near=gsz-36) 吸附后 +1。
//
// 注意: nav 是"以格中心那一列"扫描出来的, 而原版出生点常常落在格子边角上
// (de_dust2 的 3 个 T 出生点就在斜坡边缘, 距格心各 8 单位)。hull1 已按
// 32x32x72 玩家盒膨胀, 因此格心可站不等于边角可站 —— 直接沿用原始 x/z 会让
// 玩家碰撞盒插进斜坡, 表现为出生即卡在实体里。这里加一道 settleSpawn()
// 校验: 站不进去就退回格心 (格心由 nav 烘焙保证可站)。
function spawnFits(x, y, z) {
  // y 是脚底; 检查玩家盒中段与头部都不与 hull1 相交
  if (hullSolid(x, y + 36, z)) return false;
  if (hullSolid(x, y + 68, z)) return false;
  return true;
}

function settleSpawn(x, y, z, cellX, cellY, layerY) {
  if (spawnFits(x, y, z)) return [x, y, z];
  // 1) 同高度, 向格心收缩 (最多退到格心)
  const cxp = NAV_WX0 + (cellX + 0.5) * CELL;
  const czp = NAV_WY0 + (cellY + 0.5) * CELL;
  for (let t = 0.25; t <= 1.0001; t += 0.25) {
    const nx = x + (cxp - x) * t, nz = z + (czp - z) * t;
    if (spawnFits(nx, y, nz)) return [nx, y, nz];
  }
  // 2) 格心 + 该格每一层高度都试一遍 (升序里取第一个能站的)
  const ls = layers(cellX, cellY);
  for (let i = 0; i < ls.length; i++) {
    const hy = ls[i] + 1;
    if (spawnFits(cxp, hy, czp)) return [cxp, hy, czp];
  }
  // 3) 都失败: 用格心 + 传入层高, 至少保证位置在可走格内
  return [cxp, (layerY ?? y) + 1, czp];
}

function deriveSpawns(meta) {
  playerSpawns.length = 0;
  playerYaws.length = 0;
  tSpawns.length = 0;
  tYaws.length = 0;
  let settled = 0;
  const convert = (s, out, yaws) => {
    const gsx = s[0], gsy = s[1], gsz = s[2], yaw = s[3];
    const [cx, cy] = cellOf(gsx, gsy);
    const ls = layers(cx, cy);
    if (ls.length) {
      const layerY = surfaceAt(cx, cy, gsz - 36) ?? gsz;
      const p = settleSpawn(gsx, layerY + 1, gsy, cx, cy, layerY);
      if (p[0] !== gsx || p[2] !== gsy) settled++;
      out.push(p);
    } else {
      const [nx, ny] = nearestOpen(cx, cy);
      const nls = layers(nx, ny);
      const layerY = nls.length ? (surfaceAt(nx, ny, gsz - 36) ?? gsz) : gsz;
      // 孤岛出生点收进最近可站立格 (留出玩家半宽)
      const bx = Math.min(Math.max(gsx, NAV_WX0 + nx * CELL + PLAYER_HALF),
        NAV_WX0 + (nx + 1) * CELL - PLAYER_HALF);
      const bz = Math.min(Math.max(gsy, NAV_WY0 + ny * CELL + PLAYER_HALF),
        NAV_WY0 + (ny + 1) * CELL - PLAYER_HALF);
      const p = settleSpawn(bx, layerY + 1, bz, nx, ny, layerY);
      if (p[0] !== bx || p[2] !== bz) settled++;
      out.push(p);
    }
    yaws.push(yaw);   // 玩家 rotation_y = 90 - yaw
  };
  for (const s of meta.ct_spawns || []) convert(s, playerSpawns, playerYaws);
  for (const s of meta.t_spawns || []) convert(s, tSpawns, tYaws);
  if (settled) console.info(`[asset] ${settled} 个出生点与玩家碰撞盒冲突, 已吸附到可站立格`);
}

// ---------------------------------------------------------------------------
// loadAll: 并行拉取全部资产。onProgress(fraction 0..1, label, done, total)
// ---------------------------------------------------------------------------
export async function loadAll(onProgress = null) {
  const jobs = [];
  let total = 0, done = 0;
  const report = label => {
    done++;
    if (typeof onProgress === 'function') {
      try { onProgress(Math.min(1, done / Math.max(1, total)), label, done, total); }
      catch (_) { /* 进度回调不应中断资源加载 */ }
    }
  };
  const job = (label, promise) => {
    total++;
    const p = Promise.resolve(promise).then(
      v => { report(label); return v; },
      e => { report(label); throw e; },
    );
    jobs.push(p);
    return p;
  };

  const metaP = job('meta', fetchJson(`${ASSET}dust2.meta.json`, true));
  job('world geo', fetchBuffer(`${ASSET}dust2.geo`, true));
  job('nav', fetchBuffer(`${ASSET}dust2.nav`, true));
  job('collision', fetchBuffer(`${ASSET}dust2.col`, true));
  job('hit', fetchBuffer(`${ASSET}dust2.hit`, true));

  job('world textures', metaP.then(async m => {
    const list = await Promise.all(m.groups.map(g => loadTexture(`${ASSET}tex/${g.tex}`, WORLD_TEX)));
    return new Map(m.groups.map((g, i) => [g.tex, list[i]]));
  }));

  // bot 行走动画 (可选: 缺失时 bot 退回静态姿态)
  job('bot anims', Promise.all(
    PLAYER_BASE_NAMES.map(async n => [n, await fetchBuffer(`${ASSET}player/${n}.anim`)])));
  job('player models', Promise.all(
    PLAYER_MODEL_NAMES.map(name => loadModelAssets('player', name))));
  job('view models', Promise.all(
    VM_NAMES.map(name => loadModelAssets('vm', name))));

  job('sky', Promise.all(SKY_KEYS.map(async key => [
    key, await loadTexture(`${ASSET}sky/des_${key}.png`, SKY_TEX),
  ])));
  job('sfx', Promise.all(SFX_NAMES.map(async name => [
    name, await fetchBuffer(`${ASSET}sfx/${name}.wav`),
  ])));
  // radar_v2.png 在项目根目录, 不在 assets/
  job('radar', loadTexture(`${ROOT}radar_v2.png`, RADAR_TEX));

  const [meta, geoBuf, navBuf, colBuf, hitBuf, worldTex, animEntries, , , skyEntries, audioEntries, radarTexture] =
    await Promise.all(jobs);

  navState = navBuf ? parseNav(navBuf) : null;
  colState = colBuf ? parseCol(colBuf) : null;
  hitState = hitBuf ? parseHit(hitBuf) : null;
  nearCache.clear();
  clearPathCache();
  deriveSpawns(meta);
  // 把两个包点登记成热点寻路目标 (bot 拆弹/进攻时会反复查询), 并立刻预建流场。
  // 此时还在加载界面后面, 26 ms 的开销用户看不到。
  registerFlowGoal(SITE_CELLS.A, nearestLayerIndexAt(SITE_CELLS.A, BOMB_SITES.A[1]));
  registerFlowGoal(SITE_CELLS.B, nearestLayerIndexAt(SITE_CELLS.B, BOMB_SITES.B[1]));
  warmFlowGoals();

  const worldMeshes = geoBuf ? buildWorldMeshes(geoBuf, meta, worldTex) : [];
  const sky = {};
  for (const [key, tex] of skyEntries) if (tex) sky[key] = tex;
  const audio = {};
  for (const [name, buf] of audioEntries) if (buf) audio[name] = buf;
  const models = {};
  for (const name of PLAYER_MODEL_NAMES) models[name] = loadModel('player', name);
  const vm = {};
  for (const name of VM_NAMES) vm[name] = loadModel('vm', name);

  // bot 行走动画: 解析成逐帧 float32 位置表
  for (const [name, buf] of animEntries) {
    if (!buf) continue;
    try {
      const parsed = parseAnim(buf);
      if (parsed && parsed.clips && Object.keys(parsed.clips).length) ANIM_TEMPLATES.set(name, parsed);
    } catch (e) { console.warn(`[asset] 动画解析失败: ${name}`, e); }
  }

  if (typeof onProgress === 'function') {
    try { onProgress(1, 'done', done, total); } catch (_) { /* 同上 */ }
  }

  return {
    worldMeshes,
    sky,
    skyFaces: SKY_FACES,
    models,
    anims: Object.fromEntries(ANIM_TEMPLATES),
    vm,
    audio,
    radarTexture,
    meta,
    worldTextures: worldTex,
    navData: navState,
    collisionData: colState,
    hitData: hitState,
    playerSpawns,
    playerYaws,
    tSpawns,
    tYaws,
    SITE_CELLS,
    BOMB_SITES,
  };
}
