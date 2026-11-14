// web/game.js  —  BOT AI / C4 / 回合状态机 (main.py 移植)
// 逻辑坐标与 state.js 一致: x 右 / y 上 / z 前, yaw=0 朝 +z。
import * as THREE from './vendor/three.module.js';
import * as A from './asset.js';
import { S, clamp, rand, randInt, choice, dist2, dist3, yawTo, fmtTime, play, showCenter, reportPlayer, radioContact, addKill, giveAmmo, hitText,
  notifyGunfire, heardGunfire } from './state.js';
import { makeBotMesh, addEntityMesh, removeEntityMesh, getCamera } from './engine.js';

const DEG = Math.PI / 180;
// CS 1.5 装备价格 (armor 650 / 全套 1000 / kit 200 / 弹药 各自价格)
const GEAR = { armor: 650, kevlarhelm: 1000, kit: 200 };
const NADE_LIMIT = { he: 1, flash: 2, smoke: 1 };
const BUY_WINDOW = 15;
const MONEY_CAP = 16000;      // CS 1.5 资金上限
const BUY_RADIUS = 400;

// 购买菜单分类: 与 CS 1.5 的 buy 菜单一致 (1 手枪 / 2 霰弹 / 3 冲锋 / 4 步枪 /
// 5 机枪 / 6 装备)。每项 [武器id 或装备id, 显示名]。队伍限制在 canBuyItem 里判。
export const BUY_CATEGORIES = [
  {
    key: 'pistol', label: '手枪', ids: [
      'glock18', 'usp', 'p228', 'deagle', 'elite', 'fiveseven',
    ],
  },
  {
    key: 'shotgun', label: '霰弹枪', ids: ['m3', 'xm1014'],
  },
  {
    key: 'smg', label: '冲锋枪', ids: ['tmp', 'mac10', 'mp5', 'ump45', 'p90'],
  },
  {
    key: 'rifle', label: '步枪', ids: ['ak47', 'm4a1', 'sg552', 'aug'],
  },
  {
    key: 'sniper', label: '狙击枪', ids: ['scout', 'awp', 'g3sg1', 'sg550'],
  },
  {
    key: 'heavy', label: '机枪', ids: ['m249'],
  },
  {
    key: 'gear', label: '装备', ids: ['armor', 'kevlarhelm', 'kit', 'he', 'flash', 'ammo'],
  },
];
const RELOAD_TIME = 1.6;
const HE_RADIUS = 200;
const FLASH_RADIUS = 320;
const SMOKE_RADIUS = 150;     // CS 1.5 smokescreen 半径约 150 单位
const SMOKE_TIME = 12;        // 持续约 12 秒
const ALLY_COUNT = 4;

let DEF_POSTS = [];
let ROAM_CELLS = [];
let T_ROAM_CELLS = [];
let spawnCounter = 0;
let roundToken = 0;
const timers = [];
const bombMeshes = { entity: null, led: null, drop: null };

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
const safeArr = p => (Array.isArray(p) && p.length >= 3 ? p : [0, 0, 0]);
const copy3 = p => [p[0] || 0, p[1] || 0, p[2] || 0];
const obj3 = p => ({ x: p[0] || 0, y: p[1] || 0, z: p[2] || 0 });
const finite = v => Number.isFinite(v) ? v : 0;

function later(fn, sec) {
  const token = roundToken;
  const id = setTimeout(() => {
    const i = timers.indexOf(id);
    if (i >= 0) timers.splice(i, 1);
    if (token !== roundToken) return;
    try { fn(); } catch (e) { console.warn('[game] timer', e); }
  }, Math.max(0, sec) * 1000);
  timers.push(id);
  return id;
}

function cancelTimers(clearRound) {
  if (clearRound) roundToken++;
  for (const id of timers.splice(0)) clearTimeout(id);
}

function scene() {
  return (S.engine && S.engine.scene) || null;
}

function addMesh(mesh) {
  if (!mesh) return mesh;
  if (typeof addEntityMesh === 'function') addEntityMesh(mesh);
  else if (scene()) scene().add(mesh);
  return mesh;
}

// initGame 可能早于 initEngine: scene 就绪后把无父节点的实体补挂进去
function syncScene() {
  if (!scene()) return;
  const attach = m => {
    if (m && !m.parent) addMesh(m);
  };
  for (const bot of S.enemies.concat(S.allies)) {
    if (bot && bot.visual) attach(bot.visual.group);
  }
  for (const k of ['entity', 'led', 'drop']) attach(bombMeshes[k]);
  for (const o of S.grenades) attach(o && o.mesh);
  for (const o of S.debris) attach(o && o.mesh);
  for (const o of S.smokes) attach(o && o.mesh);
}

function dropMesh(mesh) {
  if (!mesh) return;
  if (typeof removeEntityMesh === 'function') removeEntityMesh(mesh);
  else if (scene()) scene().remove(mesh);
  if (mesh.parent) mesh.parent.remove(mesh);
  disposeTree(mesh);
}

function disposeTree(root) {
  root.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    const m = o.material;
    if (Array.isArray(m)) m.forEach(x => x && x.dispose());
    else if (m) m.dispose();
  });
}

function makeBox(size, color, pos) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(size[0], size[1], size[2]),
    new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }),
  );
  mesh.position.set(pos[0], pos[1], pos[2]);
  return addMesh(mesh);
}

function cellBlockedAt(p) {
  const c = A.cellOf(p);
  return A.layers(c[0], c[1]).length === 0;
}

function nearestLayerIndex(ls, y) {
  if (!ls || !ls.length) return 0;
  let bi = 0, bd = Infinity;
  for (let i = 0; i < ls.length; i++) {
    const d = Math.abs(ls[i] - y);
    if (d < bd) { bd = d; bi = i; }
  }
  return bi;
}

function surfaceY(p, layer = 0) {
  const c = A.cellOf(p);
  const ls = A.layers(c[0], c[1]);
  if (!ls.length) return 0;
  return ls[clamp(Math.floor(layer || 0), 0, ls.length - 1)];
}

function groundAt(p, fallbackY = 0) {
  const c = A.cellOf(p);
  const g = A.surfaceAt(c[0], c[1], p[1]);
  return g === null || g === undefined ? fallbackY : g;
}

function ringCells(center, r0, r1, n = 8) {
  const out = [];
  for (let cy = center[1] - r1; cy <= center[1] + r1; cy++) {
    for (let cx = center[0] - r1; cx <= center[0] + r1; cx++) {
      const d2 = (cx - center[0]) ** 2 + (cy - center[1]) ** 2;
      if (d2 >= r0 * r0 && d2 <= r1 * r1 && A.layers(cx, cy).length) out.push([cx, cy]);
    }
  }
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.slice(0, n);
}

// 在 p 周围 [r0, r1] 格内随机取一个可走格 (返回格坐标)。
// 用于 bot 的巡逻目标: 保持"在附近晃"的手感, 同时让寻路目标高概率重复,
// 流场缓存才能真正命中 (见 Bot.repath 的注释)。
function pickNearbyGoal(p, r0, r1) {
  const c = A.cellOf(p);
  for (let attempt = 0; attempt < 12; attempt++) {
    const ang = Math.random() * Math.PI * 2;
    const r = r0 + Math.random() * (r1 - r0);
    const cx = Math.round(c[0] + Math.cos(ang) * r);
    const cy = Math.round(c[1] + Math.sin(ang) * r);
    if (A.layers(cx, cy).length) return [cx, cy];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Bot 视觉: makeBotMesh 每次都新建几何; 模型缺失时用简单占位, 绝不抛异常
// ---------------------------------------------------------------------------
function createVisual(team, weaponId = null) {
  const models = (A.PLAYER_MODELS && A.PLAYER_MODELS[team]) || ['sas'];
  const arsenal = (A.BOT_ARSENAL && A.BOT_ARSENAL[team]) || ['usp'];
  const wid = weaponId && A.WEAPONS[weaponId] ? weaponId : choice(arsenal);
  try {
    // 让手上的模型与 weaponId 严格对应, 而不是各自随机 —— 否则 bot 举着 AWP
    // 却打出 AK 的枪声和伤害。
    const v = makeBotMesh(choice(models), 'w_' + wid);
    if (v && v.group) {
      if (!v.hpBar) v.hpBar = v.group.userData.hpBar || null;
      if (!v.flash) v.flash = v.group.userData.flash || null;
      if (typeof v.setHitFlash !== 'function') {
        v.setHitFlash = v.group.userData.setHitFlash || (() => {});
      }
      v.weaponId = wid;
      return v;
    }
  } catch (e) {
    console.warn('[game] makeBotMesh 失败, 使用占位模型', e);
  }
  const group = new THREE.Group();
  group.scale.set(32, 72, 32);
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.8, 0.9, 0.5),
    new THREE.MeshBasicMaterial({ color: team === 't' ? 0x9a6b3c : 0x3c6b9a }),
  );
  body.position.y = 0.45;
  group.add(body);
  const hpBar = new THREE.Mesh(
    new THREE.PlaneGeometry(0.75, 0.055),
    new THREE.MeshBasicMaterial({ color: 0x50ff50, side: THREE.DoubleSide }),
  );
  hpBar.position.y = 1.10;
  group.add(hpBar);
  const flash = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ color: 0xffdc64, side: THREE.DoubleSide }),
  );
  flash.position.set(0, 0.8, 0.3);
  flash.scale.setScalar(0.16);
  flash.visible = false;
  group.add(flash);
  const parts = [{ mesh: body, texture: null }];
  group.userData.hpBar = hpBar;
  return {
    group, parts, gunParts: [], hpBar, flash,
    setHitFlash(on) { body.material.color.setHex(on ? 0xffffff : (team === 't' ? 0x9a6b3c : 0x3c6b9a)); },
  };
}

// bot 之间的软分离: 玩家碰撞盒 32 宽, bot 之间保持 ~36 单位即可避免穿插。
// 旧实现完全不检测彼此, 于是同一条冲锋路线上会叠成一坨 (尤其是一起冲向
// 包点的 T)。这里只在"已经重叠"时才推, 推力随重叠加深而增大, 且仍然走
// moveAxis 的可通行判定, 不会把 bot 推进墙里。
const SEPARATION_DIST = 36;
const SEPARATION_MAX_PUSH = 60;
let sepPush = null;              // separateBots 的推量缓冲 (复用, 避免每帧分配)

