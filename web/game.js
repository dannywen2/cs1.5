// web/game.js  —  BOT AI / C4 / 回合状态机 (main.py 移植)
// 逻辑坐标与 state.js 一致: x 右 / y 上 / z 前, yaw=0 朝 +z。
import * as THREE from './vendor/three.module.js';
import * as A from './asset.js';
import { S, clamp, rand, randInt, choice, dist2, dist3, yawTo, fmtTime, play, showCenter, reportPlayer, radioContact, addKill, giveAmmo, hitText } from './state.js';
import { makeBotMesh, addEntityMesh, removeEntityMesh, getCamera } from './engine.js';

const DEG = Math.PI / 180;
const GEAR = { armor: 650, he: 300, flash: 200, kit: 200 };
const NADE_LIMIT = { he: 1, flash: 2 };
const BUY_WINDOW = 15;
const BUY_RADIUS = 400;
const RELOAD_TIME = 1.6;
const HE_RADIUS = 200;
const FLASH_RADIUS = 320;
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

function computePosts() {
  const sc = A.SITE_CELLS || {};
  const a = sc.A || [0, 0], b = sc.B || [0, 0];
  const posts = ringCells(a, 3, 14, 3).map(c => [c, a])
    .concat(ringCells(b, 3, 14, 4).map(c => [c, b]));
  DEF_POSTS = posts.length ? posts : [[a, a], [b, b]];
  // 全图漫游格在 304x350 上扫描一次即可, 无 nav 数据则退化为空
  const open = [];
  const sites = [a, b];
  const nearSite = [];
  for (let cy = 0; cy < A.H; cy++) {
    for (let cx = 0; cx < A.W; cx++) {
      if (!A.layers(cx, cy).length) continue;
      open.push([cx, cy]);
      let md = Infinity;
      for (const s of sites) md = Math.min(md, Math.hypot(cx - s[0], cy - s[1]));
      if (md < 14) nearSite.push([cx, cy]);
    }
  }
  ROAM_CELLS = open;
  T_ROAM_CELLS = nearSite.length ? nearSite : open;
}

