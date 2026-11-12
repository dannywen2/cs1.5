// web/main.js — DOM HUD / UI / WebAudio / 输入 / 主循环
// 静态服务器以「项目根目录」为根: /web/index.html, /assets/..., /sfx_*.wav, /radar_v2.png
// asset.js 里的 ROOT='../' / ASSET='../assets/' 相对模块 URL 解析, 无需 import map。
import * as A from './asset.js';
import { S, clamp, fmtTime, play, showCenter, setSensitivity } from './state.js';
import { initEngine, updateEngine, renderFrame, shoot } from './engine.js';
import {
  initGame, updateGame, nextRound, toggleBuyMenu, buyItem,
  switchWeapon, reloadWeapon, throwNade,
} from './game.js';

const $ = id => document.getElementById(id);

// 缓存的 DOM 节点; 任何缺失的 id 都是 undefined, 下面的 setter 全部做空值保护
const D = Object.create(null);
function grab(key, id) { D[key] = $(id || key); }

const show = (el, on) => { if (el) el.classList.toggle('hidden', !on); };
const setText = (el, v) => { if (el) el.textContent = String(v); };
const setColor = (el, c) => { if (el) el.style.color = c; };
const setOpacity = (el, v) => { if (el) el.style.opacity = String(clamp(v, 0, 1)); };

let canvas = null;
let lastTs = 0;
let buyWasOpen = false;
let shownWeapon = S.weapon;
let lastWeapon = null;

// toast 状态 (时间戳统一用 S.time, 由 game.js 的时钟驱动)
let radioMsg = '', radioUntil = 0;
let killMsg = '', killUntil = 0;
let spectateMsg = '';

// ---------------------------------------------------------------------------
// 音频: 每次 play() 都新建 BufferSource + Gain, 避免急促 beep / 枪声互相截断
// ---------------------------------------------------------------------------
function decodeBuffer(ctx, copy) {
  // 同时兼容返回 Promise 与旧式回调的 decodeAudioData 实现
  return new Promise((resolve, reject) => {
    let settled = false;
    const ok = b => { if (!settled) { settled = true; resolve(b); } };
    const bad = e => { if (!settled) { settled = true; reject(e); } };
    let r;
    try { r = ctx.decodeAudioData(copy, ok, bad); }
    catch (e) { bad(e); return; }
    if (r && typeof r.then === 'function') r.then(ok, bad);
  });
}

function initAudio() {
  const buffers = Object.create(null);
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) {
    console.warn('[audio] 浏览器不支持 Web Audio, 已静音运行');
    S.audio = { ctx: null, buffers, play() {} };
    return;
  }
  let ctx;
  try { ctx = new Ctor(); }
  catch (e) {
    console.warn('[audio] AudioContext 创建失败', e);
    S.audio = { ctx: null, buffers, play() {} };
    return;
  }

  const audio = {
    ctx,
    buffers,
    play(name) {
      const buf = buffers[name];
      if (!buf || !ctx || ctx.state === 'closed') return;
      try {
        if (ctx.state === 'suspended') {
          const r = ctx.resume();
          if (r && typeof r.catch === 'function') r.catch(() => {});
        }
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const gain = ctx.createGain();
        gain.gain.value = 0.7;
        src.connect(gain);
        gain.connect(ctx.destination);
        src.start(0);
        src.onended = () => {
          try { src.disconnect(); gain.disconnect(); } catch (_) { /* 已释放 */ }
        };
      } catch (e) { console.warn('[audio] play 失败', name, e); }
    },
  };
  // 先挂上, 让 initGame() 期间的 play() 调用不会抛错; 解码在后台完成
  S.audio = audio;

  const raw = (S.assets && S.assets.audio) || {};
  for (const [name, buf] of Object.entries(raw)) {
    if (!buf) continue;
    // decodeAudioData 会 detach 传入的 ArrayBuffer, 所以必须先复制一份
    const copy = (buf.slice ? buf.slice(0) : buf);
    decodeBuffer(ctx, copy).then(
      decoded => { buffers[name] = decoded; },
      err => { console.warn(`[audio] 解码失败: sfx_${name}.wav`, err); },
    );
  }
}

