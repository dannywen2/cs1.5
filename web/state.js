/**
 * 全局共享状态与跨模块调用钩子。
 *
 * 约定: 所有模块只依赖 state.js + asset.js, 彼此之间不直接 import,
 * 需要互相调用时通过 S.hooks 注册/调用, 避免循环依赖。
 *
 * 坐标系与 main.py (Ursina) 完全一致: x 右, y 上, z 前, yaw=0 朝 +z,
 * yaw 增大向 +x 转; right = (cos yaw, 0, -sin yaw)。
 */
import { RUN_SPEED, WEAPONS, BASE_FOV } from './asset.js';

export const S = {
  assets: null,
  engine: null,
  hud: null,
  audio: null,

  // ---- 输入 ----
  keys: Object.create(null),
  mouseDX: 0,
  mouseDY: 0,
  mouseDown: false,
  rightDown: false,
  pointerLocked: false,

  // ---- 玩家 ----
  player: {
    pos: [0, 0, 0],          // 脚底位置
    yaw: 0,                  // 度
    pitch: 0,                // 度, 正数低头
    vy: 0,
    grounded: false,
    airTime: 0,
    speed: RUN_SPEED,
    hp: 100,
    armor: 0,
    hasHelmet: false,
    hasKit: false,
    hasC4: false,            // 玩家是进攻方 (T) 时由自己携带 C4
    needsDefaultPistol: false, // 阵亡后下回合补发队伍默认手枪
    nades: { he: 0, flash: 0, smoke: 0 },
    dead: false,
    crouching: false,
    sensitivity: 2.0,        // 倍率 (每像素 0.06 度 x 倍率), 见 engine.js DEG_PER_COUNT
    sensitivityBase: 2.0,    // 用户设定值, 开镜/关镜后恢复到它
  },
  stats: { kills: 0, deaths: 0 },   // 逐人计分板: 玩家战绩

  // ---- 主菜单 / 设置 (localStorage 持久化, 见 main.js) ----
  settings: {
    sensitivity: 2.0,
    volume: 0.8,
    fov: BASE_FOV,
    botCount: 5,
    difficulty: 1,           // 0.75 简单 / 1 普通 / 1.35 困难
    roundsPerHalf: 15,       // MR15 / MR12 / MR9
    positional: true,        // 3D 定位音频
  },
  baseFov: BASE_FOV,
  menuMode: null,           // 'start' | 'pause' | null
  matchPanel: null,         // 终局面板数据, 由 game.js roundEnd 写入

  // ---- 武器 ----
  weapon: 'usp',
  owned: { knife: true, usp: true },
  ammo: {},                  // { wid: [clip, reserve] }
  silenced: { usp: false, m4a1: false },  // USP / M4A1 消音器
  glockMode: 'semi',        // 'semi' | 'burst' (Glock-18 三连发)
  recoil: { index: 0, lastAt: -99 },      // 确定性后坐力弹道
  shootCd: 0,
  reloading: false,
  reloadProgress: 0,       // 0..1, 驱动第一人称换弹动作 (见 engine.js reloadPose)
  reloadStartedAt: 0,
  reloadDuration: 1.6,
  scoped: false,
  scopeLevel: 0,          // 变焦级数: 0 = 不瞄
  crossHeat: 0,
  stepTimer: 0,
  vmAnim: { t: 0, recoil: 0, dip: 0 },
  grenades: [],
  smokes: [],
  debris: [],
  drops: [],                // 掉落武器: { wid, clip, reserve, pos, mesh, ttl }
  effects: { shells: [], tracers: [], blood: [] },  // engine.js 拥有网格
  damageDir: { angle: 0, until: 0 },  // 受伤方向指示 (相对玩家朝向的角度)

  // ---- 经济 / 比分 ----
  money: 800,
  score: 0,
  allyKills: 0,
  ctScore: 0,
  lossStreak: 0,          // 连败次数, 决定负方回合奖励档位 (见 game.js LOSS_BONUS)
  tScore: 0,
  roundNum: 0,
  botsPerRound: 5,
  allyCount: 4,

  // ---- match structure (CS 1.5 competitive rules) ----
  // MR15: first to 16 wins, 30 rounds max, sides swap after round 15.
  // playerTeam records which side the player is on so the HUD can show
  // "CT" or "T" correctly after the half-time swap.
  playerTeam: 'ct',
  match: {
    roundsPerHalf: 15,     // MR15; set to 12 for MR12
    maxRounds: 30,         // roundsPerHalf * 2
    half: 1,               // 1 | 2
    half1CT: 0,            // first-half scores, kept for the totals
    half1T: 0,
    ctScoreTotal: 0,       // whole-match totals, NOT reset at half-time
    tScoreTotal: 0,
    over: false,
    winner: null,          // "ct" | "t" | "draw" | null
    overtime: false,       // 15:15 后进入 MR3 加时
    otCT: 0, otT: 0, otPlayed: 0,
  },

  // ---- 回合流程 / C4 ----
  round: {
    phase: 'freeze',       // 'freeze' | 'live' | 'over'
    freezeLeft: 4,         // 冻结时间 (秒)
    buyLeft: 15,           // 购买窗口剩余
  },
  plant: { active: false, progress: 0, near: false },  // 玩家下包 HUD

  BOMB: {
    state: 'live',           // live | planted | over
    roundLeft: 105,
    c4Left: 35,
    site: 'A',
    targetPos: null,
    pos: null,
    plant: 0,
    defuse: 0,
    allyDefuse: 0,
    beepAt: 0,
    carrier: null,           // Bot 对象 | 'player' | null
    drop: null,              // { pos:[x,y,z] } | null
    spawnLeft: 0,
    wasPlanted: false,       // 本回合是否下过包 (T 输了也有 +$800)
  },

  // ---- 实体 ----
  enemies: [],               // 敌方 bot
  allies: [],                // 己方 bot
  radarSpotted: Object.create(null),   // name -> 到期时间戳(秒)
  botKnownPos: null,         // [x,y,z] | null
  botKnownTime: -99,
  gunfireEvents: [],          // 1.5 秒内的枪声: {x,y,z,team,t,loud}
  lastRadioAt: -99,
  serial: 0,
  usedBotSpawns: new Set(),
  usedAllySpawns: new Set(),

  // ---- UI ----
  buyMenuOpen: false,
  scoreboardOpen: false,
  defuseHeld: false,
  shootingEnabled: true,
  redFlash: 0,
  whiteFlash: 0,
  hitMarker: '',
  hitMarkerUntil: 0,
  centerText: '',
  centerUntil: 0,
  centerColor: '#ffffff',

  // ---- 时间 ----
  time: 0,
  dt: 0,
  frame: 0,
  fov: BASE_FOV,
  started: false,
  paused: false,

  // ---- 跨模块钩子 (由各模块 init 时注册) ----
  hooks: {
    showCenter() {},
    addKill() {},
    killFeed() {},
    radio() {},
    hitText() {},
    updateAmmo() {},
    updateEquip() {},
    damagePlayer() {},
    onPlayerDeath() {},
    roundEnd() {},
    plantC4() {},
    dropC4() {},
    explodeC4() {},
    switchWeapon() {},
    reload() {},
    buy() {},
    throwNade() {},
    toggleBuy() {},
    spawnBots() {},
    clearBots() {},
    startRound() {},
    showSpectate() {},
    notifyGunfire() {},
    showMatchOver() {},
    restartMatch() {},
    startOvertime() {},
    applySettings() {},
    toggleSilencer() {},
    toggleGlockMode() {},
    pickupWeapon() {},
    cycleSpectate() {},
    toggleFreeCam() {},
  },
};

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
export const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
export const rand = (a, b) => a + Math.random() * (b - a);
export const randInt = (a, b) => Math.floor(rand(a, b + 1));
export const choice = arr => arr[Math.floor(Math.random() * arr.length)];
export const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
export const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export function forwardVec(yawDeg, pitchDeg = 0) {
  const y = yawDeg * Math.PI / 180, p = pitchDeg * Math.PI / 180;
  return [Math.sin(y) * Math.cos(p), -Math.sin(p), Math.cos(y) * Math.cos(p)];
}
export function rightVec(yawDeg) {
  const y = yawDeg * Math.PI / 180;
  return [Math.cos(y), 0, -Math.sin(y)];
}
export function yawTo(x, z) {
  return Math.atan2(x, z) * 180 / Math.PI;
}
export function fmtTime(sec) {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// pos 可选: 传入时由 WebAudio 走 PannerNode 做 3D 定位 (见 main.js initAudio)
export function play(name, pos = null) {
  if (S.audio) S.audio.play(name, pos);
}
export function showCenter(msg, color = '#ffffff', dur = 3) {
  S.centerText = msg;
  S.centerColor = color;
  S.centerUntil = S.time + dur;
  S.hooks.showCenter(msg, color, dur);
}
export function reportPlayer(pos) {
  S.botKnownPos = [pos[0], pos[1], pos[2]];
  S.botKnownTime = S.time;
}
// 枪声事件缓冲: bot 与玩家开火都会写入, 防守方据此判断该往哪边轮转。
export function notifyGunfire(pos, team, loud = 1) {
  if (!pos) return;
  if (!S.gunfireEvents) S.gunfireEvents = [];
  S.gunfireEvents.push({ x: pos[0], y: pos[1], z: pos[2], team, t: S.time, loud });
  while (S.gunfireEvents.length > 24) S.gunfireEvents.shift();
  const cut = S.time - 1.5;
  while (S.gunfireEvents.length && S.gunfireEvents[0].t < cut) S.gunfireEvents.shift();
}

export function heardGunfire(p, maxDist) {
  const evs = S.gunfireEvents || [];
  let best = null, bestD = Infinity;
  for (const e of evs) {
    if (S.time - e.t > 1.5) continue;
    const d = Math.hypot(e.x - p[0], e.z - p[2]);
    const range = maxDist * e.loud;
    if (d > range) continue;
    if (d < bestD) { bestD = d; best = e; }
  }
  return best ? { pos: [best.x, best.y, best.z], dist: bestD, team: best.team } : null;
}

export function radioContact(spotted, reporter) {
  const d = Math.round(dist3(spotted.pos, reporter.pos));
  S.radarSpotted[spotted.name] = S.time + 9;
  if (S.time - S.lastRadioAt > 7) {
    S.lastRadioAt = S.time;
    // 换边后玩家可能是 T, 报告的敌人也随之变成 CT
    const enemy = (S.playerTeam === 't') ? 'CT' : 'T';
    S.hooks.radio(`${reporter.name} 报告: 发现 ${enemy} 于 ${d}m 外`);
    play('radio_enemy');
  }
}
export function addKill(killer, victim, headshot, weaponId = null, icon = null) {
  S.hooks.addKill(killer, victim, headshot, weaponId, icon);
}
export function giveAmmo(wid) {
  const w = WEAPONS[wid];
  if (w && w.clip_size != null) S.ammo[wid] = [w.clip_size, w.reserve];
}
export function hitText(msg, dur = 0.08, color = null) {
  S.hitMarker = msg;
  S.hitMarkerUntil = S.time + dur;
  S.hitMarkerColor = color;
  S.hooks.hitText(msg, dur);
}

// 设置鼠标灵敏度倍率 (0.2 ~ 8), 同时更新用户基准值, 换回合/开镜后不会被重置
export function setSensitivity(mult) {
  const v = clamp(Number(mult) || 0, 0.2, 8);
  S.player.sensitivityBase = v;
  S.player.sensitivity = S.scoped ? v * 0.4 : v;
  return v;
}
