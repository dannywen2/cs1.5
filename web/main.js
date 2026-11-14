// web/main.js — DOM HUD / UI / WebAudio / 输入 / 主循环
// 静态服务器以「项目根目录」为根: /web/index.html, /assets/..., /radar_v2.png
// asset.js 里的 ROOT='../' / ASSET='../assets/' 相对模块 URL 解析, 无需 import map。
import * as A from './asset.js';
import { S, clamp, fmtTime, play, showCenter, setSensitivity } from './state.js';
import { initEngine, updateEngine, renderFrame, shoot } from './engine.js';
import {
  initGame, updateGame, nextRound, toggleBuyMenu, buyItem, canBuyItem,
  switchWeapon, reloadWeapon, throwNade, BUY_CATEGORIES,
} from './game.js';

const $ = id => document.getElementById(id);

// 缓存的 DOM 节点; 任何缺失的 id 都是 undefined, 下面的 setter 全部做空值保护
const D = Object.create(null);
function grab(key, id) { D[key] = $(id || key); }

const show = (el, on) => { if (el) el.classList.toggle('hidden', !on); };
const setText = (el, v) => { if (el) el.textContent = String(v); };
const setColor = (el, c) => { if (el) el.style.color = c; };
const setOpacity = (el, v) => { if (el) el.style.opacity = String(clamp(v, 0, 1)); };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const OVERVIEW_URL = '../assets/overviews/dust2.png';
const SPRITE_URL = name => `../assets/sprites/${name}.png`;
const SETTINGS_KEY = 'cs15_settings';

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
// 设置持久化
// ---------------------------------------------------------------------------
function loadSettings() {
  const defaults = {
    sensitivity: 2.0, volume: 0.8, fov: A.BASE_FOV,
    botCount: 5, difficulty: 1, roundsPerHalf: 15, positional: true,
  };
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}; }
  catch (_) { saved = {}; }
  for (const k of Object.keys(defaults)) {
    const v = saved[k];
    if (typeof v === typeof defaults[k] && Number.isFinite(defaults[k]) ? Number.isFinite(v) : true) {
      S.settings[k] = v;
    }
  }
  S.settings.sensitivity = clamp(Number(S.settings.sensitivity) || 2, 0.2, 8);
  S.settings.volume = clamp(Number(S.settings.volume), 0, 1);
  S.settings.fov = clamp(Number(S.settings.fov) || A.BASE_FOV, 70, 110);
  S.settings.botCount = clamp(Math.round(Number(S.settings.botCount) || 5), 3, 8);
  S.settings.difficulty = clamp(Number(S.settings.difficulty) || 1, 0.5, 2);
  S.settings.roundsPerHalf = [9, 12, 15].includes(Number(S.settings.roundsPerHalf))
    ? Number(S.settings.roundsPerHalf) : 15;
  S.settings.positional = S.settings.positional !== false;
  S.baseFov = S.settings.fov;
  setSensitivity(S.settings.sensitivity);
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(S.settings)); }
  catch (_) { /* 隐私模式下不可写, 只影响下次启动 */ }
}