function separateBots(bots, dt) {
  if (bots.length < 2) return;
  // 两遍法: 先累积每只 bot 需要的总推量, 再统一应用。
  //
  // 旧实现一边遍历一边直接改 pos, 属于 Gauss-Seidel 式迭代: 后处理的配对
  // 会把前面刚分开的一对又推回去, 结果在拥挤处反复震荡 —— 30 秒采样里约
  // 5% 的帧仍存在一对重叠 (最小到 2.5)。改成先汇总再应用 (Jacobi 式),
  // 各配对互不干扰, 收敛明显更稳。
  const minD = SEPARATION_DIST;
  const minD2 = minD * minD;
  const n = bots.length;
  // 复用缓冲区, 避免每帧分配
  if (!sepPush || sepPush.length < n * 2) sepPush = new Float32Array(n * 2);
  const push = sepPush;
  push.fill(0);
  let any = false;

  for (let i = 0; i < n; i++) {
    const a = bots[i];
    if (!a.enabled || !a.pos) continue;
    for (let j = i + 1; j < n; j++) {
      const b = bots[j];
      if (!b.enabled || !b.pos) continue;
      // 不同楼层的不算重叠 (上下层同格是正常的)
      if (Math.abs(a.pos[1] - b.pos[1]) > 36) continue;
      let dx = b.pos[0] - a.pos[0];
      let dz = b.pos[2] - a.pos[2];
      const d2 = dx * dx + dz * dz;
      if (d2 >= minD2) continue;
      let d = Math.sqrt(d2);
      if (d < 1e-3) {
        // 完全重合: 用索引差给确定性方向, 避免随机抖动
        const ang = i * 2.399 + j * 1.117;
        dx = Math.cos(ang); dz = Math.sin(ang); d = 1;
      }
      const nx = dx / d, nz = dz / d;
      // 各退一半到刚好不重叠, 再按限速缩放
      const need = (minD - d) * 0.5;
      // 限速要足够高: bot 相向移动时每帧接近 4 单位, 80*dt (=1.3) 追不上,
      // 会在拥挤处反复穿插。放宽到 300*dt, 配合两遍法仍不会瞬移。
      const step = Math.min(need, 300 * dt);
      push[i * 2] -= nx * step;
      push[i * 2 + 1] -= nz * step;
      push[j * 2] += nx * step;
      push[j * 2 + 1] += nz * step;
      any = true;
    }
  }

  if (!any) return;

  // 统一应用, 并按可通行格校验 (不把 bot 推进墙里)
  for (let i = 0; i < n; i++) {
    const b = bots[i];
    if (!b.enabled || !b.pos) continue;
    const dx = push[i * 2], dz = push[i * 2 + 1];
    if (Math.abs(dx) < 1e-6 && Math.abs(dz) < 1e-6) continue;
    const tx = b.pos[0] + dx, tz = b.pos[2] + dz;
    if (!cellBlockedAt([tx, 0, tz])) {
      b.pos[0] = tx;
      b.pos[2] = tz;
    } else if (!cellBlockedAt([b.pos[0] + dx, 0, b.pos[2]])) {
      b.pos[0] += dx;
    } else if (!cellBlockedAt([b.pos[0], 0, b.pos[2] + dz])) {
      b.pos[2] += dz;
    }
  }
}

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------
class Bot {
  constructor(pos, roundNum, role = 'attack', post = null, team = 't') {
    S.serial += 1;
    this.team = team;
    this.name = (team === 'ct' ? 'CT' : 'T') + S.serial;
    this.pos = copy3(safeArr(pos));
    this.health = 100 + (roundNum - 1) * 12;
    this.maxHealth = this.health;
    this.speed = Math.min(190 + roundNum * 8, 240);
    this.fireTimer = rand(0.8, 2.0);
    this.strafeDir = Math.random() < 0.5 ? -1 : 1;
    this.strafeTimer = 0;
    this.attackRange = A.BOT_RANGE;
    // 手雷库存: 与玩家一致, HE 1 颗 / 闪光 2 颗 (CS 1.5 上限)
    const nadeRoll = Math.random();
    this.nades = {
      he: nadeRoll < 0.75 ? 1 : 0,
      flash: nadeRoll < 0.45 ? 2 : (nadeRoll < 0.75 ? 1 : 0),
    };
    this.nadeCd = rand(2, 6);
    this.flash = 0;
    this.stunTimer = 0;
    this.lastSafe = [this.pos[0], 0, this.pos[2]];
    this.carrier = false;
    this.target = null;
    this.scanTimer = 0;
    this.knownPos = null;
    this.knownTime = -99;
    this.role = role;
    this.post = post ? post[0] : null;
    this.watch = post ? post[1] : null;
    this.layer = 0;
    this.goalLayer = 0;
    this.state = 'move';
    this.goal = null;
    this.path = [];
    this.pathLayers = [];
    this.stall = 0;
    this.stallT = 0;
    this.stallAnchor = [this.pos[0], 0, this.pos[2]];
    this.escapeFrames = 0;
    this.repathTimer = 0;
    this.holdTimer = 0;
    this.enabled = true;
    this.yaw = 0;              // 度, 与 state.js / yawTo 一致
    this.muzzleUntil = 0;

    // bot 的枪: 从本方军火库随机取一把, 与其手持模型/枪声/伤害保持一致
    const arsenal = (A.BOT_ARSENAL && A.BOT_ARSENAL[team]) || ['usp'];
    this.weaponId = choice(arsenal);
    this.visual = createVisual(team, this.weaponId);
    addMesh(this.visual.group);
    // 背包式 C4: 只有携带者可见 (局部空间, 根组已缩放 32/72/32)
    this.pack = new THREE.Mesh(
      new THREE.BoxGeometry(0.24, 0.17, 0.11),
      new THREE.MeshBasicMaterial({ color: 0x2d3034 }),
    );
    this.pack.position.set(0, 0.72, -0.18);
    this.pack.visible = false;
    this.visual.group.add(this.pack);
    this.packLed = new THREE.Mesh(
      new THREE.BoxGeometry(0.09, 0.05, 0.02),
      new THREE.MeshBasicMaterial({ color: 0xff3c32 }),
    );
    this.packLed.position.set(0, 0.75, -0.24);
    this.packLed.visible = false;
    this.visual.group.add(this.packLed);
    this.syncVisual();
    this.repath();
  }

  syncVisual() {
    const g = this.visual && this.visual.group;
    if (!g) return;
    g.position.set(this.pos[0], this.pos[1], this.pos[2]);
    // 逻辑 yaw (度) -> three.js +Y 旋转 (弧度): +z -> +x
    g.rotation.y = this.yaw * DEG;
  }

  setCarrier(on) {
    this.carrier = !!on;
    if (this.pack) this.pack.visible = this.carrier;
    if (this.packLed) this.packLed.visible = this.carrier;
    if (on) this.repath();
  }

  stun(dur) { this.stunTimer = Math.max(this.stunTimer, dur); }

  cellBlockedAt(p) { return cellBlockedAt(p); }

  moveAxis(dx, dz) {
    if (Math.hypot(dx, dz) < 1e-6) return;
    // 中心 + 左右 11 单位身位都要落在可通行格; 分轴滑动解墙角死锁
    const clear = (ax, az) => {
      const len = Math.hypot(ax, az);
      if (len < 1e-6) return false;
      const sx = -az / len * 11, sz = ax / len * 11;
      const x = this.pos[0] + ax, z = this.pos[2] + az;
      return !cellBlockedAt([x, 0, z])
        && !cellBlockedAt([x + sx, 0, z + sz])
        && !cellBlockedAt([x - sx, 0, z - sz]);
    };
    if (clear(dx, dz)) {
      this.pos[0] += dx;
      this.pos[2] += dz;
    } else if (Math.abs(dx) > 1e-6 && clear(dx, 0)) {
      this.pos[0] += dx;
    } else if (Math.abs(dz) > 1e-6 && clear(0, dz)) {
      this.pos[2] += dz;
    }
  }

  repath() {
    let goal = null;
    let goalY = this.pos[1];
    const B = S.BOMB;
    if (B.state === 'planted' && B.pos) {
      goal = A.nearestOpen(A.cellOf(B.pos));
      goalY = B.pos[1];
    } else if (this.team === 't' && B.state === 'live' && this.carrier && B.targetPos) {
      goal = A.nearestOpen(A.cellOf(B.targetPos));
      goalY = B.targetPos[1];
    } else if (this.team === 't' && B.state === 'live' && B.drop) {
      goal = A.nearestOpen(A.cellOf(B.drop.pos));
      goalY = B.drop.pos[1];
    } else if (this.state === 'hunt') {
      let kp = this.knownPos;
      if (!kp && this.team === 't') kp = S.botKnownPos;
      if (!kp) {
        this.state = 'pause';
        this.holdTimer = 1;
        return;
      }
      goal = A.nearestOpen(A.cellOf(kp));
      goalY = kp[1];
    } else if (this.team === 't' && B.state === 'live' && B.targetPos && !this.carrier) {
      // 进攻方始终朝包点推进。旧的 pickNearbyGoal 兜底会让它们在自己附近
      // 随机漂移, 实测 40 秒内 T 与 CT 最近距离从未小于 400 单位 —— 整局
      // 没有交战。这里固定把包点周边当作目标, 只做小幅去重以免所有 T 走
      // 完全相同的格子。
      const site = A.cellOf(B.targetPos);
      const ring = ringCells(site, 3, 10, 10);
      goal = ring.length ? choice(ring) : site;
      goalY = B.targetPos[1];
    } else if (this.role === 'defend' && this.post) {
      goal = this.post;
    } else {
      // 巡逻目标就近取: 旧实现从全图 25460 个可走格里随机挑一个 (ROAM_CELLS),
      // 等于每次都让 bot 横穿整张图 —— 既不像 CS 的 bot 行为, 也会让寻路的
      // 目标格每次都不同, 流场缓存永远不命中 (实测每次新目标要重建流场
      // 12~17 ms, 8 个 bot 轮流重算就表现为周期性掉帧)。
      // 现在在自己周围 12~40 格内取点: 路径短、目标重复率高、寻路接近免费。
      goal = pickNearbyGoal(this.pos, 12, 40) || (ROAM_CELLS.length ? choice(ROAM_CELLS) : A.cellOf(this.pos));
    }
    if (!A.layers(goal[0], goal[1]).length) goal = A.nearestOpen(goal);
    this.goal = goal;
    const start = A.nearestOpen(A.cellOf(this.pos));
    const als = A.layers(start[0], start[1]);
    const gls = A.layers(goal[0], goal[1]);
    const al = nearestLayerIndex(als, this.pos[1]);
    const bl = nearestLayerIndex(gls, goalY);
    let p = [];
    try { p = A.findPath(start, goal, al, bl) || []; } catch (e) { p = []; }
    this.goalLayer = bl;
    this.layer = al;
    // A* 的状态含层号, 但路径点高度必须能由 cellPos 复现; 层号超界时钳制
    this.path = p.map(([cx, cy, l]) => {
      const ls = A.layers(cx, cy);
      const li = clamp(Math.floor(l), 0, Math.max(0, ls.length - 1));
      return A.cellPos(cx, cy, ls.length ? ls[li] : 0);
    });
    this.pathLayers = p.map(([cx, cy, l]) => {
      const ls = A.layers(cx, cy);
      return clamp(Math.floor(l), 0, Math.max(0, ls.length - 1));
    });
    if (!this.path.length && this.state === 'hunt') {
      this.state = 'pause';
      this.holdTimer = 1;
    }
  }

  followPath(dt, mult = 1) {
    while (this.path.length) {
      const w = this.path[0];
      if (Math.hypot(w[0] - this.pos[0], w[2] - this.pos[2]) >= 8) break;
      this.path.shift();
      if (this.pathLayers.length) this.layer = this.pathLayers.shift();
    }
    if (!this.path.length) return true;
    const w = this.path[0];
    const dx = w[0] - this.pos[0], dz = w[2] - this.pos[2];
    const len = Math.hypot(dx, dz) || 1;
    // 进攻方离包点还很远时给一点速度补偿: T 出生点到包点约 3800 单位,
    // 按 200 单位/秒要 19 秒纯赶路, 105 秒的回合里几乎没时间交战。
    let sp = this.speed;
    if (this.team === 't' && S.BOMB.targetPos) {
      const far = Math.hypot(S.BOMB.targetPos[0] - this.pos[0],
                             S.BOMB.targetPos[2] - this.pos[2]);
      if (far > 1500) sp *= 1.18;
    }
    const step = sp * mult * dt;
    if (this.escapeFrames > 0) {
      this.escapeFrames -= 1;
      const nx = this.pos[0] + dx / len * step, nz = this.pos[2] + dz / len * step;
      if (!cellBlockedAt([nx, 0, nz])) {
        this.pos[0] = nx;
        this.pos[2] = nz;
      } else {
        const c = A.cellOf(this.pos);
        const center = A.cellPos(c[0], c[1]);
        this.pos[0] = center[0];
        this.pos[2] = center[2];
        this.escapeFrames = 0;
        this.repath();
      }
    } else {
      this.moveAxis(dx / len * step, dz / len * step);
    }
    return false;
  }

  facePath(fallback = null) {
    const p = this.path.length ? this.path[0] : fallback;
    if (!p) return;
    const dx = p[0] - this.pos[0], dz = p[2] - this.pos[2];
    if (Math.hypot(dx, dz) > 0.01) this.yaw = yawTo(dx, dz);
  }