function resumeAudio() {
  const ctx = S.audio && S.audio.ctx;
  if (ctx && ctx.state === 'suspended') {
    try {
      const r = ctx.resume();
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch (_) { /* noop */ }
  }
}

// ---------------------------------------------------------------------------
// HUD 钩子
//
// engine.js 在 initEngine() 里直接赋值 S.hooks.switchWeapon / S.hooks.shoot;
// game.js 在 initGame() 里用 registerHook() 把「注册前已有的实现」存进
// prevHooks, 之后通过 callUI() 转发给展示层。因此 HUD 必须在 initEngine()
// 之后、initGame() 之前注册, 且用「包裹」而非「替换」的方式写入钩子,
// 这样既不会丢掉 engine 的实现, 也不会被 game.js 的 reconcileHooks() 抹掉。
// ---------------------------------------------------------------------------
function wrapHook(name, fn) {
  const prev = typeof S.hooks[name] === 'function' ? S.hooks[name] : null;
  S.hooks[name] = (...args) => {
    if (prev) {
      try { prev(...args); } catch (e) { console.warn(`[hud] hook ${name} 前置调用失败`, e); }
    }
    try { fn(...args); } catch (e) { console.warn(`[hud] hook ${name} 失败`, e); }
  };
}

function showKillFeed(killer, victim, headshot) {
  killMsg = `${String(killer)}  ${headshot ? '爆头' : '击杀'}  ${String(victim)}`;
  killUntil = S.time + 2.6;
  setText(D.killfeed, killMsg);
  show(D.killfeed, true);
}

function refreshAmmo() {
  const wp = A.WEAPONS[S.weapon];
  setText(D.weaponText, wp ? wp.name : String(S.weapon));
  if (!wp || wp.clip_size == null) {
    setText(D.ammoText, '--');
  } else {
    const a = S.ammo[S.weapon] || [0, 0];
    setText(D.ammoText, `${a[0]} / ${a[1]}`);
  }
}

function refreshEquip() {
  setText(D.armorText, `AP ${Math.round(S.player.armor || 0)}`);
  setColor(D.armorText, (S.player.armor || 0) > 0 ? '#96c8ff' : '#737373');
  const n = S.player.nades || { he: 0, flash: 0 };
  setText(D.nadeText, `HE x${n.he || 0}  闪 x${n.flash || 0}`);
  if (S.player.hasKit) {
    setText(D.kitText, '拆弹钳  已装备 (5s)');
    setColor(D.kitText, '#82ff96');
  } else {
    setText(D.kitText, '拆弹钳  无 (10s)');
    setColor(D.kitText, '#f0e196');
  }
  setText(D.moneyText, `$ ${S.money}`);
}

function updatePointerHint() {
  show(D.pointerHint, !!S.started && !S.pointerLocked && !S.buyMenuOpen);
}

function syncBuyUI(explicitOpen) {
  const open = explicitOpen === undefined ? !!S.buyMenuOpen : !!explicitOpen;
  const changed = open !== buyWasOpen;
  show(D.buyMenu, open);
  setText(D.buyMoney, `$ ${S.money}`);
  if (open) {
    if (document.pointerLockElement === canvas) exitLock();
  } else if (changed && buyWasOpen && S.started && !S.pointerLocked && !document.hidden) {
    requestLock();
  }
  buyWasOpen = open;
  updatePointerHint();
}

function initHUD() {
  grab('loading', 'loading'); grab('bar', 'bar'); grab('loadLabel', 'load-label');
  grab('start', 'start'); grab('startBtn', 'start-btn'); grab('fatal', 'fatal');
  grab('killText', 'kill-text'); grab('roundText', 'round-text');
  grab('enemyText', 'enemy-text'); grab('sideText', 'side-text');
  grab('allyText', 'ally-text');
  grab('kitText', 'kit-text'); grab('armorText', 'armor-text');
  grab('moneyText', 'money-text'); grab('hpText', 'hp-text');
  grab('timerText', 'timer-text'); grab('objectiveText', 'objective-text');
  grab('slotText', 'slot-text');
  grab('nadeText', 'nade-text'); grab('weaponText', 'weapon-text');
  grab('ammoText', 'ammo-text');
  grab('crosshair', 'crosshair'); grab('scopeOverlay', 'scope-overlay');
  grab('radar', 'radar'); grab('radarCanvas', 'radar-canvas');
  grab('radio', 'radio'); grab('killfeed', 'killfeed'); grab('hitText', 'hit-text');
  grab('centerText', 'center-text'); grab('reloadText', 'reload-text');
  grab('spectateText', 'spectate-text');
  grab('defuseHint', 'defuse-hint'); grab('defuseBarBg', 'defuse-bar-bg');
  grab('defuseBar', 'defuse-bar'); grab('pointerHint', 'pointer-hint');
  grab('scoreboard', 'scoreboard'); grab('sbTitle', 'sb-title');
  grab('sbBody', 'sb-body'); grab('sbHint', 'sb-hint');
  grab('buyMenu', 'buy-menu'); grab('buyTitle', 'buy-title');
  grab('buyMoney', 'buy-money'); grab('redFlash', 'red-flash');
  grab('whiteFlash', 'white-flash');

  canvas = $('game');
  shownWeapon = S.weapon;
  lastWeapon = null;

  wrapHook('showCenter', () => {
    setText(D.centerText, S.centerText || '');
    setColor(D.centerText, S.centerColor || '#ffffff');
    show(D.centerText, !!S.centerText && S.time < (S.centerUntil || 0));
  });
  wrapHook('addKill', showKillFeed);
  wrapHook('killFeed', showKillFeed);   // game.js notifyKill 两条路径都覆盖 (同内容幂等)
  wrapHook('radio', msg => {
    radioMsg = String(msg || '');
    radioUntil = S.time + 3.2;
    setText(D.radio, radioMsg);
    show(D.radio, !!radioMsg);
  });
  wrapHook('hitText', msg => {
    // state.js hitText() 已写好 S.hitMarker / S.hitMarkerUntil, 这里只需立即显示
    setText(D.hitText, String(msg || ''));
    show(D.hitText, !!msg);
  });
  wrapHook('updateAmmo', refreshAmmo);
  wrapHook('updateEquip', refreshEquip);
  wrapHook('showSpectate', msg => {
    spectateMsg = String(msg || '');
    setText(D.spectateText, spectateMsg);
    show(D.spectateText, !!spectateMsg && !!S.player.dead);
  });
  wrapHook('toggleBuy', open => syncBuyUI(!!open));
  wrapHook('buy', () => { setText(D.buyMoney, `$ ${S.money}`); });

  setText(D.slotText, '1 主武器 2 手枪 3 匕首 | G 手雷 F 闪光 | E 拆弹 | B 购买 | [ ] 灵敏度 | Tab 计分 | ESC 退出');
  setText(D.sbHint, '松开 Tab 关闭');
  setText(D.buyTitle, '— 购买装备 —');
  refreshAmmo();
  refreshEquip();

  S.hud = {
    updateHUD, refreshAmmo, refreshEquip, drawRadar, syncBuyUI,
    showCenter, nextRound,   // 调试台可手动开新回合 / 显示提示
  };
}

// ---------------------------------------------------------------------------
// AWP 开镜
// ---------------------------------------------------------------------------
// 灵敏度是"倍率": 开镜时降到 base * 0.4 (AWP 需要更精细的微调), 关镜恢复用户值。
const SCOPE_SENS_SCALE = 0.4;

function applySensitivity(scoped) {
  const base = Number.isFinite(S.player.sensitivityBase) ? S.player.sensitivityBase : 2.0;
  S.player.sensitivity = scoped ? base * SCOPE_SENS_SCALE : base;
}

function setScope(on) {
  const active = !!on && S.weapon === 'awp' && !S.player.dead;
  if (active === !!S.scoped) {
    applySensitivity(active);
    return;
  }
  S.scoped = active;
  S.player.scoped = active;
  applySensitivity(active);
  if (active) play('reload');          // 与原版一致: 开镜用咔哒声
}

// 右键按住开镜 (main.py set_scope(True/False)); toggleScope() 供外部/调试调用。
function toggleScope(on) {
  setScope(on === undefined ? !S.scoped : !!on);
}

// ---------------------------------------------------------------------------
// 雷达: 旋转俯视贴图 + 敌人/队友/C4/中心箭头
// ---------------------------------------------------------------------------
const RADAR_R = 100;                 // canvas 半径 (200x200)
const RADAR_RANGE = 900;             // 显示半径 (世界单位)
const RADAR_SCALE = RADAR_R / RADAR_RANGE;
const RPAD = 8;                      // radar_v2.png 的 padding (格), 与 main.py 一致

let radarMap = null, radarMapW = 0, radarMapH = 0, radarCtx = null;

function getRadarMap() {
  if (radarMap) return radarMap;
  const img = S.assets && S.assets.radarTexture && S.assets.radarTexture.image;
  if (!img) return null;
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) return null;
  radarMapW = w;
  radarMapH = h;
  try {
    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    const octx = off.getContext('2d');
    if (!octx) return null;
    octx.drawImage(img, 0, 0, w, h);
    radarMap = off;
  } catch (e) {
    // 跨域/未解码时退回到直接绘制原图
    console.warn('[radar] 离屏贴图建立失败, 直接绘制原图', e);
    radarMap = img;
  }
  return radarMap;
}