// ---------------------------------------------------------------------------
// Bot 视觉: makeBotMesh 每次都新建几何; 模型缺失时用简单占位, 绝不抛异常
// ---------------------------------------------------------------------------
function createVisual(team) {
  const models = (A.PLAYER_MODELS && A.PLAYER_MODELS[team]) || ['sas'];
  const guns = (A.BOT_WEAPONS && A.BOT_WEAPONS[team]) || ['w_usp'];
  try {
    const v = makeBotMesh(choice(models), choice(guns));
    if (v && v.group) {
      if (!v.hpBar) v.hpBar = v.group.userData.hpBar || null;
      if (!v.flash) v.flash = v.group.userData.flash || null;
      if (typeof v.setHitFlash !== 'function') {
        v.setHitFlash = v.group.userData.setHitFlash || (() => {});
      }
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

    this.visual = createVisual(team);
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
      const site = A.cellOf(B.targetPos);
      const ring = ringCells(site, 3, 9, 8);
      goal = choice(ring.length ? ring : [site]);
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
    const step = this.speed * mult * dt;
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

  hasLOS(pos) {
    const dx = pos[0] - this.pos[0], dz = pos[2] - this.pos[2];
    const len = Math.hypot(dx, dz);
    if (len > 1) {
      const f = Math.sin(this.yaw * DEG) * dx / len + Math.cos(this.yaw * DEG) * dz / len;
      if (f < -0.17) return false;
    }
    const eye = obj3([this.pos[0], this.pos[1] + A.EYE_HEIGHT, this.pos[2]]);
    const tgt = obj3([pos[0], pos[1] + A.EYE_HEIGHT, pos[2]]);
    try { return A.gridClear(eye, tgt, 8); } catch (e) { return false; }
  }

  pickTarget() {
    const cand = [];
    for (const t of botTargets(this)) {
      if (!t || !t.pos) continue;
      const d = dist2(t.pos, this.pos);
      if (d > 0.01 && d < this.attackRange) cand.push({ d, pos: t.pos, ent: t.ent });
    }
    cand.sort((a, b) => a.d - b.d);
    for (const c of cand.slice(0, 3)) {
      if (this.hasLOS(c.pos)) return { pos: copy3(c.pos), ent: c.ent, d: c.d };
    }
    return null;
  }

  hold() {
    const kp = this.team === 't'
      ? (S.time - S.botKnownTime < 6 ? S.botKnownPos : null)
      : (S.time - this.knownTime < 6 ? this.knownPos : null);
    if (kp) {
      this.yaw = yawTo(kp[0] - this.pos[0], kp[2] - this.pos[2]);
      return;
    }
    if (!this.watch) return;
    const wp = A.cellPos(this.watch[0], this.watch[1], 0);
    const dx = wp[0] - this.pos[0], dz = wp[2] - this.pos[2];
    const len = Math.hypot(dx, dz) || 1;
    const off = Math.sin(S.time * 0.8) * 4;
    this.yaw = yawTo(dx + (-dz / len) * off, dz + (dx / len) * off);
  }

  combat(to, dist, ent, dt) {
    const len = Math.hypot(to[0], to[2]) || 1;
    const fx = to[0] / len, fz = to[2] / len;
    this.strafeTimer -= dt;
    if (this.strafeTimer <= 0) {
      this.strafeTimer = rand(0.5, 1.2);
      this.strafeDir *= -1;
    }
    this.moveAxis(-fz * this.strafeDir * this.speed * 0.5 * dt,
      fx * this.strafeDir * this.speed * 0.5 * dt);
    if (dist > 420) this.moveAxis(fx * this.speed * 0.55 * dt, fz * this.speed * 0.55 * dt);
    else if (dist < 120) this.moveAxis(-fx * this.speed * 0.45 * dt, -fz * this.speed * 0.45 * dt);

    if (this.fireTimer > 0) return;
    const tp = ent ? ent.pos : S.player.pos;
    const clearShot = tp ? this.hasLOS(tp) : false;
    if (!clearShot) {
      this.fireTimer = 0.3;
      return;
    }
    this.fireTimer = rand(0.8, 1.5);
    play('shot');
    if (this.visual.flash) {
      this.visual.flash.visible = true;
      this.visual.flash.rotation.z = rand(0, Math.PI / 2);
      this.muzzleUntil = S.time + 0.06;
    }
    const hitChance = Math.max(0.18, 0.82 - dist * 0.00065);
    if (Math.random() >= hitChance) return;
    const dmg = randInt(6, 13);
    if (!ent) {
      damagePlayer(dmg);
    } else if (ent.team !== this.team && ent.enabled && ent.health > 0
      && typeof ent.takeDamage === 'function') {
      ent.takeDamage(dmg, false, this.pos, this.name);
    }
  }

  takeDamage(dmg, headshot = false, fromPos = null, killer = '你') {
    if (!this.enabled) return;
    this.health -= finite(dmg);
    if (this.team === 't' && fromPos) reportPlayer(fromPos);
    this.flash = 0.08;
    try { this.visual.setHitFlash(true); } catch (_) { /* 占位模型可忽略 */ }
    const bar = this.visual.hpBar;
    if (bar) {
      bar.scale.x = Math.max(0.01, this.health / this.maxHealth);
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
      S.money += wp ? (wp.kill_reward || 0) : 0;
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
    if (this.team === 'ct' && S.player.dead && S.allies.length === 0) roundEnd('t', 'killed');
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
        this.state = this.role === 'defend' ? 'move' : 'pause';
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
        if (this.role === 'defend') this.state = 'hold';
        else { this.state = 'pause'; this.holdTimer = rand(1.5, 3.5); }
      }
      this.facePath();
    } else if (this.state === 'pause') {
      this.holdTimer -= dt;
      if (this.holdTimer <= 0) {
        const fresh = S.botKnownPos && S.time - S.botKnownTime < 10;
        this.state = fresh ? 'hunt' : 'move';
        this.repath();
      }
    } else if (this.state === 'hold') {
      if (S.BOMB.state === 'planted' && this.repathTimer <= 0) {
        this.repathTimer = 3;
        this.state = 'move';
        this.repath();
      }
      this.hold();
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
  if (bot.team === 'ct') {
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

export function spawnBot() {
  const pos = spawnPoint(A.tSpawns, S.usedBotSpawns, 0.8);
  const bot = new Bot(pos, S.roundNum, 'attack', null, 't');
  S.enemies.push(bot);
  spawnCounter += 1;
  if (spawnCounter === 1) {
    S.BOMB.carrier = bot;
    bot.setCarrier(true);
  }
  S.BOMB.spawnLeft = Math.max(0, S.BOMB.spawnLeft - 1);
  return bot;
}

export function spawnAlly() {
  const pos = spawnPoint(A.playerSpawns, S.usedAllySpawns, 0.7);
  const post = DEF_POSTS.length ? DEF_POSTS[S.allies.length % DEF_POSTS.length] : null;
  const bot = new Bot(pos, S.roundNum, 'defend', post, 'ct');
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

export function throwNade(kind) {
  if (kind !== 'he' && kind !== 'flash') return;
  if (S.buyMenuOpen || S.player.dead || S.BOMB.state === 'over') return;
  if (!S.player.nades[kind] || S.player.nades[kind] <= 0) return;
  S.player.nades[kind] -= 1;
  callUI('updateEquip');
  play('pin');

  const p = S.player;
  const yaw = p.yaw * DEG, pitch = p.pitch * DEG;
  const fwd = [Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
  const cam = typeof getCamera === 'function' ? getCamera() : null;
  const eye = cam ? [cam.position.x, cam.position.y, cam.position.z]
    : [p.pos[0], p.pos[1] + A.EYE_HEIGHT, p.pos[2]];
  const pos = [eye[0] + fwd[0] * 12, eye[1] + fwd[1] * 12, eye[2] + fwd[2] * 12];
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(2, 8, 6),
    new THREE.MeshBasicMaterial({ color: kind === 'he' ? 0x465a3c : 0xc8c8cd }),
  );
  mesh.position.set(pos[0], pos[1], pos[2]);
  addMesh(mesh);
  S.grenades.push({
    kind, mesh, pos,
    vel: [fwd[0] * 750, fwd[1] * 750 + 90, fwd[2] * 750],
    fuse: 1.5,
  });
}

function explodeNade(g) {
  const pos = g.pos;
  const eye = obj3([pos[0], pos[1], pos[2]]);
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
    for (let a = 0; a < 3; a++) g.pos[a] += g.vel[a] * dt;
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

export function roundEnd(winner, reason) {
  const B = S.BOMB;
  if (B.state === 'over') return;
  B.state = 'over';
  let msg, color, reward;
  if (winner === 'ct') {
    S.ctScore += 1;
    if (reason === 'defused') {
      play('c4_defuse');
      msg = 'C4 已拆除 - CT 胜利!  +$3250';
    } else if (reason === 'timeout') {
      play('win');
      msg = '时间耗尽 - CT 守住包点!  +$3250';
    } else {
      play('win');
      msg = 'T 全灭 - CT 胜利!  +$3250';
    }
    color = '#78ff78';
    reward = 3250;
  } else {
    S.tScore += 1;
    play('lose');
    S.player.armor = 0;
    if (reason === 'killed') S.player.hasKit = false;
    updateEquipText();
    reward = 1400;
    color = '#ff6464';
    if (reason === 'exploded') msg = 'C4 爆炸 - 回合失败  +$1400';
    else {
      S.whiteFlash = 0;
      msg = '你阵亡了 - 回合失败  +$1400';
    }
  }
  S.money += reward;
  showCenter(msg, color);
  callUI('updateEquip');
  callUI('updateAmmo');
  callUI('showSpectate', '');
  later(nextRound, 4);
}

function tickRound(dt) {
  const B = S.BOMB;
  if (B.state === 'over') return;
  if (B.state === 'live') {
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
export function damagePlayer(dmg) {
  if (S.player.dead || S.BOMB.state === 'over' || !Number.isFinite(dmg) || dmg <= 0) return;
  let amount = dmg;
  if (S.player.armor > 0) {
    const absorbed = Math.min(S.player.armor, amount * 0.5);
    S.player.armor -= absorbed;
    amount -= absorbed;
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
  p.hasKit = false;
  p.scoped = false;
  p.pitch = 0;
  S.shootingEnabled = false;
  S.defuseHeld = false;
  S.reloading = false;
  for (const wid of ['ak47', 'awp']) {
    delete S.owned[wid];
    delete S.ammo[wid];
  }
  if (S.weapon !== 'usp') switchWeapon('usp');
  else callUI('switchWeapon', 'usp');
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
  if (id === 'ak47' || id === 'awp') {
    const p = (A.WEAPONS[id] || {}).price;
    return Number.isFinite(p) ? p : null;
  }
  if (Object.prototype.hasOwnProperty.call(GEAR, id)) return GEAR[id];
  if (id === 'ammo' || id === 'refill' || id === 'ammo_refill') return 300;
  return null;
}

export function buyItem(id) {
  const price = priceOf(id);
  if (price === null || price === undefined || !canBuy()) return false;
  if ((id === 'armor' && S.player.armor >= 100)
    || (id === 'kit' && S.player.hasKit)
    || ((id === 'he' || id === 'flash') && S.player.nades[id] >= NADE_LIMIT[id])) return false;
  if (S.money < price) {
    hitText('资金不足', 0.8);
    return false;
  }
  S.money -= price;
  play('buy');
  if (id === 'ak47' || id === 'awp') {
    for (const primary of ['ak47', 'awp']) {
      if (primary !== id) { delete S.owned[primary]; delete S.ammo[primary]; }
    }
    S.owned[id] = true;
    giveAmmo(id);
    switchWeapon(id);
  } else if (id === 'armor') {
    S.player.armor = 100;
  } else if (id === 'kit') {
    S.player.hasKit = true;
  } else if (id === 'he' || id === 'flash') {
    S.player.nades[id] += 1;
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

export function reloadWeapon() {
  const wid = S.weapon;
  const wp = A.WEAPONS[wid];
  if (S.reloading || !wp || wp.clip_size == null) return;
  if (!S.ammo[wid]) giveAmmo(wid);
  const ammo = S.ammo[wid];
  if (!ammo || ammo[0] >= wp.clip_size || ammo[1] <= 0) return;
  S.reloading = true;
  play('reload');
  later(() => {
    if (wid === S.weapon && S.ammo[wid]) {
      const take = Math.min(wp.clip_size - S.ammo[wid][0], S.ammo[wid][1]);
      S.ammo[wid][0] += take;
      S.ammo[wid][1] -= take;
    }
    S.reloading = false;
    callUI('updateAmmo');
  }, RELOAD_TIME);
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
export function initGame() {
  cancelTimers(true);
  resetClock();
  computePosts();
  registerHook('damagePlayer', damagePlayer);
  registerHook('onPlayerDeath', onPlayerDeath);
  registerHook('roundEnd', roundEnd);
  registerHook('plantC4', plantC4);
  registerHook('dropC4', dropC4);
  registerHook('explodeC4', explodeC4);
  registerHook('switchWeapon', switchWeapon);
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
  updateGrenades(d);
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