  // 纯几何视线: 只判断中间有没有墙, 不考虑朝向。
  // 旧实现把"目标必须在正前方 ±100°"混进了 LOS, 而 pickTarget 又在转身之前
  // 调用它 —— 实测目标在正后方 100 单位、无遮挡时照样返回 null, bot 于是原地
  // 发呆, 永远发现不了身后的敌人。
  canSee(pos) {
    const eye = obj3([this.pos[0], this.pos[1] + A.EYE_HEIGHT, this.pos[2]]);
    const tgt = obj3([pos[0], pos[1] + A.EYE_HEIGHT, pos[2]]);
    try { return A.gridClear(eye, tgt, 8); } catch (e) { return false; }
  }

  // 目标是否已经在视野锥内 (决定要不要开枪 / 是否需要先转身)
  inFov(pos) {
    const dx = pos[0] - this.pos[0], dz = pos[2] - this.pos[2];
    const len = Math.hypot(dx, dz);
    if (len <= 1) return true;
    const f = Math.sin(this.yaw * DEG) * dx / len
            + Math.cos(this.yaw * DEG) * dz / len;
    return f >= -0.17;              // ±100°
  }

  // 能看见 = 有视线 且 在视野锥内 (保留给交战判定使用)
  hasLOS(pos) {
    return this.canSee(pos) && this.inFov(pos);
  }

  pickTarget() {
    const cand = [];
    for (const t of botTargets(this)) {
      if (!t || !t.pos) continue;
      const d = dist2(t.pos, this.pos);
      if (d <= 0.01 || d > this.attackRange) continue;
      // 只用几何视线筛选; 朝向交给评分和转身处理, 否则背后的敌人永远发现不了
      if (!this.canSee(t.pos)) continue;

      // 评分 (越小越优先):
      //   距离为主项; 正在朝我开火的敌人显著加权; 残血目标优先补枪;
      //   已在视野锥内的额外加分 (省一次转身, 反应更快)
      let score = d;
      const ent = t.ent;
      if (ent) {
        if (ent.target && ent.target.ent === this) score -= 260;
        if (typeof ent.health === 'number' && ent.health < 40) score -= 120;
      }
      if (this.inFov(t.pos)) score -= 150;
      cand.push({ score, d, pos: t.pos, ent });
    }
    if (!cand.length) return null;
    cand.sort((a, b) => a.score - b.score);
    const best = cand[0];
    return { pos: copy3(best.pos), ent: best.ent, d: best.d };
  }

  // 架点: 在 post 锚点附近做"静止观察 -> 侧移 peek -> 回位"的循环。
  // 旧实现只转身不动, bot 是个完全静止的靶子, 架角的进攻方预瞄必胜。
  hold(dt) {
    const kp = this.team === 't'
      ? (S.time - S.botKnownTime < 6 ? S.botKnownPos : null)
      : (S.time - this.knownTime < 6 ? this.knownPos : null);

    // 架点锚点: 优先用 post, 没有就用当前位置
    if (!this.holdAnchor) {
      this.holdAnchor = [this.pos[0], 0, this.pos[2]];
      this.peekPhase = 'idle';
      this.peekTimer = rand(0.6, 1.6);
      this.peekOffset = null;
    }

    // 被打乱位置 (推挤/击退) 后拉回锚点
    if (this.state !== 'combat') {
      const drift = Math.hypot(this.pos[0] - this.holdAnchor[0],
                               this.pos[2] - this.holdAnchor[2]);
      if (drift > 120) {
        this.holdAnchor = [this.pos[0], 0, this.pos[2]];
        this.peekPhase = 'idle';
        this.peekTimer = rand(0.6, 1.6);
      }
    }

    // 观察方向: 有敌情就看向敌情, 否则看 watch 点
    let lookX, lookZ;
    if (kp) {
      lookX = kp[0] - this.pos[0];
      lookZ = kp[2] - this.pos[2];
    } else if (this.watch) {
      const wp = A.cellPos(this.watch[0], this.watch[1], 0);
      const off = Math.sin(S.time * 0.8) * 4;
      const dx = wp[0] - this.pos[0], dz = wp[2] - this.pos[2];
      const len = Math.hypot(dx, dz) || 1;
      lookX = dx + (-dz / len) * off;
      lookZ = dz + (dx / len) * off;
    } else {
      return;
    }
    this.yaw = yawTo(lookX, lookZ);

    // peek 循环 (有敌情时不做, 保持稳定架枪)
    if (kp) { this.peekPhase = 'idle'; return; }

    this.peekTimer -= dt;
    if (this.peekTimer > 0) {
      // 处于返回阶段时走回锚点
      if (this.peekPhase === 'return') {
        const bx = this.holdAnchor[0] - this.pos[0];
        const bz = this.holdAnchor[2] - this.pos[2];
        const d = Math.hypot(bx, bz);
        if (d < 8) { this.peekPhase = 'idle'; this.peekTimer = rand(0.6, 1.6); }
        else {
          const step = Math.min(d, this.speed * 0.55 * dt);
          this.moveAxis(bx / d * step, bz / d * step);
        }
      }
      return;
    }

    if (this.peekPhase === 'idle') {
      // 选一个垂直于观察方向的侧移方向, 要求落点可走
      const len = Math.hypot(lookX, lookZ) || 1;
      const px = -lookZ / len, pz = lookX / len;
      const dist = 16 + Math.random() * 20;
      const sign = Math.random() < 0.5 ? -1 : 1;
      let ox = this.holdAnchor[0] + px * dist * sign;
      let oz = this.holdAnchor[2] + pz * dist * sign;
      if (!cellBlockedAt([ox, 0, oz])) {
        this.peekOffset = [ox, oz];
        this.peekPhase = 'peek';
        this.peekTimer = rand(0.5, 1.0);
      } else {
        this.peekTimer = rand(0.4, 1.0);   // 旁边走不了, 换个时机再试
      }
    } else if (this.peekPhase === 'peek') {
      const ox = this.peekOffset[0] - this.pos[0];
      const oz = this.peekOffset[1] - this.pos[2];
      const d = Math.hypot(ox, oz);
      if (d < 8) {
        this.peekPhase = 'return';
        this.peekTimer = rand(0.5, 1.0);
      } else {
        const step = Math.min(d, this.speed * 0.5 * dt);
        this.moveAxis(ox / d * step, oz / d * step);
      }
    }
  }

  // 交战反应时间: 按距离与武器类别区分。
  // 原实现是固定 0.8~1.5 秒, 与距离/武器无关 —— 贴脸时反应偏慢, 远距离又
  // 显得反应过快。
  reactionDelay(dist) {
    const kind = (A.WEAPONS[this.weaponId] || {}).kind || 'rifle';
    const base = kind === 'sniper' ? 0.55 : kind === 'smg' ? 0.32
               : kind === 'pistol' ? 0.38 : 0.42;
    const distPenalty = Math.min(0.55, Math.max(0, (dist - 120) / 900));
    return base + distPenalty + rand(0, 0.18);
  }

  // 投掷手雷。返回 true 表示本帧已经丢了雷 (不再执行其它行动)。
  // 只在"有敌人情报但打不到"时使用 —— 能直接开枪时扔雷是浪费。
  tryGrenade() {
    if (this.nadeCd > 0) return false;
    if (!this.nades || (this.nades.he <= 0 && this.nades.flash <= 0)) return false;
    if (S.BOMB.state === 'over') return false;

    const kp = this.knownPos;
    if (!kp || S.time - this.knownTime > 6) return false;
    const d = Math.hypot(kp[0] - this.pos[0], kp[2] - this.pos[2]);
    if (d < 180 || d > 900) return false;          // 太近会炸自己, 太远扔不到
    if (this.hasLOS(kp)) return false;             // 能看见就直接开枪
    // 别把雷丢到队友脚下
    for (const ally of S.allies.concat(S.enemies)) {
      if (!ally || !ally.enabled || ally === this || ally.team !== this.team) continue;
      if (Math.hypot(ally.pos[0] - kp[0], ally.pos[2] - kp[2]) < 160) return false;
    }

    const kind = this.nades.he > 0 ? 'he' : 'flash';
    this.nades[kind] -= 1;
    this.nadeCd = rand(7, 14);

    // 弹道: 固定飞行时间, 反解出需要的竖直初速度
    const dx = kp[0] - this.pos[0], dz = kp[2] - this.pos[2];
    const horiz = Math.hypot(dx, dz) || 1;
    const flight = Math.min(1.6, Math.max(0.7, horiz / 550));
    const vh = horiz / flight;
    const dy = kp[1] - (this.pos[1] + A.EYE_HEIGHT);
    // y(t) = vy*t - 0.5*g*t^2 = dy  =>  vy = (dy + 0.5*g*t^2) / t
    const vy = (dy + 0.5 * A.GRAVITY * flight * flight) / flight;

    const eye = [this.pos[0] + (dx / horiz) * 12,
                 this.pos[1] + A.EYE_HEIGHT,
                 this.pos[2] + (dz / horiz) * 12];
    const vel = [(dx / horiz) * vh, vy, (dz / horiz) * vh];

    // 落点预演: 按游戏内同样的积分 (重力 + 落地上限) 模拟一遍,
    // 偏差超过投掷半径就不扔 —— 否则 7 颗雷只有 1 颗能命中。
    const sim = simNadeLanding(eye, vel);
    if (!sim || Math.hypot(sim[0] - kp[0], sim[2] - kp[2]) > 180) {
      this.nades[kind] += 1;      // 撤销消耗
      this.nadeCd = rand(3, 6);
      return false;
    }

    spawnGrenade(kind, eye, vel, flight, this.team);
    return true;
  }



  combat(to, dist, ent, dt) {
    const len = Math.hypot(to[0], to[2]) || 1;
    const fx = to[0] / len, fz = to[2] / len;

    // 目标不在视野内 -> 先转身, 不要盲目横移
    const tp = ent ? ent.pos : S.player.pos;
    if (tp && !this.inFov(tp)) {
      this.yaw = yawTo(tp[0] - this.pos[0], tp[2] - this.pos[2]);
    }

    this.strafeTimer -= dt;
    if (this.strafeTimer <= 0) {
      this.strafeTimer = rand(0.5, 1.2);
      // 受伤时更倾向换向, 降低被持续命中的概率
      if (this.health < this.maxHealth * 0.5 || Math.random() < 0.5) {
        this.strafeDir *= -1;
      }
    }
    this.moveAxis(-fz * this.strafeDir * this.speed * 0.5 * dt,
      fx * this.strafeDir * this.speed * 0.5 * dt);

    // 距离控制: 远压近拉; 残血时优先脱离
    const hurt = this.health < this.maxHealth * 0.35;
    if (dist > 420) {
      this.moveAxis(fx * this.speed * 0.55 * dt, fz * this.speed * 0.55 * dt);
    } else if (dist < 120 || hurt) {
      const back = hurt ? 0.7 : 0.45;
      this.moveAxis(-fx * this.speed * back * dt, -fz * this.speed * back * dt);
    }

    if (this.fireTimer > 0) return;
    if (!tp || !this.hasLOS(tp)) {
      this.fireTimer = 0.3;
      return;
    }
    this.fireTimer = this.reactionDelay(dist);
    const wstat = A.WEAPONS[this.weaponId] || A.WEAPONS.ak47;
    play(wstat.sfx || 'fire_ak47');
    // 枪声广播: 消音武器 (带 _sil) 传得更近
    {
      const silenced = /_sil$/.test(wstat.sfx || '');
      notifyGunfire(this.pos, this.team, silenced ? 0.35 : 1);
    }
    if (this.visual.flash) {
      this.visual.flash.visible = true;
      this.visual.flash.rotation.z = rand(0, Math.PI / 2);
      this.muzzleUntil = S.time + 0.06;
    }
    let hitChance = Math.max(0.14, 0.82 - dist * 0.00065);
    if (dist > 700) hitChance *= 0.72;
    else if (dist > 450) hitChance *= 0.86;
    if (Math.random() >= hitChance) return;
    const base = wstat.dmg * Math.max(1, wstat.pellets | 0 || 1) * 0.28;
    const headshot = Math.random() < 0.12;
    const raw = Math.max(3, Math.round(base * rand(0.75, 1.25)));
    const dmg = headshot ? Math.round(raw * 2.5) : raw;
    const zone = headshot ? 'head' : 'chest';
    if (!ent) {
      damagePlayer(dmg, wstat.armor_ratio ?? 0.5, zone);
    } else if (ent.team !== this.team && ent.enabled && ent.health > 0
      && typeof ent.takeDamage === 'function') {
      ent.takeDamage(dmg, headshot, this.pos, this.name, zone);
    }
  }