function radarAlive(bot) {
  return !!(bot && bot.enabled !== false && bot.health > 0
    && !(bot.dead === true) && Array.isArray(bot.pos));
}

function enemySpotted(bot, px, py, pz) {
  if ((S.radarSpotted[bot.name] || 0) > S.time) return true;
  if (S.player.dead) return false;
  const dx = bot.pos[0] - px, dz = bot.pos[2] - pz;
  if (Math.hypot(dx, dz) >= RADAR_RANGE) return false;
  const eye = { x: px, y: py + A.EYE_HEIGHT, z: pz };
  const target = { x: bot.pos[0], y: bot.pos[1] + A.EYE_HEIGHT, z: bot.pos[2] };
  if (typeof A.gridClear === 'function' && A.gridClear(eye, target, 10)) {
    S.radarSpotted[bot.name] = S.time + 6;
    return true;
  }
  return false;
}

function drawRadar() {
  const c = D.radarCanvas;
  if (!c) return;
  if (!radarCtx) radarCtx = c.getContext('2d');
  const ctx = radarCtx;
  if (!ctx) return;

  const p = S.player.pos;
  const px = p[0], py = p[1], pz = p[2];
  const yaw = (S.player.yaw || 0) * Math.PI / 180;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, 200, 200);
  ctx.save();
  ctx.beginPath();
  ctx.arc(RADAR_R, RADAR_R, RADAR_R - 1, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = '#081c0c';
  ctx.fillRect(0, 0, 200, 200);

  const map = getRadarMap();
  if (map) {
    // radar_uv: cx=(x-NAV_WX0)/16, cy=(z-NAV_WY0)/16,
    // u=(cx+8)/(304+16), v=1-(cy+8)/(350+16) —— 反算玩家所在的贴图像素坐标。
    // 逻辑系 (x 右, z 前) 相对屏幕 (x 右, y 下) 是反射, 所以贴图 y 要取负;
    // 再旋转 -yaw, 玩家正前方 forward=(sin yaw, cos yaw) 就落在圆盘上方。
    const kx = radarMapW / (A.W + 2 * RPAD);      // 每格像素 (烘焙为 3)
    const ky = radarMapH / (A.H + 2 * RPAD);
    const up = ((px - A.NAV_WX0) / A.CELL + RPAD) * kx;
    const vp = ((pz - A.NAV_WY0) / A.CELL + RPAD) * ky;
    const mx = RADAR_SCALE * A.CELL / kx;
    const my = RADAR_SCALE * A.CELL / ky;
    ctx.save();
    ctx.translate(RADAR_R, RADAR_R);
    ctx.rotate(-yaw);
    ctx.scale(mx, -my);
    ctx.globalAlpha = 0.94;
    ctx.drawImage(map, -up, -vp, radarMapW, radarMapH);
    ctx.restore();
    ctx.fillStyle = 'rgba(4, 16, 8, .22)';
    ctx.fillRect(0, 0, 200, 200);
  }

  // 世界坐标 -> 雷达画布坐标: 右分量 sx, 前分量 sy (前 = 屏幕上方)
  const project = pos => {
    const dx = pos[0] - px, dz = pos[2] - pz;
    const sx = (dx * cy - dz * sy) * RADAR_SCALE;
    const fy = (dx * sy + dz * cy) * RADAR_SCALE;
    return [RADAR_R + sx, RADAR_R - fy];
  };
  const dot = (x, y, r, color) => {
    if ((x - RADAR_R) ** 2 + (y - RADAR_R) ** 2 > (RADAR_R - 3) ** 2) return;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  };

  for (const bot of (S.enemies || [])) {
    if (!radarAlive(bot) || !enemySpotted(bot, px, py, pz)) continue;
    const [x, y] = project(bot.pos);
    dot(x, y, 3.6, '#ff4646');
  }
  for (const bot of (S.allies || [])) {
    if (!radarAlive(bot)) continue;
    const [x, y] = project(bot.pos);
    dot(x, y, 3.2, '#5aeb78');
  }
  const B = S.BOMB;
  if (B.state === 'planted' && B.pos) {
    const [x, y] = project(B.pos);
    const blink = Math.floor(S.time * 4) % 2;
    dot(x, y, 5, blink ? '#ffdc46' : '#ff463c');
  }

  // 方位刻度
  ctx.fillStyle = 'rgba(150, 200, 150, .8)';
  ctx.fillRect(RADAR_R - 2, 4, 4, 6);
  ctx.fillRect(RADAR_R - 2, 190, 4, 6);
  ctx.fillRect(4, RADAR_R - 2, 6, 4);
  ctx.fillRect(190, RADAR_R - 2, 6, 4);

  // 中心白色箭头 (永远朝上)
  ctx.beginPath();
  ctx.moveTo(RADAR_R, RADAR_R - 12);
  ctx.lineTo(RADAR_R - 7, RADAR_R + 7);
  ctx.lineTo(RADAR_R + 7, RADAR_R + 7);
  ctx.closePath();
  ctx.fillStyle = '#f0fff0';
  ctx.fill();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// 每帧 HUD
// ---------------------------------------------------------------------------
function held(...names) {
  for (const n of names) if (S.keys[n] === true || S.keys[n] === 1) return true;
  return false;
}

function updateScoreboard() {
  show(D.scoreboard, !!S.scoreboardOpen);
  if (!S.scoreboardOpen) return;
  const B = S.BOMB;
  const ctAlive = (S.player.dead ? 0 : 1) + (S.allies || []).length;
  setText(D.sbTitle, `CS 1.5  爆破模式   |   CT  ${S.ctScore} : ${S.tScore}  T`);
  setText(D.sbBody,
    `回合 ${S.roundNum}      ${B.site} 点\n\n` +
    `CT  存活 ${ctAlive} / 5      T  存活 ${(S.enemies || []).length} / ${S.botsPerRound}\n` +
    `你   击杀 ${S.score}     队友击杀 ${S.allyKills}\n` +
    `C4  ${B.state}      资金 $ ${S.money}`);
}

function updateHUD() {
  const B = S.BOMB;
  const p = S.player;
  const now = S.time;

  setText(D.killText, `击杀: ${S.score}`);
  setText(D.roundText, `回合 ${S.roundNum}`);
  setText(D.enemyText, `敌人: ${(S.enemies || []).length}`);
  setText(D.sideText, 'CT  防守');
  setText(D.allyText, `队友: ${(S.allies || []).length}`);

  if (B.state === 'planted') {
    setText(D.timerText, `C4  ${fmtTime(B.c4Left)}`);
    setColor(D.timerText, '#ff5f50');
    setText(D.objectiveText, `拆除 C4  ·  ${B.site} 点`);
  } else {
    const left = Math.max(0, B.roundLeft);
    setText(D.timerText, fmtTime(left));
    setColor(D.timerText, left <= 20 ? '#ff8c5a' : '#e1eeff');
    setText(D.objectiveText, B.plant > 0
      ? `T 正在 ${B.site} 点安放 C4 ...`
      : `阻止 T 在 ${B.site} 点安放 C4`);
  }

  refreshEquip();
  setText(D.hpText, `HP ${p.hp}`);
  setColor(D.hpText, p.hp > 60 ? '#78ff78' : (p.hp > 30 ? '#ffdc50' : '#ff5a5a'));
  refreshAmmo();

  // toast 可见性全部由 S.*Until 时间戳驱动
  show(D.centerText, !!S.centerText && now < (S.centerUntil || 0));
  if (S.centerText) {
    setText(D.centerText, S.centerText);
    setColor(D.centerText, S.centerColor || '#ffffff');
  }
  show(D.radio, !!radioMsg && now < radioUntil);
  show(D.killfeed, !!killMsg && now < killUntil);
  // state.js hitText() 是唯一来源: 它同时写入 S.hitMarker / S.hitMarkerUntil
  // 并触发 HUD 钩子, 所以这里直接读 S.* 即可, 无需另存一份时间戳。
  const hm = S.hitMarker || '';
  show(D.hitText, !!hm && now < (S.hitMarkerUntil || 0));
  if (hm) setText(D.hitText, hm);
  show(D.reloadText, !!S.reloading);
  show(D.spectateText, !!spectateMsg && !!p.dead);

  // 拆弹提示 + 进度条
  let defuseNear = false;
  if (B.state === 'planted' && B.pos && !p.dead && !S.buyMenuOpen) {
    const flat = Math.hypot(p.pos[0] - B.pos[0], p.pos[2] - B.pos[2]);
    defuseNear = flat < A.DEFUSE_RANGE && Math.abs(p.pos[1] - B.pos[1]) < 48;
  }
  show(D.defuseHint, defuseNear);
  show(D.defuseBarBg, defuseNear);
  show(D.defuseBar, defuseNear);
  if (defuseNear) {
    const need = p.hasKit ? A.KIT_DEFUSE_TIME : A.DEFUSE_TIME;
    const tag = p.hasKit ? '拆弹钳 5s' : '无钳 10s';
    setText(D.defuseHint, S.defuseHeld
      ? `拆除中 [${tag}]  还需 ${Math.max(0, need - B.defuse).toFixed(1)}s`
      : `按住 E 拆除 C4  (${tag})`);
    if (D.defuseBar) D.defuseBar.style.width = `${clamp(B.defuse / need, 0, 1) * 100}%`;
  } else if (D.defuseBar) {
    D.defuseBar.style.width = '0%';
  }

  // 闪屏: game.js updateGame() 每帧已按 220/170 衰减 S.redFlash / S.whiteFlash,
  // 这里只负责显示, 避免重复衰减; 仅在暂停(游戏未推进)时兜底衰减。
  if (S.paused) {
    S.redFlash = Math.max(0, (S.redFlash || 0) - S.dt * 220);
    S.whiteFlash = Math.max(0, (S.whiteFlash || 0) - S.dt * 170);
  }
  setOpacity(D.redFlash, (S.redFlash || 0) / 90);
  setOpacity(D.whiteFlash, (S.whiteFlash || 0) / 255);

  // 准星: gap 是 Ursina UI 纵向比例, 换算成屏幕像素
  const moving = held('w', 'a', 's', 'd', 'KeyW', 'KeyA', 'KeyS', 'KeyD');
  const gap = 0.012 + (moving ? 0.007 : 0) + (S.crossHeat || 0) * 0.007;
  if (D.crosshair) {
    D.crosshair.style.setProperty('--gap', `${(gap * (window.innerHeight || 600)).toFixed(1)}px`);
  }
  if (S.scoped && (S.weapon !== 'awp' || p.dead)) setScope(false);
  show(D.crosshair, !S.scoped && !S.buyMenuOpen && !p.dead);
  show(D.scopeOverlay, !!S.scoped && S.weapon === 'awp');
  S.player.sensitivity = S.scoped ? S.player.sensitivityBase * SCOPE_SENS_SCALE : S.player.sensitivityBase;

  // Q 上一把武器: 记录武器切换历史 (包括购买 / 阵亡引起的切换)
  if (shownWeapon !== S.weapon) {
    if (shownWeapon && S.owned[shownWeapon]) lastWeapon = shownWeapon;
    shownWeapon = S.weapon;
  }

  updateScoreboard();
  syncBuyUI();
  updatePointerHint();

  if (S.frame % 3 === 0 || S.frame < 2) drawRadar();   // 最多每 3 帧重绘一次
}

// ---------------------------------------------------------------------------
// 输入
// ---------------------------------------------------------------------------
const ALIAS = {
  KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd',
  ShiftLeft: 'shift', ShiftRight: 'shift',
  ControlLeft: 'control', ControlRight: 'control',
  Space: 'space', KeyE: 'e', KeyR: 'r', KeyB: 'b',
  KeyG: 'g', KeyF: 'f', KeyQ: 'q', Tab: 'tab',
  Digit1: '1', Digit2: '2', Digit3: '3',
  BracketLeft: '[', BracketRight: ']',
  ArrowUp: 'arrowup', ArrowDown: 'arrowdown',
  ArrowLeft: 'arrowleft', ArrowRight: 'arrowright',
};

function codeOf(e) {
  if (e.code) return e.code;
  const k = String(e.key || '').toLowerCase();
  const fallback = {
    w: 'KeyW', a: 'KeyA', s: 'KeyS', d: 'KeyD',
    r: 'KeyR', b: 'KeyB', e: 'KeyE', f: 'KeyF', g: 'KeyG', q: 'KeyQ',
    '1': 'Digit1', '2': 'Digit2', '3': 'Digit3',
    ' ': 'Space', spacebar: 'Space', shift: 'ShiftLeft',
    control: 'ControlLeft', ctrl: 'ControlLeft', tab: 'Tab', escape: 'Escape',
    arrowup: 'ArrowUp', arrowdown: 'ArrowDown',
    arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
  };
  return fallback[k] || e.key;
}

function setKey(code, down) {
  S.keys[code] = down;
  const alias = ALIAS[code];
  if (alias) S.keys[alias] = down;
  if (code.length === 1) S.keys[code.toUpperCase()] = down;
}

function requestLock() {
  if (!canvas || document.pointerLockElement === canvas) return;
  try {
    const r = canvas.requestPointerLock();
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch (_) { /* 浏览器拒绝时由 #pointer-hint 提示再次点击 */ }
}

function exitLock() {
  if (document.pointerLockElement) {
    try { document.exitPointerLock(); } catch (_) { /* noop */ }
  }
}

function selectWeapon(wid) {
  if (wid && S.owned[wid]) switchWeapon(wid);
}

function initInput() {
  canvas = canvas || $('game');

  document.addEventListener('pointerlockchange', () => {
    S.pointerLocked = document.pointerLockElement === canvas;
    if (!S.pointerLocked) {
      S.mouseDX = 0; S.mouseDY = 0;
      S.mouseDown = false; S.rightDown = false;
      setScope(false);
    }
    // 不暂停回合时间; 鼠标未锁定时仅忽略鼠标输入。
    S.paused = document.hidden === true;
    updatePointerHint();
  });
  document.addEventListener('pointerlockerror', () => {
    console.warn('[input] 指针锁定失败, 点击画面重试');
  });
  document.addEventListener('visibilitychange', () => {
    S.paused = document.hidden === true;
    if (document.hidden) {
      S.mouseDown = false; S.rightDown = false;
      S.scoreboardOpen = false;
    }
  });

  document.addEventListener('mousemove', e => {
    if (!S.pointerLocked || S.buyMenuOpen) return;
    S.mouseDX += e.movementX || 0;
    S.mouseDY += e.movementY || 0;
  });
  document.addEventListener('mouseup', e => {
    if (e.button === 0) S.mouseDown = false;
    if (e.button === 2) { S.rightDown = false; setScope(false); }
  });
  document.addEventListener('contextmenu', e => e.preventDefault());

  if (canvas) {
    canvas.addEventListener('mousedown', e => {
      e.preventDefault();
      if (!S.started || S.buyMenuOpen) return;
      if (!S.pointerLocked) { requestLock(); return; }
      if (e.button === 0) {
        S.mouseDown = true;
        if (typeof S.hooks.shoot === 'function') S.hooks.shoot();
        else shoot();
      } else if (e.button === 2) {
        S.rightDown = true;
        setScope(true);              // 按住右键开镜, 松开 / 丢失锁定即关闭
      }
    });
  }

  document.addEventListener('keydown', e => {
    const code = codeOf(e);
    setKey(code, true);
    resumeAudio();
    if (!S.started) return;              // 开始遮罩期间不响应游戏按键

    if (code === 'Tab') { e.preventDefault(); S.scoreboardOpen = true; return; }
    if (code === 'Escape') { exitLock(); return; }

    if (e.repeat) return;                 // 一次性动作忽略按键重复
    if (pIsDeadOrOver()) return;
    if (code === 'KeyB') { toggleBuyMenu(); return; }
    if (S.buyMenuOpen) return;

    if (code === 'KeyE') { S.defuseHeld = true; return; }
    if (code === 'KeyR') { reloadWeapon(); return; }
    // 鼠标灵敏度: [ 降低 / ] 提高 (每档 20%), 右下角 HUD 会显示当前倍率
    if (code === 'BracketLeft' || code === 'BracketRight') {
      const cur = Number.isFinite(S.player.sensitivityBase) ? S.player.sensitivityBase : 2.0;
      const next = setSensitivity(code === 'BracketLeft' ? cur * 0.8 : cur * 1.2);
      showCenter(`鼠标灵敏度 ${next.toFixed(2)}`, '#b4d2ff', 1.0);
      return;
    }
    if (code === 'Digit1') {
      // 主武器: 与原版一致, AWP 优先于 AK-47; 都没买则无动作
      if (S.owned.awp) selectWeapon('awp');
      else if (S.owned.ak47) selectWeapon('ak47');
      return;
    }
    if (code === 'Digit2') { selectWeapon('usp'); return; }
    if (code === 'Digit3') { selectWeapon('knife'); return; }
    if (code === 'KeyQ') { selectWeapon(lastWeapon); return; }
    if (code === 'KeyG') { throwNade('he'); return; }
    if (code === 'KeyF') { throwNade('flash'); return; }
  });

  document.addEventListener('keyup', e => {
    const code = codeOf(e);
    setKey(code, false);
    if (code === 'Tab') { e.preventDefault(); S.scoreboardOpen = false; return; }
    if (code === 'KeyE') S.defuseHeld = false;
  });

  window.addEventListener('blur', () => {
    for (const k of Object.keys(S.keys)) S.keys[k] = false;
    S.mouseDown = false; S.rightDown = false;
    S.defuseHeld = false; S.scoreboardOpen = false;
    S.mouseDX = 0; S.mouseDY = 0;
    setScope(false);
  });

  // 购买按钮: 用委托, 静态 #buy-menu 不存在时也不会崩
  document.addEventListener('click', e => {
    const btn = e.target && e.target.closest ? e.target.closest('[data-buy]') : null;
    if (!btn || !btn.getAttribute) return;
    const id = btn.getAttribute('data-buy');
    if (!id) return;
    resumeAudio();
    buyItem(id);
  });

  // 未锁定鼠标时点击画面即可重新锁定 (ESC 之后再次进入)
  if (canvas) {
    canvas.addEventListener('click', () => {
      if (S.started && !S.buyMenuOpen && !S.pointerLocked) requestLock();
    });
  }

  if (D.startBtn) {
    D.startBtn.addEventListener('click', () => {
      resumeAudio();
      S.started = true;
      S.paused = false;
      show(D.start, false);
      show(D.loading, false);
      requestLock();
    });
  }
  // 任意首次手势也尝试恢复 AudioContext (浏览器自动播放策略兜底)
  document.addEventListener('pointerdown', resumeAudio, { once: true });
  document.addEventListener('keydown', resumeAudio, { once: true });
}

function pIsDeadOrOver() {
  return !!S.player.dead || S.BOMB.state === 'over';
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
function onProgress(fraction, label, done, total) {
  const f = clamp(Number.isFinite(fraction) ? fraction : 0, 0, 1);
  const bar = D.bar || $('bar');
  const lab = D.loadLabel || $('load-label');
  if (bar) bar.style.width = `${(f * 100).toFixed(1)}%`;
  setText(lab, f >= 1
    ? '加载完成, 准备进入战场...'
    : `正在加载原版资源... ${done}/${total} · ${label}`);
}

function showFatal(err) {
  const msg = (err && (err.stack || err.message)) || String(err);
  const el = D.fatal || $('fatal');
  setText(el,
    '启动失败 / Failed to start\n\n' + String(msg) +
    '\n\n请从项目根目录启动静态 HTTP 服务, 然后通过 /web/index.html 访问。\n' +
    '例如: python -m http.server 8000');
  show(el, true);
  show(D.loading || $('loading'), false);
}

// 时钟归属说明:
// state.js 只保存 S.time, 不自增。game.js 的 updateGame() -> syncClock() 会在
// 宿主没有推进时间时自行 S.time += dt、S.dt = dt、S.frame += 1; 当宿主已推进时
// 则只补帧号。按任务约定的「若 game.js 递增 S.time 就不要在这里递增」规则,
// 主循环只设置 S.dt, 把 S.time / S.frame 的所有权完全交给 game.js, 从而避免
// 双计时。所有 S.*Until 时间戳与 S.frame 因此共享同一时钟。
function loop(ts) {
  const dt = lastTs ? clamp((ts - lastTs) / 1000, 0, 0.05) : 0;
  lastTs = ts;
  S.dt = dt;

  if (S.started && !S.paused) {
    updateEngine(dt);
    updateGame(dt);      // 内部 syncClock() 推进 S.time / S.frame
    updateHUD();
    renderFrame();
  } else {
    renderFrame();       // 开始遮罩后面仍能看到世界
  }
  requestAnimationFrame(loop);
}

async function boot() {
  try {
    const assets = await A.loadAll(onProgress);
    S.assets = assets;
    initEngine($('game'));
    initAudio();
    initHUD();
    initInput();
    initGame();           // 必须在 initHUD() 之后: game.js 会把 HUD 钩子存为 prevHooks
    syncBuyUI(false);     // 确保购买菜单初始隐藏 (nextRound 会调用 toggleBuy(false))
    show(D.loading, false);

    // 无头浏览器自动化 / 截图用: ?auto=1 跳过用户手势遮罩, ?pos=x,y,z,yaw,pitch
    // 可固定相机; 正式游玩不受影响。
    const _q = new URLSearchParams(location.search);
    if (_q.get('auto') === '1') {
      S.started = true;
      S.paused = false;
      const pv = (_q.get('pos') || '').split(',').map(Number);
      if (pv.length >= 5 && pv.every(Number.isFinite)) {
        S.player.pos = [pv[0], pv[1], pv[2]];
        S.player.yaw = pv[3];
        S.player.pitch = pv[4];
      }
      window.__CS_READY__ = true;
    } else {
      show(D.start, true);  // 等待用户手势以启用 Pointer Lock / WebAudio
    }
    window.__CS_BOOTED__ = true;
    window.__CS__ = { S, A };   // 便于无头测试/调试读取状态
    requestAnimationFrame(loop);
  } catch (err) {
    showFatal(err);
    throw err;
  }
}

function onReady(fn) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn, { once: true });
  } else {
    fn();
  }
}

onReady(() => {
  boot().catch(err => console.error('[boot] 启动失败', err));   // 重新抛到控制台
});