// ---------------------------------------------------------------------------
// 音频: 每次 play() 都新建 BufferSource + Gain (+ Panner 做 3D 定位)
// ---------------------------------------------------------------------------
function decodeBuffer(ctx, copy) {
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

function xyz(p) {
  if (!p) return null;
  if (Array.isArray(p)) return [p[0] || 0, p[1] || 0, p[2] || 0];
  if (Number.isFinite(p.x)) return [p.x, p.y || 0, p.z || 0];
  return null;
}

function initAudio() {
  const buffers = Object.create(null);
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) {
    console.warn('[audio] 浏览器不支持 Web Audio, 已静音运行');
    S.audio = { ctx: null, buffers, play() {}, setVolume() {}, updateListener() {} };
    return;
  }
  let ctx;
  try { ctx = new Ctor(); }
  catch (e) {
    console.warn('[audio] AudioContext 创建失败', e);
    S.audio = { ctx: null, buffers, play() {}, setVolume() {}, updateListener() {} };
    return;
  }

  let master = null;
  try {
    master = ctx.createGain();
    master.gain.value = Number(S.settings && S.settings.volume) || 0;
    master.connect(ctx.destination);
  } catch (_) { master = null; }

  const audio = {
    ctx, buffers, master,
    setVolume(v) {
      const x = clamp(Number(v) || 0, 0, 1);
      if (master) master.gain.value = x;
    },
    // 3D 定位: 每帧由 engine.js 用相机位置/朝向同步 listener
    updateListener(pos, forward) {
      if (!ctx || !ctx.listener) return;
      const q = xyz(pos);
      if (!q) return;
      const L = ctx.listener;
      const t = ctx.currentTime || 0;
      try {
        if (L.positionX) {
          L.positionX.setValueAtTime(q[0], t);
          L.positionY.setValueAtTime(q[1], t);
          L.positionZ.setValueAtTime(q[2], t);
          const f = Array.isArray(forward) ? forward : [0, 0, 1];
          if (L.forwardX) {
            L.forwardX.setValueAtTime(f[0], t);
            L.forwardY.setValueAtTime(f[1] || 0, t);
            L.forwardZ.setValueAtTime(f[2], t);
            L.upX.setValueAtTime(0, t);
            L.upY.setValueAtTime(1, t);
            L.upZ.setValueAtTime(0, t);
          }
        } else {
          if (L.setPosition) L.setPosition(q[0], q[1], q[2]);
          if (L.setOrientation) L.setOrientation(forward[0], forward[1] || 0, forward[2], 0, 1, 0);
        }
      } catch (_) { /* 某些实现不支持 AudioParam 形式 */ }
    },
    play(name, pos = null) {
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
        const p = xyz(pos);
        // 世界单位约 16 = 1 格; 参考距离 200 / 最大 4000 让枪声有清晰的远近感
        if (p && S.settings.positional && typeof ctx.createPanner === 'function') {
          const pan = ctx.createPanner();
          pan.panningModel = 'equalpower';
          pan.distanceModel = 'inverse';
          pan.refDistance = 200;
          pan.maxDistance = 4000;
          pan.rolloffFactor = 1;
          try {
            if (pan.positionX) {
              pan.positionX.value = p[0]; pan.positionY.value = p[1]; pan.positionZ.value = p[2];
            } else pan.setPosition(p[0], p[1], p[2]);
          } catch (_) { /* noop */ }
          src.connect(gain);
          gain.connect(pan);
          pan.connect(master || ctx.destination);
          src.onended = () => {
            try { src.disconnect(); gain.disconnect(); pan.disconnect(); } catch (_) { /* 已释放 */ }
          };
        } else {
          src.connect(gain);
          gain.connect(master || ctx.destination);
          src.onended = () => {
            try { src.disconnect(); gain.disconnect(); } catch (_) { /* 已释放 */ }
          };
        }
        src.start(0);
      } catch (e) { console.warn('[audio] play 失败', name, e); }
    },
  };
  S.audio = audio;

  const raw = (S.assets && S.assets.audio) || {};
  for (const [name, buf] of Object.entries(raw)) {
    if (!buf) continue;
    const copy = (buf.slice ? buf.slice(0) : buf);
    decodeBuffer(ctx, copy).then(
      decoded => { buffers[name] = decoded; },
      err => { console.warn(`[audio] 解码失败: assets/sfx/${name}.wav`, err); },
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
// 之后、initGame() 之前注册, 且用「包裹」而非「替换」的方式写入钩子。
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

function showKillFeed(killer, victim, headshot, weaponId = null, icon = null) {
  killMsg = `${String(killer)}  ${headshot ? '爆头' : '击杀'}  ${String(victim)}`;
  killUntil = S.time + 2.6;
  setText(D.killfeedText, killMsg);
  const key = icon || (headshot ? 'kill_headshot'
    : (weaponId === 'knife' ? 'kill_knife'
      : (weaponId === 'awp' ? 'kill_awp' : 'kill_default')));
  if (D.killIcon) {
    D.killIcon.src = SPRITE_URL(key);
    show(D.killIcon, true);
  }
  show(D.killfeed, true);
}

function refreshAmmo() {
  const wp = A.WEAPONS[S.weapon];
  const suffix = wp && wp.silencer && S.silenced && S.silenced[S.weapon] ? ' (消音)' : '';
  setText(D.weaponText, (wp ? wp.name : String(S.weapon)) + suffix);
  if (!wp || wp.clip_size == null) {
    setText(D.ammoText, '--');
  } else {
    const a = S.ammo[S.weapon] || [0, 0];
    setText(D.ammoText, `${a[0]} / ${a[1]}`);
  }
}

function refreshEquip() {
  const p = S.player;
  setText(D.armorText, `AP ${Math.round(p.armor || 0)}${p.hasHelmet ? ' +头盔' : ''}`);
  setColor(D.armorText, (p.armor || 0) > 0 ? '#96c8ff' : '#737373');
  const n = p.nades || { he: 0, flash: 0, smoke: 0 };
  setText(D.nadeText, `HE x${n.he || 0}  闪 x${n.flash || 0}  烟 x${n.smoke || 0}`);
  if (S.playerTeam === 't') {
    setText(D.kitText, '进攻方  ·  无拆弹钳');
    setColor(D.kitText, '#ffb45a');
  } else if (p.hasKit) {
    setText(D.kitText, '拆弹钳  已装备 (5s)');
    setColor(D.kitText, '#82ff96');
  } else {
    setText(D.kitText, '拆弹钳  无 (10s)');
    setColor(D.kitText, '#f0e196');
  }
  setText(D.moneyText, `$ ${S.money}`);
}

function updatePointerHint() {
  show(D.pointerHint, !!S.started && !S.pointerLocked && !S.buyMenuOpen
    && !S.menuMode && !S.matchPanel);
}

function syncBuyUI(explicitOpen) {
  const open = explicitOpen === undefined ? !!S.buyMenuOpen : !!explicitOpen;
  const changed = open !== buyWasOpen;
  show(D.buyMenu, open);
  setText(D.buyMoney, `$ ${S.money}`);
  if (open) {
    renderBuyMenu();
    if (document.pointerLockElement === canvas) exitLock();
  } else if (changed && buyWasOpen && S.started && !S.pointerLocked
             && !document.hidden && !S.menuMode && !S.matchPanel) {
    requestLock();
  }
  buyWasOpen = open;
  updatePointerHint();
}

// 购买菜单: 结构只在分类/队伍变化时重建, 每帧只改文本与 class。
let buyTab = 0;
let buyBuiltSig = '';

function buyItemLabel(id) {
  const w = A.WEAPONS[id];
  if (w) return w.name;
  return { armor: '凯夫拉护甲', kevlarhelm: '护甲 + 头盔', kit: '拆弹钳',
    he: 'HE 手雷', flash: '闪光弹', smoke: '烟雾弹', ammo: '补满弹药' }[id] || id;
}

function buyItemPrice(id) {
  const w = A.WEAPONS[id];
  if (w) return w.price;
  return { armor: 650, kevlarhelm: 1000, kit: 200, he: 300, flash: 200, smoke: 300, ammo: 300 }[id] ?? 0;
}

function buildBuyMenu() {
  const tabs = D.buyTabs, items = D.buyItems;
  if (!tabs || !items) return;
  const cats = BUY_CATEGORIES;
  if (buyTab >= cats.length) buyTab = 0;
  const ids = cats[buyTab].ids;
  // 队伍变了必须重建: 敌方标签会整体翻转
  const sig = `${buyTab}|${S.playerTeam}|${ids.join(',')}`;
  if (buyBuiltSig === sig) return;
  buyBuiltSig = sig;

  tabs.innerHTML = '';
  cats.forEach((cat, i) => {
    const b = document.createElement('div');
    b.className = 'tab' + (i === buyTab ? ' active' : '');
    b.textContent = `${i + 1} ${cat.label}`;
    b.setAttribute('data-tab', String(i));
    tabs.appendChild(b);
  });

  items.innerHTML = '';
  for (const id of ids) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-buy', id);
    btn.innerHTML = '<span class="wname"></span><span class="wprice"></span>';
    items.appendChild(btn);
  }
}

function refreshBuyMenu() {
  const items = D.buyItems;
  if (!items) return;
  const cats = BUY_CATEGORIES;
  if (buyTab >= cats.length) buyTab = 0;
  for (const btn of items.children) {
    const id = btn.getAttribute('data-buy');
    if (!id) continue;
    const price = buyItemPrice(id);
    const w = A.WEAPONS[id];
    let allowed = true;
    try { allowed = canBuyItem(id); } catch (_) { allowed = true; }
    const owned = !!(w && S.owned[id]);
    const afford = S.money >= price;
    const cls = (!allowed || !afford || owned) ? 'cant' : '';
    if (btn.className !== cls) btn.className = cls;
    const nameEl = btn.firstElementChild, priceEl = btn.lastElementChild;
    const tag = !allowed ? '<span class="wtag">敌方</span>'
      : (owned ? '<span class="wtag">已持有</span>' : '');
    const want = `${buyItemLabel(id)}${tag}`;
    if (nameEl && nameEl.innerHTML !== want) nameEl.innerHTML = want;
    const wantPrice = '$' + price;
    if (priceEl && priceEl.textContent !== wantPrice) priceEl.textContent = wantPrice;
  }
  const tabs = D.buyTabs;
  if (tabs) {
    for (let i = 0; i < tabs.children.length; i++) {
      const el = tabs.children[i];
      const cls = 'tab' + (i === buyTab ? ' active' : '');
      if (el.className !== cls) el.className = cls;
    }
  }
}

function renderBuyMenu() {
  buildBuyMenu();
  refreshBuyMenu();
}

function initHUD() {
  grab('loading', 'loading'); grab('bar', 'bar'); grab('loadLabel', 'load-label');
  grab('loadThumb', 'load-thumb');
  grab('start', 'start'); grab('startBtn', 'start-btn'); grab('fatal', 'fatal');
  grab('startRole', 'start-role'); grab('startThumb', 'start-thumb');
  grab('killText', 'kill-text'); grab('roundText', 'round-text');
  grab('enemyText', 'enemy-text'); grab('sideText', 'side-text');
  grab('allyText', 'ally-text');
  grab('kitText', 'kit-text'); grab('armorText', 'armor-text');
  grab('moneyText', 'money-text'); grab('hpText', 'hp-text');
  grab('timerText', 'timer-text'); grab('objectiveText', 'objective-text');
  grab('phaseText', 'phase-text');
  grab('slotText', 'slot-text');
  grab('nadeText', 'nade-text'); grab('weaponText', 'weapon-text');
  grab('ammoText', 'ammo-text');
  grab('crosshair', 'crosshair'); grab('scopeOverlay', 'scope-overlay');
  grab('radar', 'radar'); grab('radarCanvas', 'radar-canvas');
  grab('radio', 'radio'); grab('killfeed', 'killfeed');
  grab('killIcon', 'kill-icon'); grab('killfeedText', 'killfeed-text');
  grab('hitText', 'hit-text');
  grab('centerText', 'center-text'); grab('reloadText', 'reload-text');
  grab('spectateText', 'spectate-text');
  grab('freezeText', 'freeze-text'); grab('c4Icon', 'c4-icon');
  grab('pickupHint', 'pickup-hint'); grab('plantHint', 'plant-hint');
  grab('plantBarBg', 'plant-bar-bg'); grab('plantBar', 'plant-bar');
  grab('damageDir', 'damage-dir'); grab('damageArrow', 'damage-arrow');
  grab('defuseHint', 'defuse-hint'); grab('defuseBarBg', 'defuse-bar-bg');
  grab('defuseBar', 'defuse-bar'); grab('pointerHint', 'pointer-hint');
  grab('scoreboard', 'scoreboard'); grab('sbTitle', 'sb-title');
  grab('sbBody', 'sb-body'); grab('sbHint', 'sb-hint');
  grab('buyMenu', 'buy-menu'); grab('buyTitle', 'buy-title');
  grab('buyTabs', 'buy-tabs'); grab('buyItems', 'buy-items');
  grab('buyMoney', 'buy-money'); grab('redFlash', 'red-flash');
  grab('whiteFlash', 'white-flash');
  grab('pause', 'pause'); grab('matchOver', 'match-over');
  grab('moTitle', 'mo-title'); grab('moScore', 'mo-score');
  grab('moBtnOt', 'mo-btn-ot'); grab('moBtnRestart', 'mo-btn-restart');

  canvas = $('game');
  shownWeapon = S.weapon;
  lastWeapon = null;

  wrapHook('showCenter', () => {
    setText(D.centerText, S.centerText || '');
    setColor(D.centerText, S.centerColor || '#ffffff');
    show(D.centerText, !!S.centerText && S.time < (S.centerUntil || 0));
  });
  wrapHook('addKill', showKillFeed);
  wrapHook('killFeed', showKillFeed);
  wrapHook('radio', msg => {
    radioMsg = String(msg || '');
    radioUntil = S.time + 3.2;
    setText(D.radio, radioMsg);
    show(D.radio, !!radioMsg);
  });
  wrapHook('hitText', msg => {
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
  wrapHook('showMatchOver', showMatchOver);
  wrapHook('toggleBuy', open => syncBuyUI(!!open));
  wrapHook('buy', () => { setText(D.buyMoney, `$ ${S.money}`); });

  setText(D.slotText,
    '1 主武器 2 手枪 3 匕首 | G 手雷 F 闪光 X 烟雾 | R 换弹 E 交互 | V 武器模式 | B 购买 | Tab 计分 | ESC 暂停');
  setText(D.sbHint, '松开 Tab 关闭');
  setText(D.buyTitle, '— 购买装备 —');
  if (D.loadThumb) D.loadThumb.src = OVERVIEW_URL;
  if (D.startThumb) D.startThumb.src = OVERVIEW_URL;
  refreshAmmo();
  refreshEquip();

  S.hud = {
    updateHUD, refreshAmmo, refreshEquip, drawRadar, syncBuyUI,
    showCenter, nextRound, setScope, applySettings: applySettingsToRuntime,
  };
}

// ---------------------------------------------------------------------------
// 通用开镜: 所有带 zoomLevels 的枪都能开, 不再只认 AWP
// ---------------------------------------------------------------------------
const SCOPE_SENS_SCALE = 0.4;

function zoomLevels(wid) {
  const wp = A.WEAPONS[wid];
  if (wp && Array.isArray(wp.zoomLevels) && wp.zoomLevels.length) return wp.zoomLevels;
  if (wp && wp.zoom) return [40];
  return null;
}
function zoomable(wid) { return !!zoomLevels(wid); }

function applySensitivity(scoped, level = 1) {
  const base = Number.isFinite(S.player.sensitivityBase) ? S.player.sensitivityBase : 2.0;
  S.player.sensitivity = scoped ? base * SCOPE_SENS_SCALE / Math.max(1, level) : base;
}

// on === true  -> 进入/维持瞄准; false -> 退出; undefined -> 循环下一级
function setScope(on) {
  const wp = A.WEAPONS[S.weapon];
  const levels = zoomLevels(S.weapon);
  const canScope = !!wp && !!levels && !S.player.dead && !S.buyMenuOpen;
  if (!canScope) {
    S.scopeLevel = 0;
    S.scoped = false;
    S.player.scoped = false;
    applySensitivity(false);
    return;
  }
  if (on === false) S.scopeLevel = 0;
  else if (on === true) { if (!S.scopeLevel) S.scopeLevel = 1; }
  else S.scopeLevel = (S.scopeLevel || 0) + 1;

  if (S.scopeLevel > levels.length) S.scopeLevel = 0;
  const active = S.scopeLevel > 0;
  const wasActive = !!S.scoped;
  S.scoped = active;
  S.player.scoped = active;
  S.player.scopeLevel = S.scopeLevel;
  applySensitivity(active, S.scopeLevel || 1);
  if (active && !wasActive) play('zoom');
}

function scopeOverlayVisible() {
  const wp = A.WEAPONS[S.weapon];
  return !!S.scoped && !!wp && wp.kind === 'sniper';
}

// ---------------------------------------------------------------------------
// 菜单: 主菜单 / 暂停 / 终局
// ---------------------------------------------------------------------------
function syncSettingLabels() {
  const s = S.settings;
  const sens = $('set-sens'), vol = $('set-volume'), fov = $('set-fov');
  const bots = $('set-bots'), diff = $('set-diff'), mr = $('set-mr'), pos = $('set-positional');
  if (sens) sens.value = String(s.sensitivity);
  if (vol) vol.value = String(s.volume);
  if (fov) fov.value = String(s.fov);
  if (bots) bots.value = String(s.botCount);
  if (diff) diff.value = String(s.difficulty);
  if (mr) mr.value = String(s.roundsPerHalf);
  if (pos) pos.checked = s.positional !== false;
  setText($('set-sens-val'), Number(s.sensitivity).toFixed(1));
  setText($('set-volume-val'), `${Math.round(s.volume * 100)}%`);
  setText($('set-fov-val'), String(Math.round(s.fov)));
}

function applySettingsToRuntime() {
  const s = S.settings;
  setSensitivity(s.sensitivity);
  S.baseFov = s.fov;
  if (S.audio && typeof S.audio.setVolume === 'function') S.audio.setVolume(s.volume);
  if (S.hooks && typeof S.hooks.applySettings === 'function') S.hooks.applySettings();
  syncSettingLabels();
  updateStartRole();
}

function updateStartRole() {
  const t = S.playerTeam === 't';
  setText(D.startRole, t
    ? '你是 T：携带 C4 前往包点，按住 E 安放并守住它'
    : '你是 CT：阻止 T 安放 C4，或按住 E 拆除已安放的 C4');
  const sub = D.loading && D.loading.querySelector('.sub');
  if (sub) sub.textContent = `DE_DUST2  ·  爆破模式  ·  ${t ? 'T 进攻' : 'CT 防守'}`;
}

function onSettingChange() {
  const s = S.settings;
  const num = (id, key, lo, hi) => {
    const el = $(id);
    if (!el) return;
    const v = Number(el.value);
    if (Number.isFinite(v)) s[key] = clamp(v, lo, hi);
  };
  num('set-sens', 'sensitivity', 0.2, 8);
  num('set-volume', 'volume', 0, 1);
  num('set-fov', 'fov', 70, 110);
  num('set-bots', 'botCount', 3, 8);
  num('set-diff', 'difficulty', 0.5, 2);
  num('set-mr', 'roundsPerHalf', 9, 15);
  const pos = $('set-positional');
  if (pos) s.positional = !!pos.checked;
  saveSettings();
  applySettingsToRuntime();
}

function openPause() {
  if (!S.started || S.menuMode || S.matchPanel || S.buyMenuOpen) return;
  S.menuMode = 'pause';
  show(D.pause, true);
  show(D.pointerHint, false);
  setScope(false);
}

function closePause() {
  S.menuMode = null;
  show(D.pause, false);
  show(D.start, false);
  requestLock();
}

function showMatchOver(panel) {
  const p = panel || {};
  S.matchPanel = p;
  setText(D.moTitle, p.title || '比赛结束');
  setText(D.moScore, p.score ? `最终比分  ${p.score}` : '');
  show(D.moBtnOt, !!p.canOvertime);
  show(D.matchOver, true);
  show(D.pause, false);
  show(D.pointerHint, false);
  setScope(false);
  exitLock();
}

function hideMatchOver() {
  S.matchPanel = null;
  show(D.matchOver, false);
  requestLock();
}

function initMenus() {
  const ids = ['set-sens', 'set-volume', 'set-fov', 'set-bots', 'set-diff', 'set-mr', 'set-positional'];
  for (const id of ids) {
    const el = $(id);
    if (el) el.addEventListener('input', onSettingChange);
  }
  const resume = $('pause-resume');
  if (resume) resume.addEventListener('click', () => { resumeAudio(); closePause(); });
  const pr = $('pause-restart');
  if (pr) pr.addEventListener('click', () => {
    resumeAudio();
    if (typeof S.hooks.restartMatch === 'function') S.hooks.restartMatch();
    closePause();
  });
  const pm = $('pause-menu');
  if (pm) pm.addEventListener('click', () => {
    S.menuMode = 'start';
    show(D.pause, false);
    show(D.start, true);
    updateStartRole();
    exitLock();
  });
  const ot = $('mo-btn-ot');
  if (ot) ot.addEventListener('click', () => {
    resumeAudio();
    if (typeof S.hooks.startOvertime === 'function') S.hooks.startOvertime();
    hideMatchOver();
  });
  const mo = $('mo-btn-restart');
  if (mo) mo.addEventListener('click', () => {
    resumeAudio();
    if (typeof S.hooks.restartMatch === 'function') S.hooks.restartMatch();
    hideMatchOver();
  });
}

// ---------------------------------------------------------------------------
// 雷达: 旋转俯视贴图 + 敌人/队友/C4/中心箭头
// ---------------------------------------------------------------------------
const RADAR_R = 100;
const RADAR_RANGE = 900;
const RADAR_SCALE = RADAR_R / RADAR_RANGE;
const RPAD = 8;

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
    const kx = radarMapW / (A.W + 2 * RPAD);
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
  if ((B.state === 'planted' || B.drop) && (B.pos || (B.drop && B.drop.pos))) {
    const [x, y] = project(B.state === 'planted' ? B.pos : B.drop.pos);
    dot(x, y, 5, Math.floor(S.time * 4) % 2 ? '#ffdc46' : '#ff463c');
  }

  ctx.fillStyle = 'rgba(150, 200, 150, .8)';
  ctx.fillRect(RADAR_R - 2, 4, 4, 6);
  ctx.fillRect(RADAR_R - 2, 190, 4, 6);
  ctx.fillRect(4, RADAR_R - 2, 6, 4);
  ctx.fillRect(190, RADAR_R - 2, 6, 4);

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
  if (!S.scoreboardOpen || !D.sbBody) return;
  const M = S.match || {};
  const team = S.playerTeam || 'ct';
  const us = team === 'ct' ? (M.ctScoreTotal || 0) : (M.tScoreTotal || 0);
  const them = team === 'ct' ? (M.tScoreTotal || 0) : (M.ctScoreTotal || 0);
  const halfTag = M.half === 2 ? '  下半场' : (M.overtime ? '  加时' : '');
  setText(D.sbTitle, `CS 1.5  爆破模式   |   ${team.toUpperCase()}  ${us} : ${them}${halfTag}`);

  const row = (name, side, kills, deaths, money, ping, dead, me) => {
    const cls = [me ? 'sb-me' : '', dead ? 'sb-dead' : ''].filter(Boolean).join(' ');
    const sideCls = side === 'ct' ? 'sb-ct' : 'sb-t';
    return `<tr class="${cls}"><td>${esc(name)}</td>` +
      `<td class="${sideCls}">${side.toUpperCase()}</td>` +
      `<td class="num">${kills}</td><td class="num">${deaths}</td>` +
      `<td class="num">${money}</td><td class="num">${ping}</td></tr>`;
  };
  const bots = (S.allies || []).concat(S.enemies || []);
  const aliveMe = !S.player.dead;
  let html = `<div class="sb-score">总分 ${M.ctScoreTotal || 0} : ${M.tScoreTotal || 0}` +
    ` · 本半场 ${S.ctScore || 0} : ${S.tScore || 0} · 回合 ${S.roundNum}</div>`;
  html += '<table class="sb-table"><thead><tr><th>玩家</th><th>阵营</th>' +
    '<th class="num">击杀</th><th class="num">死亡</th><th class="num">资金</th><th class="num">Ping</th>' +
    '</tr></thead><tbody>';
  html += row('你', team, S.stats.kills || 0, S.stats.deaths || 0,
    `$${S.money}`, 0, !aliveMe, true);
  for (const b of bots) {
    if (!b || !b.enabled) continue;
    html += row(b.name || 'BOT', b.team || 'ct',
      (b.stats && b.stats.kills) || 0, (b.stats && b.stats.deaths) || 0,
      '—', 0, b.health <= 0, false);
  }
  html += '</tbody></table>';
  D.sbBody.innerHTML = html;
}

function updateHUD() {
  const B = S.BOMB;
  const p = S.player;
  const now = S.time;
  const R = S.round || { phase: 'freeze', freezeLeft: 0, buyLeft: 0 };
  const attacker = S.playerTeam === 't';

  setText(D.killText, `击杀: ${S.stats.kills || 0}`);
  {
    const M = S.match || null;
    const us = S.playerTeam === 'ct' ? (M ? M.ctScoreTotal : S.ctScore)
      : (M ? M.tScoreTotal : S.tScore);
    const them = S.playerTeam === 'ct' ? (M ? M.tScoreTotal : S.tScore)
      : (M ? M.ctScoreTotal : S.ctScore);
    const halfTag = M && M.half === 2 ? (M.overtime ? '  加时' : '  下半场') : '';
    setText(D.roundText, `回合 ${S.roundNum}   ${us} : ${them}${halfTag}`);
  }
  setText(D.enemyText, `敌人: ${(S.enemies || []).filter(b => b && b.enabled).length}`);
  setText(D.sideText, attacker ? 'T  进攻' : 'CT  防守');
  setText(D.allyText, `队友: ${(S.allies || []).filter(b => b && b.enabled).length}`);

  if (B.state === 'planted') {
    setText(D.timerText, `C4  ${fmtTime(B.c4Left)}`);
    setColor(D.timerText, '#ff5f50');
    setText(D.objectiveText, attacker ? `守住 C4  ·  ${B.site} 点` : `拆除 C4  ·  ${B.site} 点`);
  } else {
    const left = Math.max(0, B.roundLeft);
    setText(D.timerText, fmtTime(left));
    setColor(D.timerText, R.phase === 'freeze' ? '#b4d2ff'
      : (left <= 20 ? '#ff8c5a' : '#e1eeff'));
    setText(D.objectiveText, attacker
      ? (B.plant > 0 ? `正在 ${B.site} 点安放 C4 ...` : `前往 ${B.site} 点安放 C4`)
      : (B.plant > 0 ? `T 正在 ${B.site} 点安放 C4 ...` : `阻止 T 在 ${B.site} 点安放 C4`));
  }
  setText(D.phaseText, R.phase === 'freeze'
    ? `冻结时间 ${Math.max(0, R.freezeLeft).toFixed(1)}s  ·  可购买`
    : (R.phase === 'over' ? '回合结束'
      : (R.buyLeft > 0 ? `购买剩余 ${Math.ceil(R.buyLeft)}s` : '')));
  show(D.freezeText, R.phase === 'freeze');
  if (R.phase === 'freeze') setText(D.freezeText, `冻结时间  ${Math.max(0, R.freezeLeft).toFixed(1)}s`);
  show(D.c4Icon, !!p.hasC4 && !p.dead);

  refreshEquip();
  setText(D.hpText, `HP ${p.hp}`);
  setColor(D.hpText, p.hp > 60 ? '#78ff78' : (p.hp > 30 ? '#ffdc50' : '#ff5a5a'));
  refreshAmmo();

  show(D.centerText, !!S.centerText && now < (S.centerUntil || 0));
  if (S.centerText) {
    setText(D.centerText, S.centerText);
    setColor(D.centerText, S.centerColor || '#ffffff');
  }
  show(D.radio, !!radioMsg && now < radioUntil);
  show(D.killfeed, !!killMsg && now < killUntil);
  const hm = S.hitMarker || '';
  show(D.hitText, !!hm && now < (S.hitMarkerUntil || 0));
  if (hm) setText(D.hitText, hm);
  show(D.reloadText, !!S.reloading);
  show(D.spectateText, !!spectateMsg && !!p.dead);

  // 掉落在脚边的武器
  let pickup = null, bestD = 64;
  for (const d of (S.drops || [])) {
    if (!d || !d.pos) continue;
    const dd = Math.hypot(p.pos[0] - d.pos[0], p.pos[2] - d.pos[2]);
    if (dd < bestD) { bestD = dd; pickup = d; }
  }
  show(D.pickupHint, !!pickup && !p.dead);
  if (pickup) {
    const w = A.WEAPONS[pickup.wid];
    setText(D.pickupHint, `按 E 拾取 ${w ? w.name : pickup.wid}`);
  }

  // 玩家下包进度 (只在 T 方显示, 与 CT 的拆弹提示位置互斥)
  const planting = attacker && !p.dead && p.hasC4 && R.phase === 'live'
    && S.plant && S.plant.near && B.state === 'live';
  show(D.plantHint, !!planting);
  show(D.plantBarBg, !!planting);
  show(D.plantBar, !!planting);
  if (planting) {
    setText(D.plantHint, S.plant.active
      ? `安放 C4 中 ...  还需 ${Math.max(0, A.PLANT_TIME - B.plant).toFixed(1)}s`
      : '按住 E 安放 C4');
    if (D.plantBar) D.plantBar.style.width = `${clamp(S.plant.progress || 0, 0, 1) * 100}%`;
  } else if (D.plantBar) D.plantBar.style.width = '0%';

  // 拆弹提示 + 进度条 (仅 CT)
  let defuseNear = false;
  if (!attacker && B.state === 'planted' && B.pos && !p.dead && !S.buyMenuOpen) {
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
  } else if (D.defuseBar) D.defuseBar.style.width = '0%';

  // 受伤方向指示: 旋转整层, 箭头永远指向伤害来源
  const dd = S.damageDir;
  const showDir = !!dd && now < (dd.until || 0) && !p.dead;
  show(D.damageDir, showDir);
  if (showDir && D.damageDir) {
    D.damageDir.style.transform = `rotate(${Number(dd.angle) || 0}deg)`;
    setOpacity(D.damageDir, clamp((dd.until - now) * 1.5, 0, 1));
  }

  if (S.paused) {
    S.redFlash = Math.max(0, (S.redFlash || 0) - S.dt * 220);
    S.whiteFlash = Math.max(0, (S.whiteFlash || 0) - S.dt * 170);
  }
  setOpacity(D.redFlash, (S.redFlash || 0) / 90);
  setOpacity(D.whiteFlash, (S.whiteFlash || 0) / 255);

  // 准星: 按武器类型切换, gap 由移动/连射热度扩张
  const moving = held('w', 'a', 's', 'd', 'KeyW', 'KeyA', 'KeyS', 'KeyD');
  const gap = 0.012 + (moving ? 0.007 : 0) + (S.crossHeat || 0) * 0.007;
  if (D.crosshair) {
    D.crosshair.style.setProperty('--gap', `${(gap * (window.innerHeight || 600)).toFixed(1)}px`);
    const wp = A.WEAPONS[S.weapon];
    const ch = wp && wp.crosshair ? wp.crosshair : 'cross';
    if (D.crosshair.getAttribute('data-ch') !== ch) D.crosshair.setAttribute('data-ch', ch);
  }
  if (S.scoped && (!zoomable(S.weapon) || p.dead || S.buyMenuOpen)) setScope(false);
  show(D.crosshair, !S.scoped && !S.buyMenuOpen && !p.dead);
  show(D.scopeOverlay, scopeOverlayVisible());

  if (shownWeapon !== S.weapon) {
    if (shownWeapon && S.owned[shownWeapon]) lastWeapon = shownWeapon;
    shownWeapon = S.weapon;
  }

  updateScoreboard();
  syncBuyUI();
  updatePointerHint();

  if (S.frame % 3 === 0 || S.frame < 2) drawRadar();
}

// ---------------------------------------------------------------------------
// 输入
// ---------------------------------------------------------------------------
const ALIAS = {
  KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd',
  ShiftLeft: 'shift', ShiftRight: 'shift',
  ControlLeft: 'control', ControlRight: 'control',
  Space: 'space', KeyE: 'e', KeyR: 'r', KeyB: 'b',
  KeyG: 'g', KeyF: 'f', KeyQ: 'q', KeyV: 'v', KeyX: 'x', Tab: 'tab',
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
    v: 'KeyV', x: 'KeyX',
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

function cycleSlot(slot) {
  const inSlot = Object.keys(S.owned).filter(id => {
    const w = A.WEAPONS[id];
    return w && w.slot === slot;
  });
  if (!inSlot.length) return;
  if (inSlot.length === 1) { selectWeapon(inSlot[0]); return; }
  const cur = inSlot.indexOf(S.weapon);
  selectWeapon(inSlot[(cur + 1) % inSlot.length]);
}

function callEngine(name, ...args) {
  const fn = S.engine && S.engine[name];
  if (typeof fn === 'function') { fn(...args); return; }
  const h = S.hooks && S.hooks[name];
  if (typeof h === 'function') h(...args);
}

function weaponMode() {
  if (S.weapon === 'glock18') callEngine('toggleGlockMode');
  else callEngine('toggleSilencer');
  refreshAmmo();
}

function initInput() {
  canvas = canvas || $('game');

  document.addEventListener('pointerlockchange', () => {
    const was = S.pointerLocked;
    S.pointerLocked = document.pointerLockElement === canvas;
    if (!S.pointerLocked) {
      S.mouseDX = 0; S.mouseDY = 0;
      S.mouseDown = false; S.rightDown = false;
      setScope(false);
      // ESC / 失焦解锁时弹出暂停菜单; 购买菜单与终局面板自己会解锁, 不算暂停
      if (was && S.started && !S.buyMenuOpen && !S.menuMode && !S.matchPanel) openPause();
    } else if (S.menuMode === 'pause') {
      S.menuMode = null;
      show(D.pause, false);
    }
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
    if (!S.pointerLocked || S.buyMenuOpen || S.menuMode) return;
    S.mouseDX += e.movementX || 0;
    S.mouseDY += e.movementY || 0;
  });
  document.addEventListener('mouseup', e => {
    if (e.button === 0) S.mouseDown = false;
    if (e.button === 2) S.rightDown = false;
  });
  document.addEventListener('contextmenu', e => e.preventDefault());

  if (canvas) {
    canvas.addEventListener('mousedown', e => {
      e.preventDefault();
      if (!S.started || S.buyMenuOpen || S.menuMode || S.matchPanel) return;
      if (!S.pointerLocked) { requestLock(); return; }
      if (S.player.dead) {
        // 阵亡观战: 左/右键切换跟随目标
        if (e.button === 0 || e.button === 2) callEngine('cycleSpectate');
        return;
      }
      if (e.button === 0) {
        S.mouseDown = true;
        if (typeof S.hooks.shoot === 'function') S.hooks.shoot();
        else shoot();
      } else if (e.button === 2) {
        S.rightDown = true;
        setScope();                  // 右键循环变焦级 (CS 1.5 行为)
      }
    });
  }

  document.addEventListener('keydown', e => {
    const code = codeOf(e);
    setKey(code, true);
    resumeAudio();
    if (!S.started || S.menuMode || S.matchPanel) return;

    if (code === 'Tab') { e.preventDefault(); S.scoreboardOpen = true; return; }
    if (code === 'Escape') { exitLock(); return; }
    if (e.repeat) return;

    // 阵亡观战按键 (不受回合结算限制)
    if (S.player.dead) {
      if (code === 'Space' || code === 'ArrowLeft' || code === 'ArrowRight') {
        e.preventDefault(); callEngine('cycleSpectate'); return;
      }
      if (code === 'KeyV') { callEngine('toggleFreeCam'); return; }
      if (code === 'Tab') return;
      return;
    }
    if (S.BOMB.state === 'over') return;
    if (code === 'KeyB') { toggleBuyMenu(); return; }
    if (S.buyMenuOpen) {
      const n = /^Digit([1-7])$/.exec(code);
      if (n) { buyTab = Number(n[1]) - 1; renderBuyMenu(); }
      return;
    }

    if (code === 'KeyE') {
      S.defuseHeld = true;
      if (typeof S.hooks.pickupWeapon === 'function') S.hooks.pickupWeapon();
      return;
    }
    if (code === 'KeyV') { weaponMode(); return; }
    if (code === 'KeyR') { reloadWeapon(); return; }
    if (code === 'BracketLeft' || code === 'BracketRight') {
      const cur = Number.isFinite(S.player.sensitivityBase) ? S.player.sensitivityBase : 2.0;
      const next = setSensitivity(code === 'BracketLeft' ? cur * 0.8 : cur * 1.2);
      S.settings.sensitivity = next;
      saveSettings();
      syncSettingLabels();
      showCenter(`鼠标灵敏度 ${next.toFixed(2)}`, '#b4d2ff', 1.0);
      return;
    }
    if (code === 'Digit1') { cycleSlot(1); return; }
    if (code === 'Digit2') { cycleSlot(2); return; }
    if (code === 'Digit3') { cycleSlot(3); return; }
    if (code === 'KeyQ') { selectWeapon(lastWeapon); return; }
    if (code === 'KeyG') { throwNade('he'); return; }
    if (code === 'KeyF') { throwNade('flash'); return; }
    if (code === 'KeyX') { throwNade('smoke'); return; }
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

  document.addEventListener('click', e => {
    const t = e.target;
    if (!t || !t.closest) return;
    const tabEl = t.closest('[data-tab]');
    if (tabEl) {
      const i = Number(tabEl.getAttribute('data-tab'));
      if (Number.isInteger(i) && i >= 0 && i < BUY_CATEGORIES.length) {
        buyTab = i;
        renderBuyMenu();
      }
      return;
    }
    const btn = t.closest('[data-buy]');
    if (!btn || !btn.getAttribute) return;
    const id = btn.getAttribute('data-buy');
    if (!id) return;
    resumeAudio();
    buyItem(id);
  });

  if (canvas) {
    canvas.addEventListener('click', () => {
      if (S.started && !S.buyMenuOpen && !S.pointerLocked && !S.menuMode && !S.matchPanel) requestLock();
    });
  }

  if (D.startBtn) {
    D.startBtn.addEventListener('click', () => {
      resumeAudio();
      S.started = true;
      S.paused = false;
      S.menuMode = null;
      show(D.start, false);
      show(D.loading, false);
      show(D.pause, false);
      applySettingsToRuntime();
      requestLock();
    });
  }
  document.addEventListener('pointerdown', resumeAudio, { once: true });
  document.addEventListener('keydown', resumeAudio, { once: true });
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
  setText(el, '启动失败 / Failed to start\n\n' + String(msg) +
    '\n\n请从项目根目录启动静态 HTTP 服务, 然后通过 /web/index.html 访问。\n' +
    '例如: python -m http.server 8000');
  show(el, true);
  show(D.loading || $('loading'), false);
}

// 时钟归属: game.js 的 updateGame() -> syncClock() 拥有 S.time / S.frame,
// 主循环只设置 S.dt, 避免双计时。
function loop(ts) {
  const dt = lastTs ? clamp((ts - lastTs) / 1000, 0, 0.05) : 0;
  lastTs = ts;
  S.dt = dt;

  if (S.started && !S.paused && !S.menuMode) {
    updateEngine(dt);
    updateGame(dt);
    updateHUD();
    renderFrame();
  } else {
    renderFrame();
  }
  requestAnimationFrame(loop);
}

async function boot() {
  try {
    loadSettings();
    const assets = await A.loadAll(onProgress);
    S.assets = assets;
    initEngine($('game'));
    initAudio();
    initHUD();
    initInput();
    initMenus();
    initGame();           // 必须在 initHUD() 之后: game.js 会把 HUD 钩子存为 prevHooks
    applySettingsToRuntime();
    syncBuyUI(false);
    show(D.loading, false);

    const _q = new URLSearchParams(location.search);
    if (_q.get('auto') === '1') {
      S.started = true;
      S.paused = false;
      S.menuMode = null;
      const pv = (_q.get('pos') || '').split(',').map(Number);
      if (pv.length >= 5 && pv.every(Number.isFinite)) {
        S.player.pos = [pv[0], pv[1], pv[2]];
        S.player.yaw = pv[3];
        S.player.pitch = pv[4];
      }
      // 无头回归没有真实时间等待冻结期, 直接置为 live 以便射击/购买断言
      if (S.round) { S.round.phase = 'live'; S.round.freezeLeft = 0; }
      show(D.start, false);
      show(D.loading, false);
      window.__CS_READY__ = true;
    } else {
      S.menuMode = 'start';
      updateStartRole();
      show(D.start, true);
    }
    window.__CS_BOOTED__ = true;
    window.__CS__ = { S, A };
    requestAnimationFrame(loop);
  } catch (err) {
    showFatal(err);
    throw err;
  }
}

function onReady(fn) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn, { once: true });
  } else fn();
}

onReady(() => {
  boot().catch(err => console.error('[boot] 启动失败', err));
});