  takeDamage(dmg, headshot = false, fromPos = null, killer = '你', zone = null) {
    if (!this.enabled) return;
    this.health -= finite(dmg);
    this.hitZone = zone || (headshot ? 'head' : 'chest');
    if (this.team === 't' && fromPos) reportPlayer(fromPos);
    this.flash = 0.08;
    try { this.visual.setHitFlash(true); } catch (_) { /* 占位模型可忽略 */ }
    const bar = this.visual.hpBar;
    if (bar) {
      // hpBar.scale.x 已被 engine.js 设成 1/32, 用来抵消父级的非等比缩放;
      // 这里要在它的基础上按血量比例缩放, 不能直接覆盖。
      const baseX = bar.userData.baseScaleX || (bar.userData.baseScaleX = bar.scale.x);
      bar.scale.x = baseX * Math.max(0.01, this.health / this.maxHealth);
      if (bar.material && bar.material.color) bar.material.color.setHex(this.health < 40 ? 0xff5050 : 0x50ff50);
    }
    if (this.health <= 0) this.die(headshot, killer);
  }

  die(headshot = false, killer = '你') {
    if (!this.enabled) return;
    this.enabled = false;
    dropMesh(this.visual.group);
    play(headshot ? 'head' : 'kill');
    notifyKill(killer, this.name, headshot);
    if (killer === '你') {
      S.score += 1;
      const wp = A.WEAPONS[S.weapon];
      S.money = Math.min(MONEY_CAP, S.money + (wp ? (wp.kill_reward || 0) : 0));
    } else if (typeof killer === 'string' && killer.startsWith('CT')) {
      S.allyKills += 1;
    }
    spawnDebris(this.pos, 6);
    if (this.team === 't' && this.carrier && S.BOMB.state === 'live') dropC4(this.pos);
    if (S.BOMB.carrier === this) S.BOMB.carrier = null;
    delete S.radarSpotted[this.name];
    const list = this.team === 't' ? S.enemies : S.allies;
    const i = list.indexOf(this);
    if (i >= 0) list.splice(i, 1);
    callUI('updateEquip');
    callUI('updateAmmo');
    // CT 全灭 / T 全灭 (已安放 C4 则仍须拆弹)
    if (this.team === (S.playerTeam || 'ct') && S.player.dead && S.allies.length === 0) {
      roundEnd(enemyTeam(), 'killed');
    }
    if (this.team === 't' && S.enemies.length === 0 && S.BOMB.spawnLeft <= 0
      && S.BOMB.state === 'live') roundEnd('ct', 'eliminated');
  }

  c4Behavior(dt) {
    const B = S.BOMB;
    if (this.team !== 't' || B.state !== 'live') return false;
    if (!this.carrier && B.drop && dist3(this.pos, B.drop.pos) < 48) {
      clearBombMesh('drop');
      B.drop = null;
      B.carrier = this;
      B.plant = 0;
      this.setCarrier(true);
      play('c4_plant');
      showCenter('T 拾起了 C4!', '#ff965a');
    }
    if (this.carrier && B.targetPos && Math.abs(this.pos[1] - B.targetPos[1]) < 48) {
      const flat = dist2(this.pos, B.targetPos);
      if (flat < A.PLANT_RADIUS) {
        B.plant += dt;
        this.yaw = yawTo(B.targetPos[0] - this.pos[0], B.targetPos[2] - this.pos[2]);
        if (B.plant >= A.PLANT_TIME) plantC4(this.pos);
        return true;                     // 安放过程锁定原地
      }
      B.plant = 0;
    }
    return false;
  }

  update(dt) {
    // 受击闪白恢复不受回合结算/购买菜单冻结影响
    if (this.flash > 0) {
      this.flash -= dt;
      if (this.flash <= 0) {
        try { this.visual.setHitFlash(false); } catch (_) { /* ignore */ }
      }
    }
    if (this.muzzleUntil && S.time >= this.muzzleUntil) {
      if (this.visual.flash) this.visual.flash.visible = false;
      this.muzzleUntil = 0;
    }
    if (S.buyMenuOpen || S.BOMB.state === 'over') { this.syncVisual(); return; }
    if (this.stunTimer > 0) {
      this.stunTimer -= dt;
      this.syncVisual();
      return;
    }
    if (this.c4Behavior(dt)) { this.syncVisual(); return; }

    this.fireTimer -= dt;
    this.repathTimer -= dt;
    this.scanTimer -= dt;
    if (this.scanTimer <= 0) {
      this.scanTimer = 0.15;
      this.target = this.pickTarget();
      // 没看到人但听到交火 -> 去支援。
      // 之前没有任何声音传播, 实测 T 打 B 点时守 A 的 CT 会整局不动。
      // 下包后 CT 必须直奔炸弹, 而不是 hunt 最后已知位置。
      // 实测: B 点下包后 CT 4 人全部 hunt, 70 秒仍离炸弹 1200+ 单位。
      if (!this.target && this.team === 'ct' && S.BOMB.state === 'planted'
          && S.BOMB.pos && this.state !== 'combat') {
        if (this.state !== 'move') {
          this.state = 'move';
          this.repath();
        }
      }
      if (!this.target && this.state !== 'combat') {
        this.rotateTimer = (this.rotateTimer || 0) - 0.15;
        if (this.rotateTimer <= 0) {
          // A 点到 B 点约 2700 单位, 听觉半径必须覆盖整张地图, 否则
          // 守 A 的 CT 永远听不到 B 点的交火 (实测 2000 半径时零反应)。
          const heard = heardGunfire(this.pos, 3600);
          if (heard && heard.team !== this.team) {
            this.knownPos = [heard.pos[0], heard.pos[1], heard.pos[2]];
            this.knownTime = S.time;
            this.rotateTimer = 4.5;      // 冷却, 避免在两点之间来回摆
            this.state = 'hunt';
            this.repath();
            if (this.team === 'ct' && S.time - (S.lastRadioAt || -99) > 6) {
              S.lastRadioAt = S.time;
              play('radio');
            }
          }
        }
      }
      if (this.target) {
        this.knownPos = copy3(this.target.pos);
        this.knownTime = S.time;
        if (this.team === 't' && this.target.ent === null) reportPlayer(S.player.pos);
        else if (this.team === 'ct' && this.target.ent) radioContact(this.target.ent, this);
      }
    }
    let tgt = this.target;
    if (tgt && tgt.ent && (!tgt.ent.enabled || tgt.ent.health <= 0)) {
      tgt = null;
      this.target = null;
    }
    // 打不到但有情报 -> 试着手雷压制
    this.nadeCd -= dt;
    if (this.state !== 'combat' && this.tryGrenade()) { this.syncVisual(); return; }

    const canSee = tgt !== null && S.time - this.knownTime < 0.45;
    if (canSee) {
      if (this.state !== 'combat') this.state = 'combat';
    } else if (this.state === 'combat') {
      this.state = 'hunt';
      this.repath();
    }

    if (this.state === 'combat') {
      const to = [tgt.pos[0] - this.pos[0], 0, tgt.pos[2] - this.pos[2]];
      this.yaw = yawTo(to[0], to[2]);
      this.combat(to, tgt.d, tgt.ent, dt);
    } else if (this.state === 'hunt') {
      if (!this.knownPos || S.time - this.knownTime > 12) {
        // 下包后即使情报过期也要继续走向炸弹, 不能退回自己的 post。
        // 旧逻辑下 CT 走到半路情报过期 -> move -> repath 回原 post -> 循环,
        // 实测 B 点下包 70 秒后 CT 仍离炸弹 889 单位。
        const toBomb = (this.team === 'ct' && S.BOMB.state === 'planted' && S.BOMB.pos);
        this.state = (this.role === 'defend' && !toBomb) ? 'move' : (toBomb ? 'move' : 'pause');
        if (toBomb) { this.knownPos = null; this.knownTime = -99; }
        this.holdTimer = 1;
        this.repath();
      } else if (this.repathTimer <= 0) {
        this.repathTimer = 3.5;
        this.repath();
      }
      if (this.followPath(dt, 1.15)) {
        this.state = this.role === 'defend' ? 'move' : 'pause';
        this.holdTimer = rand(1.5, 3);
        this.repath();
      }
      this.facePath(this.knownPos || S.player.pos);
    } else if (this.state === 'move') {
      if (this.followPath(dt, 1)) {
        // 炸弹已安放时不能停在 post 上守着 —— 必须继续去拆包
        const defusing = (this.team === 'ct' && S.BOMB.state === 'planted');
        if (defusing) { this.repath(); }
        else if (this.role === 'defend') this.state = 'hold';
        else { this.state = 'pause'; this.holdTimer = rand(1.5, 3.5); }
      }
      this.facePath();
    } else if (this.state === 'pause') {
      this.holdTimer -= dt;
      if (this.holdTimer <= 0) {
        const fresh = S.botKnownPos && S.time - S.botKnownTime < 10;
        // 进攻方即使没有敌人情报也要继续压向包点, 不能退化成原地巡逻
        if (fresh) this.state = 'hunt';
        else this.state = 'move';
        this.repath();
      }
    } else if (this.state === 'hold') {
      if (S.BOMB.state === 'planted' && this.repathTimer <= 0) {
        this.repathTimer = 3;
        this.state = 'move';
        this.repath();
      }
      this.hold(dt);
    }

    // 贴地锁定: 取当前格第 layer 层
    this.pos[1] = 0.05 + surfaceY(this.pos, this.layer);
    if (this.cellBlockedAt(this.pos)) {
      this.pos[0] = this.lastSafe[0];
      this.pos[2] = this.lastSafe[2];
      this.pos[1] = 0.05 + surfaceY(this.lastSafe, this.layer);
    } else {
      this.lastSafe = [this.pos[0], 0, this.pos[2]];
    }

    // 0.5s 净位移窗口检测卡墙
    this.stallT += dt;
    if (this.stallT >= 0.5) {
      const now = [this.pos[0], 0, this.pos[2]];
      if (Math.hypot(now[0] - this.stallAnchor[0], now[2] - this.stallAnchor[2]) < 0.6) {
        this.stall += this.stallT;
      } else {
        this.stall = 0;
      }
      this.stallT = 0;
      this.stallAnchor = now;
    }
    if (this.stall > 1.0) {
      const c = A.cellOf(this.pos);
      const center = A.cellPos(c[0], c[1]);
      this.pos[0] = center[0];
      this.pos[2] = center[2];
      this.lastSafe = [center[0], 0, center[2]];
      this.stall = 0;
      this.stallAnchor = [center[0], 0, center[2]];
      this.escapeFrames = 30;
      this.repath();
    }
    this.syncVisual();
  }
}

// ---------------------------------------------------------------------------
// 跨模块钩子: 动作类由 game.js 实现, 展示类转交给注册前已有的 hud / engine
// ---------------------------------------------------------------------------
const actionHooks = Object.create(null);   // name -> game.js 动作实现
const prevHooks = Object.create(null);     // name -> 注册前的 hud / engine 实现
const relayHooks = new Set();              // 纯展示类, 直接转发

function registerHook(name, fn) {
  const vm = S.engine && S.engine.buildViewmodel;
  if (typeof S.hooks[name] === 'function'
      && !(name === 'switchWeapon' && vm && S.hooks[name] === vm)) {
    prevHooks[name] = S.hooks[name];
  }
  actionHooks[name] = fn;
  S.hooks[name] = fn;
}

function callUI(name, ...args) {
  const fn = prevHooks[name];
  if (typeof fn === 'function') {
    try { fn(...args); } catch (e) { console.warn(`[game] hook ${name}`, e); }
  }
  // engine 可能在 initGame 之后才写入 buildViewmodel; 兜底重建第一人称武器
  const vm = S.engine && S.engine.buildViewmodel;
  if (name === 'switchWeapon' && typeof vm === 'function' && vm !== fn) {
    try { vm(...args); } catch (e) { console.warn('[game] buildViewmodel', e); }
  }
}

function notifyKill(killer, victim, headshot) {
  addKill(killer, victim, headshot);               // state.js -> S.hooks.addKill -> hud
  if (typeof prevHooks.killFeed === 'function'
      && prevHooks.killFeed !== prevHooks.addKill) {
    callUI('killFeed', killer, victim, headshot);
  }
}

// ---------------------------------------------------------------------------
// 目标 / 生成 / 清理
// ---------------------------------------------------------------------------
export function botTargets(bot) {
  const out = [];
  if (bot.team === (S.playerTeam || 'ct')) {
    for (const e of S.enemies) {
      if (e && e.enabled && e.health > 0) out.push({ pos: e.pos, ent: e });
    }
  } else {
    if (!S.player.dead && S.player.hp > 0) out.push({ pos: S.player.pos, ent: null });
    for (const a of S.allies) {
      if (a && a.enabled && a.health > 0) out.push({ pos: a.pos, ent: a });
    }
  }
  return out;
}

function spawnPoint(list, used, jitter) {
  const all = Array.isArray(list) ? list : [];
  const free = all.filter(p => !used.has(p));
  const pool = free.length ? free : all;
  if (!pool.length) return [0, 0.05, 0];
  const base = choice(pool);
  used.add(base);
  return [base[0] + rand(-jitter, jitter), (base[1] || 0) + 0.05,
    base[2] + rand(-jitter, jitter)];
}

// ---------------------------------------------------------------------------
// Teams
//
// The half-time swap means the player is not always CT, so every place that
// used to hardcode 'ct' derives from these instead.
// ---------------------------------------------------------------------------
export function enemyTeam() {
  return (S.playerTeam === 't') ? 'ct' : 't';
}

// In CS the T side always attacks (carries the C4) and CT always defends.
// The swap changes which TEAM the player is on, not which side attacks.
export function attackTeam() {
  return 't';
}

export function playerIsAttacker() {
  return (S.playerTeam || 'ct') === 't';
}

export function spawnBot() {
  const team = enemyTeam();
  // T always attacks and spawns at the T spawns; CT defends at its own spawns.
  const attacks = (team === 't');
  const pos = spawnPoint(attacks ? A.tSpawns : A.playerSpawns, S.usedBotSpawns, 0.8);
  const bot = new Bot(pos, S.roundNum, attacks ? 'attack' : 'defend', null, team);
  S.enemies.push(bot);
  spawnCounter += 1;
  // Only the attacking side carries the bomb.
  if (attacks && spawnCounter === 1) {
    S.BOMB.carrier = bot;
    bot.setCarrier(true);
  }
  S.BOMB.spawnLeft = Math.max(0, S.BOMB.spawnLeft - 1);
  return bot;
}

export function spawnAlly() {
  const team = S.playerTeam || 'ct';
  const attacks = (team === 't');
  const pos = spawnPoint(attacks ? A.tSpawns : A.playerSpawns, S.usedAllySpawns, 0.7);
  const post = attacks ? null
    : (DEF_POSTS.length ? DEF_POSTS[S.allies.length % DEF_POSTS.length] : null);
  const bot = new Bot(pos, S.roundNum, attacks ? 'attack' : 'defend', post, team);
  S.allies.push(bot);
  return bot;
}

export function clearBots() {
  for (const bot of S.enemies.concat(S.allies)) {
    if (bot && bot.visual) dropMesh(bot.visual.group);
    if (bot) bot.enabled = false;
  }
  S.enemies.length = 0;
  S.allies.length = 0;
  S.usedBotSpawns.clear();
  S.usedAllySpawns.clear();
  spawnCounter = 0;
  S.BOMB.carrier = null;
}

// ---------------------------------------------------------------------------
// 碎块 / 手雷
// ---------------------------------------------------------------------------
function spawnDebris(pos, count) {
  for (let i = 0; i < count; i++) {
    const p = [pos[0] + rand(-6, 6), pos[1] + rand(8, 32), pos[2] + rand(-6, 6)];
    const mesh = makeBox([rand(3, 6), rand(3, 6), rand(3, 6)], 0x965a3c, p);
    S.debris.push({ mesh, pos: copy3(p), vel: [rand(-140, 140), rand(90, 240), rand(-140, 140)], ttl: 1.4 });
  }
}

function updateDebris(dt) {
  for (let i = S.debris.length - 1; i >= 0; i--) {
    const d = S.debris[i];
    d.ttl -= dt;
    d.vel[1] -= A.GRAVITY * dt;
    d.pos[0] += d.vel[0] * dt;
    d.pos[1] += d.vel[1] * dt;
    d.pos[2] += d.vel[2] * dt;
    if (d.mesh) {
      d.mesh.position.set(d.pos[0], d.pos[1], d.pos[2]);
      d.mesh.rotation.x += 5 * dt;
      d.mesh.rotation.y += 3.5 * dt;
    }
    if (d.ttl <= 0) {
      dropMesh(d.mesh);
      S.debris.splice(i, 1);
    }
  }
}

function clearListMeshes(list) {
  for (const o of list) dropMesh(o && o.mesh);
  list.length = 0;
}

// 生成一枚手雷 (玩家与 bot 共用)。
// pos 是出手点, vel 是初速度向量, fuse 是引信秒数。
export function spawnGrenade(kind, pos, vel, fuse = 1.5, team = null) {
  const col = kind === 'he' ? 0x465a3c : (kind === 'flash' ? 0xc8c8cd : 0x50565c);
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(2, 8, 6),
    new THREE.MeshBasicMaterial({ color: col }),
  );
  mesh.position.set(pos[0], pos[1], pos[2]);
  addMesh(mesh);
  S.grenades.push({ kind, mesh, pos: [pos[0], pos[1], pos[2]],
                    vel: [vel[0], vel[1], vel[2]], fuse, team });
  play('pin');
  return true;
}

// 预演手雷落点 (与 updateGrenades 的积分规则一致), 返回落点坐标。
// bot 投掷前用它校验: 偏得太远就不扔, 避免无意义的浪费。
function simNadeLanding(pos, vel) {
  let x = pos[0], y = pos[1], z = pos[2];
  let vx = vel[0], vy = vel[1], vz = vel[2];
  const step = 1 / 30;
  for (let i = 0; i < 90; i++) {          // 最多 3 秒
    vy -= A.GRAVITY * step;
    x += vx * step; y += vy * step; z += vz * step;
    const c = A.cellOf([x, y, z]);
    const g = A.surfaceAt(c[0], c[1], y);
    if (g !== null && g !== undefined && y < g + 4) {
      return [x, g + 4, z];
    }
  }
  return null;
}

export function throwNade(kind) {
  if (kind !== 'he' && kind !== 'flash' && kind !== 'smoke') return;
  if (S.buyMenuOpen || S.player.dead || S.BOMB.state === 'over') return;
  if (!S.player.nades[kind] || S.player.nades[kind] <= 0) return;
  S.player.nades[kind] -= 1;
  callUI('updateEquip');

  const p = S.player;
  const yaw = p.yaw * DEG, pitch = p.pitch * DEG;
  const fwd = [Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)]
  const cam = typeof getCamera === 'function' ? getCamera() : null;
  const eye = cam ? [cam.position.x, cam.position.y, cam.position.z]
    : [p.pos[0], p.pos[1] + A.EYE_HEIGHT, p.pos[2]];
  const pos = [eye[0] + fwd[0] * 12, eye[1] + fwd[1] * 12, eye[2] + fwd[2] * 12];
  // CS 1.5 手雷配色: HE 橄榄绿 / 闪光 银白 / 烟雾 灰蓝
  spawnGrenade(kind, pos, [fwd[0] * 750, fwd[1] * 750 + 90, fwd[2] * 750], 1.5,
    S.playerTeam || 'ct');
}

// 烟雾弹: 一团会膨胀并逐渐消散的烟球 (CS 1.5 的 smokescreen 是纯视觉遮挡)
function smokePuff(pos) {
  const radius = SMOKE_RADIUS;
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 0.5, 10, 8),
    new THREE.MeshBasicMaterial({
      color: 0x9aa0a6, transparent: true, opacity: 0.78,
      depthWrite: false, side: THREE.DoubleSide,
    }),
  );
  mesh.position.set(pos[0], pos[1] + radius * 0.4, pos[2]);
  mesh.renderOrder = 2;
  addMesh(mesh);
  S.smokes.push({ mesh, pos: [pos[0], pos[1], pos[2]], ttl: SMOKE_TIME, born: S.time, radius });
}

function updateSmokes(dt) {
  for (let i = S.smokes.length - 1; i >= 0; i--) {
    const s = S.smokes[i];
    s.ttl -= dt;
    if (!s.mesh) { S.smokes.splice(i, 1); continue; }
    const age = S.time - s.born;
    // 0.4s 内膨胀到满, 最后 2s 淡出
    const grow = Math.min(1, age / 0.4);
    const fade = Math.min(1, Math.max(0, s.ttl / 2));
    s.mesh.scale.setScalar(0.4 + 0.6 * grow);
    s.mesh.material.opacity = 0.78 * fade;
    if (s.ttl <= 0) { dropMesh(s.mesh); S.smokes.splice(i, 1); }
  }
}

function explodeNade(g) {
  const pos = g.pos;
  const eye = obj3([pos[0], pos[1], pos[2]]);
  // 烟雾弹没有伤害/致盲, 单独走一条分支: 生成一团会消散的烟球
  if (g.kind === 'smoke') {
    play('he_bounce');                    // CS 1.5 烟雾弹落地的"噗"声
    smokePuff(pos);
    dropMesh(g.mesh);
    const si = S.grenades.indexOf(g);
    if (si >= 0) S.grenades.splice(si, 1);
    return;
  }
  const radius = g.kind === 'he' ? HE_RADIUS : FLASH_RADIUS;
  play(g.kind === 'he' ? 'explode' : 'flash');
  // 玩家眼位: 与 bot 判定用同一个采样点, 保证三方规则一致
  const playerEye = [S.player.pos[0], S.player.pos[1] + A.EYE_HEIGHT, S.player.pos[2]];
  const playerWithinRadius = !S.player.dead
    && dist3(pos, playerEye) < radius
    && A.gridClear(eye, obj3(playerEye), 8);   // 墙后不生效 (旧实现漏了这个判定)

  if (g.kind === 'he') {
    for (const bot of S.enemies.concat(S.allies).slice()) {
      if (!bot.enabled || bot.health <= 0) continue;
      // CS 1.5 默认 mp_friendlyfire 0: 自己的雷不伤队友。子弹路径同样跳过
      // team 'ct' (engine.js); 这里之前漏了, 往队友脚下扔一颗就能刷分刷钱。
      if (g.team && bot.team === g.team) continue;
      const t = obj3([bot.pos[0], bot.pos[1] + A.EYE_HEIGHT, bot.pos[2]]);
      const d = dist3(pos, [bot.pos[0], bot.pos[1] + A.EYE_HEIGHT, bot.pos[2]]);
      if (d >= radius || !A.gridClear(eye, t, 8)) continue;
      bot.takeDamage(Math.round(100 * (1 - d / radius)), false, pos, '你');
    }
    if (playerWithinRadius) {
      const pd = dist3(pos, playerEye);
      damagePlayer(Math.round(100 * (1 - pd / radius)));
    }
    spawnDebris(pos, 10);
  } else {
    // 闪光: 按距离与遮挡衰减, 不再是"全图无条件满屏白"
    if (playerWithinRadius) {
      const pd = dist3(pos, playerEye);
      const falloff = 1 - pd / radius;                 // 0..1, 越近越强
      const amount = Math.round(120 + 115 * Math.max(0, Math.min(1, falloff)));
      S.whiteFlash = Math.max(S.whiteFlash, amount);
    }
    for (const bot of S.enemies.concat(S.allies)) {
      if (!bot.enabled) continue;
      const t = obj3([bot.pos[0], bot.pos[1] + A.EYE_HEIGHT, bot.pos[2]]);
      const d = dist3(pos, [bot.pos[0], bot.pos[1] + A.EYE_HEIGHT, bot.pos[2]]);
      if (d < radius && A.gridClear(eye, t, 8)) bot.stun(Math.max(1, 3 * (1 - d / radius)));
    }
  }
  reportPlayer(pos);                 // 爆炸声同样会吸引 bot
  dropMesh(g.mesh);
  const i = S.grenades.indexOf(g);
  if (i >= 0) S.grenades.splice(i, 1);
}

function updateGrenades(dt) {
  if (S.BOMB.state === 'over') return;
  if (S.buyMenuOpen) return;
  for (const g of S.grenades.slice()) {
    g.fuse -= dt;
    g.vel[1] -= A.GRAVITY * dt;

    // 对"本帧位移"做一次射线检测, 命中墙面就反射。之前完全没有碰撞,
    // 手雷会直接穿墙飞进房间 —— 子弹一直走 raySolidDistance, 这里漏了。
    const px = g.pos[0], py = g.pos[1], pz = g.pos[2];
    const vx = g.vel[0] * dt, vy = g.vel[1] * dt, vz = g.vel[2] * dt;
    const stepLen = Math.hypot(vx, vy, vz);
    if (stepLen > 1e-6) {
      const hit = A.raySolidDistance(px, py, pz, vx, vy, vz, stepLen);
      if (hit >= 0 && hit < stepLen) {
        // 逐轴试探判断撞的是哪一面 (小步长下等价于按轴反射)
        const blockedX = Math.abs(vx) > 1e-6 &&
          A.raySolidDistance(px, py, pz, vx, 0, 0, Math.abs(vx)) >= 0;
        const blockedZ = Math.abs(vz) > 1e-6 &&
          A.raySolidDistance(px, py, pz, 0, 0, vz, Math.abs(vz)) >= 0;
        const blockedY = Math.abs(vy) > 1e-6 &&
          A.raySolidDistance(px, py, pz, 0, vy, 0, Math.abs(vy)) >= 0;
        if (blockedX) g.vel[0] = -g.vel[0] * 0.45;
        if (blockedZ) g.vel[2] = -g.vel[2] * 0.45;
        if (blockedY) g.vel[1] = -g.vel[1] * 0.45;
        // 位置保持在墙前, 避免嵌进几何
        g.pos[0] = px; g.pos[1] = py; g.pos[2] = pz;
      } else {
        g.pos[0] = px + vx; g.pos[1] = py + vy; g.pos[2] = pz + vz;
      }
    }
    const c = A.cellOf(g.pos);
    const ground = A.surfaceAt(c[0], c[1], g.pos[1]);
    if (ground !== null && ground !== undefined && g.pos[1] < ground + 4) {
      g.pos[1] = ground + 4;
      g.vel[1] = Math.abs(g.vel[1]) * 0.32;
      g.vel[0] *= 0.72;
      g.vel[2] *= 0.72;
      if (g.vel[1] < 12) g.vel[1] = 0;
    }
    if (g.mesh) {
      g.mesh.position.set(g.pos[0], g.pos[1], g.pos[2]);
      g.mesh.rotation.x += 6.6 * dt;
      g.mesh.rotation.z += 4.5 * dt;
    }
    if (g.fuse <= 0) explodeNade(g);
  }
}

// ---------------------------------------------------------------------------
// C4 / 回合
// ---------------------------------------------------------------------------
function clearBombMesh(key) {
  const m = bombMeshes[key];
  if (m) dropMesh(m);
  bombMeshes[key] = null;
}

function clearBombEntities() {
  for (const k of ['entity', 'led', 'drop']) clearBombMesh(k);
  S.BOMB.drop = null;
}

export function plantC4(pos) {
  const B = S.BOMB;
  if (B.state !== 'live') return;
  const p = safeArr(pos);
  B.state = 'planted';
  B.wasPlanted = true;             // 记下本回合确实下过包 (T 输了也有 +$800)
  B.c4Left = A.C4_TIME;
  const c = A.cellOf(p);
  let ground = A.surfaceAt(c[0], c[1], p[1]);
  if (ground === null || ground === undefined) ground = B.targetPos ? B.targetPos[1] : 0;
  B.pos = [p[0], ground + 3, p[2]];
  clearBombMesh('entity');
  clearBombMesh('led');
  clearBombMesh('drop');
  B.drop = null;
  bombMeshes.entity = makeBox([12, 5, 9], 0x2a2e32, B.pos);
  bombMeshes.led = makeBox([3, 1.5, 3], 0xff3228, [B.pos[0], B.pos[1] + 3.5, B.pos[2]]);
  B.plant = 0;
  B.beepAt = 0;
  B.defuse = 0;
  B.allyDefuse = 0;
  play('c4_plant');
  showCenter(`C4 已在 ${B.site} 点安放!  按住 E 拆除`, '#ff645a');
  for (const e of S.enemies) {
    e.setCarrier(false);
    e.state = 'hunt';
    e.repath();
  }
  for (const a of S.allies) {
    a.knownPos = copy3(B.pos);
    a.knownTime = S.time;
    a.state = 'hunt';
    a.repath();
  }
}

export function dropC4(pos) {
  const B = S.BOMB;
  if (B.state !== 'live' || B.drop) return;
  const p = safeArr(pos);
  B.carrier = null;
  B.plant = 0;
  const ground = groundAt(p, B.targetPos ? B.targetPos[1] : 0);
  const dp = [p[0], ground + 3, p[2]];
  clearBombMesh('drop');
  bombMeshes.drop = makeBox([12, 5, 9], 0xcd3c2d, dp);
  B.drop = { pos: dp, mesh: bombMeshes.drop };
  showCenter('C4 掉落了!  阻止 T 拾取', '#ffbe5a');
}

export function explodeC4() {
  play('explode');
  S.whiteFlash = 235;
  roundEnd('t', 'exploded');
}

// CS 1.5 回合经济:
//   胜方 +$3250 (拆弹/守点/团灭), 负方按连败次数递增 1400/1900/2400/2900/3400,
//   上限 3400。旧实现固定给负方 1400, 导致落后一方永远翻不了身。
const LOSS_BONUS = [1400, 1900, 2400, 2900, 3400];
const WIN_BONUS = 3250;
const BOMB_PLANT_BONUS = 800;      // T 安放 C4 即使输了也有 800 (鼓励下包)

// ---------------------------------------------------------------------------
// Match structure (CS 1.5 competitive)
// ---------------------------------------------------------------------------
export function matchState() {
  return S.match;
}

// Decide the winner from the whole-match totals.
function decideMatchWinner() {
  const M = S.match;
  const need = M.roundsPerHalf + 1;          // MR15 -> 16 rounds to win
  if (M.ctScoreTotal >= need) return 'ct';
  if (M.tScoreTotal >= need) return 't';
  const played = M.ctScoreTotal + M.tScoreTotal;
  if (played >= M.maxRounds) {
    // Regulation exhausted: higher score wins, equal score is a draw.
    if (M.ctScoreTotal > M.tScoreTotal) return 'ct';
    if (M.tScoreTotal > M.ctScoreTotal) return 't';
    return 'draw';
  }
  return null;
}

// Called once at the end of every round, after S.ctScore / S.tScore changed.
function updateMatchScore() {
  const M = S.match;
  if (M.over) return false;

  // Recompute whole-match totals from the per-half counters.
  if (M.half === 1) {
    M.ctScoreTotal = S.ctScore;
    M.tScoreTotal = S.tScore;
  } else {
    M.ctScoreTotal = M.half1CT + S.ctScore;
    M.tScoreTotal = M.half1T + S.tScore;
  }

  // Half-time swap FIRST: if this round completed the first half, the totals
  // above are the final first-half numbers, and the match-winner check below
  // must not run against them (a team on 15 cannot have "won" yet even if the
  // total momentarily reads 16 after the swap).
  const played = M.ctScoreTotal + M.tScoreTotal;
  if (M.half === 1 && played >= M.roundsPerHalf) {
    M.half = 2;
    M.half1CT = M.ctScoreTotal;
    M.half1T = M.tScoreTotal;
    S.ctScore = 0;
    S.tScore = 0;
    S.playerTeam = S.playerTeam === 'ct' ? 't' : 'ct';
    S.lossStreak = 0;
    S.money = 800;                 // 半场重置经济 (pistol round)
    showCenter('------ 半场结束, 交换攻防 ------', '#ffd678');
    return false;
  }

  const winner = decideMatchWinner();
  if (winner) {
    M.over = true;
    M.winner = winner;
    return true;
  }
  return false;
}

export function roundEnd(winner, reason) {
  const B = S.BOMB;
  if (B.state === 'over') return;
  B.state = 'over';
  let msg, color, reward;
  if (winner === 'ct') {
    S.ctScore += 1;
    S.lossStreak = 0;
    if (reason === 'defused') {
      play('c4_defuse');
      msg = 'C4 已拆除 - CT 胜利!';
    } else if (reason === 'timeout') {
      play('win');
      msg = '时间耗尽 - CT 守住包点!';
    } else {
      play('win');
      msg = 'T 全灭 - CT 胜利!';
    }
    color = '#78ff78';
    reward = WIN_BONUS;
  } else {
    S.tScore += 1;
    play('lose');
    S.player.armor = 0;
    S.player.hasHelmet = false;
    if (reason === 'killed') S.player.hasKit = false;
    updateEquipText();
    // 连败奖励: 输一次 +1 档, 上限 3400
    const idx = Math.min(S.lossStreak, LOSS_BONUS.length - 1);
    reward = LOSS_BONUS[idx];
    S.lossStreak = Math.min(S.lossStreak + 1, LOSS_BONUS.length);
    color = '#ff6464';
    if (reason === 'exploded') msg = `C4 爆炸 - 回合失败`;
    else {
      S.whiteFlash = 0;
      msg = `你阵亡了 - 回合失败`;
    }
    // T 已安放 C4 的额外奖励
    // 注意: +$800 是 CS 1.5 给 T 方的下包奖励, 而玩家是 CT。
    // 旧代码把它加进了 S.money (玩家钱包), 等于 CT 挨炸反而多拿钱。
    // 这里只保留提示文案, 不加钱。
  }
  S.money = Math.min(MONEY_CAP, S.money + reward);
  msg += `  +$${reward}`;
  showCenter(msg, color);
  callUI('updateEquip');
  callUI('updateAmmo');
  callUI('showSpectate', '');
  const matchOver = updateMatchScore();
  if (matchOver) {
    const M = S.match;
    if (M.winner === 'draw') {
      showCenter(`比赛结束 - 平局 ${M.ctScoreTotal}:${M.tScoreTotal}`, '#ffd678');
    } else {
      const won = (M.winner === S.playerTeam);
      showCenter(`比赛结束 - ${M.winner.toUpperCase()} 获胜 ${M.ctScoreTotal}:${M.tScoreTotal}` +
                 (won ? '  (你赢了!)' : '  (你输了)'), won ? '#78ff78' : '#ff6464');
      play(won ? 'win' : 'lose');
    }
    return;
  }
  later(nextRound, 4);
}

function tickRound(dt) {
  const B = S.BOMB;
  if (B.state === 'over') return;
  if (B.state === 'live') {
    // 购买菜单只允许在购买窗口内打开。窗口一过就强制关闭 —— 否则玩家
    // 可以开局按 B 后一直不关, 8 个 bot 全部冻结 (Bot.update 早退) 而回合
    // 计时照走, 105 秒后 timeout, CT 白拿 +$3250。
    // 注意不能用「暂停计时」的方式, 那只是换一种拖延。
    if (S.buyMenuOpen && A.ROUND_TIME - B.roundLeft > BUY_WINDOW) {
      S.buyMenuOpen = false;
      callUI('toggleBuy', false);
    }
    B.roundLeft -= dt;
    const left = Math.max(0, B.roundLeft);
    B.timerText = fmtTime(left);
    if (left <= 0) roundEnd('ct', 'timeout');
    return;
  }
  if (B.state !== 'planted') return;

  B.c4Left -= dt;
  const left = Math.max(0, B.c4Left);
  B.timerText = `C4 ${fmtTime(left)}`;
  if (S.time >= B.beepAt) {
    play('c4_beep');
    const ratio = Math.max(0, left / A.C4_TIME);
    B.beepAt = S.time + Math.max(0.10, 0.95 * ratio ** 2);
  }
  const led = bombMeshes.led;
  if (led && led.material && led.material.color) {
    led.material.color.setHex(Math.floor(S.time * 5) % 2 ? 0xff3c2d : 0x461e1e);
  }
  if (left <= 0) { explodeC4(); return; }
  if (!B.pos) return;

  const p = S.player.pos;
  const flat = dist2(p, B.pos);
  const near = flat < A.DEFUSE_RANGE && Math.abs(p[1] - B.pos[1]) < 48;
  const need = S.player.hasKit ? A.KIT_DEFUSE_TIME : A.DEFUSE_TIME;
  if (near && S.defuseHeld && !S.buyMenuOpen && !S.player.dead) {
    B.defuse += dt;
    if (B.defuse >= need) { roundEnd('ct', 'defused'); return; }
  } else {
    B.defuse = Math.max(0, B.defuse - dt * 1.5);
  }

  const helper = S.allies.find(a => a.enabled && a.health > 0 && dist3(a.pos, B.pos) < A.DEFUSE_RANGE);
  if (helper && (S.player.dead || flat > A.DEFUSE_RANGE)) {
    B.allyDefuse += dt;
    if (S.player.dead) callUI('showSpectate', `${helper.name} 正在拆除 C4  ${Math.max(0, 8 - B.allyDefuse).toFixed(0)}s`);
    if (B.allyDefuse >= 8) { roundEnd('ct', 'defused'); return; }
  } else {
    B.allyDefuse = Math.max(0, B.allyDefuse - dt * 0.6);
    if (S.player.dead) callUI('showSpectate', '你已阵亡  ·  观战队友');
  }
}

export function nextRound() {
  cancelTimers(true);
  clearBots();
  // 回合换了目标包点/洞口状态会变, 上回合的流场与路径缓存全部作废
  if (typeof A.clearPathCache === 'function') A.clearPathCache();
  // 立刻重建包点流场 (~26 ms)。调用点包括 initGame (加载界面后)、回合结算
  // (4 秒过场消息里) 和调试台, 都不会落在玩家正在移动的那一帧。
  if (typeof A.warmFlowGoals === 'function') A.warmFlowGoals();
  clearListMeshes(S.grenades);
  clearListMeshes(S.smokes);
  clearListMeshes(S.debris);
  clearBombEntities();

  S.roundNum += 1;
  S.botsPerRound = Math.min(5 + S.roundNum - 1, 8);
  S.allyCount = ALLY_COUNT;
  for (const k of Object.keys(S.radarSpotted)) delete S.radarSpotted[k];
  S.botKnownPos = null;
  S.botKnownTime = -99;
  S.lastRadioAt = -99;

  const B = S.BOMB;
  B.state = 'live';
  B.roundLeft = A.ROUND_TIME;
  B.c4Left = A.C4_TIME;
  B.pos = null;
  B.carrier = null;
  B.drop = null;
  B.plant = 0;
  B.defuse = 0;
  B.allyDefuse = 0;
  B.beepAt = 0;
  B.wasPlanted = false;
  B.spawnLeft = S.botsPerRound;
  B.site = choice(['A', 'B']);
  B.targetPos = copy3(safeArr(A.BOMB_SITES[B.site]));
  B.timerText = fmtTime(B.roundLeft);
  S.defuseHeld = false;

  const p = S.player;
  p.dead = false;
  p.hp = 100;
  p.speed = A.RUN_SPEED;
  p.vy = 0;
  p.grounded = false;
  p.airTime = 0;
  p.pitch = 0;
  p.scoped = false;
  p.crouching = false;
  // 灵敏度是倍率, 每回合恢复到用户设定值 (不能写死, 否则用户改了会被重置)
  p.sensitivity = Number.isFinite(p.sensitivityBase) ? p.sensitivityBase : 2.0;
  // 护甲/投掷物/拆弹钳存活时跨回合保留
  S.shootingEnabled = true;
  S.reloading = false;
  S.fov = A.BASE_FOV;
  S.whiteFlash = 0;
  S.redFlash = 0;
  S.buyMenuOpen = false;
  callUI('toggleBuy', false);
  callUI('showSpectate', '');

  const spawns = Array.isArray(A.playerSpawns) && A.playerSpawns.length ? A.playerSpawns : [[0, 0, 0]];
  const si = randInt(0, spawns.length - 1);
  const sp = spawns[si];
  p.pos = [sp[0], (sp[1] || 0) + 2, sp[2]];
  // GoldSrc 出生 yaw 是绕竖直轴的角度; Ursina/state 约定 rotation_y = 90 - yaw。
  // state.js yaw 同为度且 forward=(sin,cos), 因此直接沿用该换算式。
  p.yaw = 90 - ((A.playerYaws && A.playerYaws[si]) || 0);

  updateEquipText();
  callUI('updateAmmo');
  showCenter(`回合 ${S.roundNum}  |  CT 5 v ${S.botsPerRound} T  |  防守 ${B.site} 点`, '#ffffff');
  for (let i = 0; i < ALLY_COUNT; i++) later(() => spawnAlly(), i * 0.4);
  for (let i = 0; i < S.botsPerRound; i++) later(() => spawnBot(), 0.5 + i * 0.8);
}

// ---------------------------------------------------------------------------
// 玩家 / 装备
// ---------------------------------------------------------------------------
// CS 1.5 的护甲公式 (CBasePlayer::TakeDamage + ArmorRicochet):
// 有甲时伤害先按武器的 armor_ratio 打折, 剩下的部分由护甲吸收一半、血量扣一半;
// 护甲自身按 (伤害 - 剩余) 消耗, 且吸收量不超过剩余护甲值。
// 旧实现一律 0.5 吸收, 于是 AK (armor_ratio 0.775) 打有甲目标只掉一半血,
// 与真实手感差很多 —— AK 正是靠高穿甲在中远距离压 M4 的。
//
// zone: 'head' 时只有戴头盔才吃护甲减免 —— 这是 CS 里"头盔"的唯一作用,
// 没有头盔时头部完全裸奔 (爆头伤害全额)。旧实现把头盔做成了纯装饰。
export function damagePlayer(dmg, armorRatio = 0.5, zone = 'chest') {
  if (S.player.dead || S.BOMB.state === 'over' || !Number.isFinite(dmg) || dmg <= 0) return;
  let amount = dmg;
  const ratio = clamp(Number.isFinite(armorRatio) ? armorRatio : 0.5, 0, 1);
  // 头盔判定: 打头时没头盔 = 护甲无效
  const armorApplies = zone !== 'head' || !!S.player.hasHelmet;
  if (S.player.armor > 0 && ratio > 0 && armorApplies) {
    const afterArmor = amount * ratio;
    const absorbed = (amount - afterArmor) * 0.5;
    const armorLoss = Math.min(S.player.armor, absorbed);
    S.player.armor = Math.max(0, S.player.armor - armorLoss);
    // CS 1.5: flNew = flDamage - armourvalue*2。折算到这里就是
    // afterArmor + (absorbed - armorLoss)*2 —— 旧代码尾部的 *0.5 把
    // 这个 *2 抵消了, 护甲被打穿时伤害会被少算近一半。
    amount = afterArmor + (absorbed - armorLoss) * 2;
    updateEquipText();
  }
  S.player.hp = Math.max(0, Math.round(S.player.hp - amount));
  S.redFlash = 90;
  play('hurt');
  if (S.player.hp <= 0) onPlayerDeath();
}

export function onPlayerDeath() {
  if (S.player.dead) return;
  const p = S.player;
  p.dead = true;
  p.speed = 0;
  p.armor = 0;
  p.hasHelmet = false;
  p.hasKit = false;
  p.scoped = false;
  p.pitch = 0;
  S.shootingEnabled = false;
  S.defuseHeld = false;
  S.reloading = false;
  // 死亡丢枪: 清空所有主武器/手枪 (CS 1.5 行为), 只留匕首。
  // 旧实现只删 ak47/awp —— ak47 是 T 专用、玩家永远买不到, 是死代码,
  // 而 m4a1/aug/scout/mp5 等全都免费跨回合保留。
  for (const wid of Object.keys(S.owned)) {
    const wp = A.WEAPONS[wid];
    if (!wp || wp.slot === 3) continue;          // 保留匕首
    delete S.owned[wid];
    delete S.ammo[wid];
  }
  // 落到一把确实拥有的武器上。旧代码硬切 'usp', 而买过别的手枪后 usp 已从
  // owned 里删除, switchWeapon 会静默返回, S.weapon 仍指向已被删除的宽枪,
  // 下回合 giveAmmo 直接补满 —— 等于免费重生一把 AWP。
  const fallback = S.owned.usp ? 'usp' : (Object.keys(S.owned)[0] || 'knife');
  S.weapon = fallback;
  callUI('switchWeapon', fallback);
  updateEquipText();
  showCenter('你已阵亡  ·  观战队友', '#ffa078');
  callUI('showSpectate', '你已阵亡  ·  观战队友');
  if (S.allies.length === 0) roundEnd('t', 'killed');
}

function canBuy() {
  if (S.BOMB.state !== 'live' || A.ROUND_TIME - S.BOMB.roundLeft > BUY_WINDOW) return false;
  const spawns = Array.isArray(A.playerSpawns) ? A.playerSpawns : [];
  if (!spawns.length) return true;   // 资产缺失时不锁死购买
  return spawns.some(sp => dist3(S.player.pos, sp) < BUY_RADIUS);
}

function priceOf(id) {
  const w = A.WEAPONS[id];
  if (w && Number.isFinite(w.price)) return w.price;
  if (Object.prototype.hasOwnProperty.call(GEAR, id)) return GEAR[id];
  if (id === 'he') return 300;
  if (id === 'flash') return 200;
  if (id === 'smoke') return 300;
  if (id === 'ammo' || id === 'refill' || id === 'ammo_refill') return 300;
  return null;
}

// 队伍限制: CS 1.5 里 AK/SG552/G3SG1/glock/elite/deagle 是 T 专用,
// M4A1/AUG/SG550/USP/fiveseven 是 CT 专用, 其余双方都能买。
export function canBuyItem(id) {
  const w = A.WEAPONS[id];
  if (!w) return true;                       // 装备类无队别限制
  if (!w.team) return true;                  // 双方通用武器
  // 换边后玩家可能是 T, 所以这里必须跟随 playerTeam 而不是写死 ct。
  return w.team === (S.playerTeam || 'ct');
}

export function buyItem(id) {
  const price = priceOf(id);
  if (price === null || price === undefined || !canBuy()) return false;
  if (!canBuyItem(id)) {
    hitText(`敌方武器: ${(A.WEAPONS[id] || {}).name || id}`, 1.0);
    return false;
  }
  const w = A.WEAPONS[id];
  // 重复购买防护
  if (w) {
    if (S.owned[id]) return false;
  } else if ((id === 'armor' && S.player.armor >= 100)
    || (id === 'kevlarhelm' && S.player.armor >= 100 && S.player.hasHelmet)
    || (id === 'kit' && S.player.hasKit)
    || ((id === 'he' || id === 'flash' || id === 'smoke') && S.player.nades[id] >= NADE_LIMIT[id])) return false;
  if (S.money < price) {
    hitText('资金不足', 0.8);
    return false;
  }
  S.money -= price;
  play('buy');

  if (w) {
    // 同一槽位只能持有一把: 主武器覆盖主武器, 手枪覆盖手枪
    const slot = w.slot;
    for (const other of Object.keys(S.owned)) {
      const ow = A.WEAPONS[other];
      if (other !== id && ow && ow.slot === slot) { delete S.owned[other]; delete S.ammo[other]; }
    }
    S.owned[id] = true;
    giveAmmo(id);
    switchWeapon(id);
  } else if (id === 'armor') {
    S.player.armor = 100;
  } else if (id === 'kevlarhelm') {
    S.player.armor = 100;
    S.player.hasHelmet = true;
  } else if (id === 'kit') {
    S.player.hasKit = true;
  } else if (id === 'he' || id === 'flash' || id === 'smoke') {
    S.player.nades[id] = (S.player.nades[id] || 0) + 1;
  } else {
    for (const wid of Object.keys(S.owned)) giveAmmo(wid);
  }
  updateEquipText();
  callUI('updateAmmo');
  callUI('buy', id);
  return true;
}

export function toggleBuyMenu() {
  // 关闭永远可用; 打开需在购买窗口内
  if (!S.buyMenuOpen && !canBuy()) return;
  S.buyMenuOpen = !S.buyMenuOpen;
  callUI('toggleBuy', S.buyMenuOpen);
}

// 每把武器的换弹时长 (秒), 接近 CS 1.5 的实测值:
// 手枪换弹匣快, 霰弹枪逐发压弹慢, 机枪最慢。
const RELOAD_TIME_BY_KIND = {
  pistol: 1.8, smg: 2.0, rifle: 2.3, shotgun: 2.6, sniper: 2.6, mg: 3.4, knife: 0,
};
// 霰弹枪逐发装填: 每装一发的时间
const SHOTGUN_PER_SHELL = 0.55;

function reloadTimeOf(wp) {
  if (!wp) return RELOAD_TIME;
  const t = RELOAD_TIME_BY_KIND[wp.kind];
  return Number.isFinite(t) && t > 0 ? t : RELOAD_TIME;
}

export function reloadWeapon() {
  const wid = S.weapon;
  const wp = A.WEAPONS[wid];
  if (S.reloading || !wp || wp.clip_size == null) return;
  if (!S.ammo[wid]) giveAmmo(wid);
  const ammo = S.ammo[wid];
  if (!ammo || ammo[0] >= wp.clip_size || ammo[1] <= 0) return;

  S.reloading = true;
  S.reloadProgress = 0;
  S.reloadStartedAt = performance.now();   // 与下面的 setTimeout 共用真实时间
  play(wp.reload_sfx || 'reload_rifle');

  // 霰弹枪是逐发压弹: 时长 = 需要装的发数 * 每发时间 (M3/XM1014 没有弹匣)
  const need = Math.min(wp.clip_size - ammo[0], ammo[1]);
  const dur = wp.kind === 'shotgun'
    ? Math.max(SHOTGUN_PER_SHELL, need * SHOTGUN_PER_SHELL)
    : reloadTimeOf(wp);
  S.reloadDuration = dur;

  later(() => {
    if (wid === S.weapon && S.ammo[wid]) {
      const take = Math.min(wp.clip_size - S.ammo[wid][0], S.ammo[wid][1]);
      S.ammo[wid][0] += take;
      S.ammo[wid][1] -= take;
    }
    S.reloading = false;
    S.reloadProgress = 0;
    callUI('updateAmmo');
  }, dur);
}

export function switchWeapon(wid) {
  if (!S.owned[wid]) return;
  if (wid === S.weapon) {
    callUI('switchWeapon', wid);       // 重建 VM (阵亡复活 / 买同款枪)
    return;
  }
  S.weapon = wid;
  S.scoped = false;
  S.reloading = false;
  callUI('switchWeapon', wid);       // engine.buildViewmodel 重建第一人称武器
  callUI('updateAmmo');
}

export function updateEquipText() { callUI('updateEquip'); }

// ---------------------------------------------------------------------------
// 初始化 / 每帧
// ---------------------------------------------------------------------------
function computePosts() {
  const sc = A.SITE_CELLS || {};
  const a = sc.A || [0, 0], b = sc.B || [0, 0];

  // 生成"空间分散"的防守点。
  // 旧实现 ringCells(a,3,14,3) 只给每个点取 3 个格子, 4 个 CT 里常有 3 个
  // 分到几乎同一格 (实测 post 中心仅相距 23~25 格), 于是挤成一团。
  // 这里先取较多的候选, 再用贪心挑"彼此尽量远"的点。
  const spreadPick = (cands, want, minSep) => {
    const picked = [];
    for (const c of cands) {
      if (picked.length >= want) break;
      let ok = true;
      for (const p of picked) {
        if (Math.hypot(c[0] - p[0], c[1] - p[1]) < minSep) { ok = false; break; }
      }
      if (ok) picked.push(c);
    }
    // 候选不够分散时放宽间距要求补齐
    for (const c of cands) {
      if (picked.length >= want) break;
      if (!picked.includes(c)) picked.push(c);
    }
    return picked;
  };

  const aCands = ringCells(a, 4, 16, 24);
  const bCands = ringCells(b, 4, 16, 24);
  const aPosts = spreadPick(aCands, 5, 9).map(c => [c, a]);
  const bPosts = spreadPick(bCands, 5, 9).map(c => [c, b]);

  // 交错排列 A/B, 让相邻的 CT 不会都被派到同一个包点
  const posts = [];
  const maxLen = Math.max(aPosts.length, bPosts.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < aPosts.length) posts.push(aPosts[i]);
    if (i < bPosts.length) posts.push(bPosts[i]);
  }
  DEF_POSTS = posts.length ? posts : [[a, a], [b, b]];

  // 全图开放格扫描一次 (nav 数据不变时不必重复)
  const open = [];
  const sites = [a, b];
  const nearSite = [];
  for (let cy = 0; cy < A.H; cy++) {
    for (let cx = 0; cx < A.W; cx++) {
      if (!A.layerCount(cx, cy)) continue;
      open.push([cx, cy]);
      let md = Infinity;
      for (const s of sites) md = Math.min(md, Math.hypot(cx - s[0], cy - s[1]));
      if (md < 14) nearSite.push([cx, cy]);
    }
  }
  ROAM_CELLS = open;
  T_ROAM_CELLS = nearSite.length ? nearSite : open;
}

export function initGame() {
  cancelTimers(true);
  resetClock();
  computePosts();
  registerHook('onPlayerDeath', onPlayerDeath);
  registerHook('roundEnd', roundEnd);
  registerHook('plantC4', plantC4);
  registerHook('dropC4', dropC4);
  registerHook('explodeC4', explodeC4);
  registerHook('switchWeapon', switchWeapon);
  registerHook('notifyGunfire', () => {
    const wp = A.WEAPONS[S.weapon] || {};
    const silenced = /_sil$/.test(wp.sfx || '');
    notifyGunfire(S.player.pos, S.playerTeam || 'ct', silenced ? 0.35 : 1);
  });
  registerHook('reload', reloadWeapon);
  registerHook('buy', buyItem);
  registerHook('throwNade', throwNade);
  registerHook('toggleBuy', toggleBuyMenu);
  registerHook('clearBots', clearBots);
  registerHook('startRound', () => {           // 手动开新回合, 防重复调用
    if (S.BOMB.state === 'over') nextRound();
  });
  registerHook('spawnBots', () => {           // 供宿主手动补满本回合 T
    const n = Math.max(0, S.BOMB.spawnLeft);
    for (let i = 0; i < n; i++) spawnBot();
  });
  // 纯展示类钩子: 转交注册前已有的 hud 实现; 未注册时为空操作
  const relay = name => {
    relayHooks.add(name);
    return (...a) => callUI(name, ...a);
  };
  registerHook('killFeed', relay('killFeed'));
  registerHook('updateEquip', relay('updateEquip'));
  registerHook('updateAmmo', relay('updateAmmo'));
  registerHook('addKill', relay('addKill'));
  registerHook('radio', relay('radio'));
  registerHook('showSpectate', relay('showSpectate'));
  giveAmmo('usp');
  nextRound();
}

// state.js 只存时钟不自增。若宿主主循环已推进 S.time, 则不再重复计时。
let clockTime = -1;

function resetClock() { clockTime = -1; }

// engine.initEngine 等模块可能在 initGame 之后覆盖动作/展示钩子; 每帧收回控制权
function reconcileHooks() {
  for (const name of Object.keys(actionHooks)) {
    const cur = S.hooks[name];
    if (cur === actionHooks[name]) continue;
    if (typeof cur === 'function'
        && !(name === 'switchWeapon' && S.engine && cur === S.engine.buildViewmodel)
        && (relayHooks.has(name) || typeof prevHooks[name] !== 'function')) {
      prevHooks[name] = cur;
    }
    S.hooks[name] = actionHooks[name];
  }
}

function syncClock(d) {
  // 外部每帧已把 S.time 推进时, 只补帧号, 不重复加时间。
  if (clockTime < 0 || S.time === clockTime) S.time += d;
  S.dt = d;
  S.frame += 1;
  clockTime = S.time;
}

export function updateGame(dt) {
  const d = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.25);
  syncClock(d);
  reconcileHooks();
  syncScene();

  tickRound(d);
  for (const bot of S.enemies.concat(S.allies)) {
    if (bot && bot.enabled && typeof bot.update === 'function') bot.update(d);
  }
  // bot 互推放在各自 update 之后: 先让 AI 决定移动, 再纠正重叠
  separateBots(S.enemies.concat(S.allies), d);
  // 行走动画: 按本帧实际位移速度驱动 walk / run 循环
  for (const bot of S.enemies.concat(S.allies)) {
    if (!bot || !bot.enabled || !bot.visual) continue;
    const v = bot.visual;
    if (typeof v.updateAnim !== "function") continue;
    // 用本帧位移估算速度 (单位/秒), 避免依赖 AI 内部状态
    if (!bot._animPrev) bot._animPrev = [bot.pos[0], bot.pos[2]];
    const dx = bot.pos[0] - bot._animPrev[0];
    const dz = bot.pos[2] - bot._animPrev[1];
    const speed = d > 1e-5 ? Math.hypot(dx, dz) / d : 0;
    bot._animPrev = [bot.pos[0], bot.pos[2]];
    v.updateAnim(d, speed);
  }
  updateGrenades(d);
  updateSmokes(d);
  updateDebris(d);

  if (S.player.dead) {
    const live = S.allies.find(a => a.enabled && a.health > 0);
    if (live) {
      S.player.pos[0] = live.pos[0];
      S.player.pos[1] = live.pos[1] + 0.1;
      S.player.pos[2] = live.pos[2];
      S.player.yaw = live.yaw;
      S.player.pitch = 0;
    }
  }
  S.whiteFlash = Math.max(0, S.whiteFlash - d * 170);
  S.redFlash = Math.max(0, S.redFlash - d * 220);
}
