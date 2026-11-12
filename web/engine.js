// web/engine.js
// three.js 渲染层 + 第一人称玩家/武器控制。
// 逻辑坐标(state.js): x 右 / y 上 / z 前, yaw=0 朝 +z —— 这是左手系;
// three.js 相机默认朝 -z 且为右手系, 两者之间需要一次反射, 见 calibrateCamera()。
import * as THREE from './vendor/three.module.js';
import * as A from './asset.js';
import { S, clamp, rand, choice, forwardVec, rightVec, yawTo, fmtTime, play, showCenter, reportPlayer, hitText, giveAmmo, dist3 } from './state.js';

const DEG = Math.PI / 180;
// 鼠标: 每 "count" (浏览器 movementX 单位) 转多少度, 再乘玩家灵敏度倍率。
// 0.06 * 2.0 = 0.12 度/像素, 约 3000 像素转一圈 —— 与 CS 默认手感同量级。
const DEG_PER_COUNT = 0.06;
const DEFAULT_SENSITIVITY = 2.0;
const CROUCH_EYE = 40;
const HULL_MID = 36;            // hull1 按 32x32x72 膨胀, 只需测玩家中心
const SKY_D = 2800;
const HOLE_TTL = 12;
const MAX_HOLES = 40;
const BOT_HALF = 16;
const BOT_HEIGHT = 72;

let renderer = null;
let scene = null, camera = null;
let skyScene = null, skyCamera = null, skyRoot = null;
let vmScene = null, vmCamera = null, vmGroup = null, vmRoot = null, vmWrapper = null;
let muzzle = null, muzzleUntil = 0, vmWeapon = null;
let vmBasePos = [0, 0, 0], vmBaseRot = [0, 0, 0], vmSwing = 0;
let engineTime = 0;

// 相机欧拉参数由 calibrateCamera() 实测确定 (不写死符号, 便于换 three.js 版本)
let pitchSign = -1, yawSign = 1, yawOffset = Math.PI, mirrorX = false;

const holeGeo = new THREE.PlaneGeometry(2, 2);
const bulletHoles = [];                 // {mesh, point, ttl}
const botVisuals = new Set();           // makeBotMesh 返回的根组, 用于血条 billboard

const _dir = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function hook(name, ...args) {
  const fn = S.hooks && S.hooks[name];
  return typeof fn === 'function' ? fn(...args) : undefined;
}

function held(...names) {
  const k = S.keys || {};
  for (const n of names) if (k[n] === true || k[n] === 1) return true;
  return false;
}

function toVec3(v) {
  if (!v) return new THREE.Vector3();
  if (v.isVector3) return v.clone();
  if (Array.isArray(v)) return new THREE.Vector3(v[0] || 0, v[1] || 0, v[2] || 0);
  return new THREE.Vector3(v.x || 0, v.y || 0, v.z || 0);
}

function posOf(p) {
  if (!p) return null;
  if (Array.isArray(p)) return [p[0], p[1], p[2]];
  if (Number.isFinite(p.x)) return [p.x, p.y, p.z];
  if (p.isVector3) return [p.x, p.y, p.z];
  return null;
}

function eyeHeight() { return S.player.crouching ? CROUCH_EYE : A.EYE_HEIGHT; }

function shiftHeld() { return held('shift', 'Shift', 'shiftleft', 'ShiftLeft', 'shiftright', 'ShiftRight'); }
function ctrlHeld() { return held('control', 'Control', 'ctrl', 'ControlLeft', 'ControlRight', 'left control', 'right control'); }
function spaceHeld() { return held('space', ' ', 'Space', 'Spacebar'); }

// ---------------------------------------------------------------------------
// 相机: three.js 相机朝 -z, 逻辑 forwardVec 朝 +z
// ---------------------------------------------------------------------------
function setTestRotation(cam, yaw, pitch) {
  cam.rotation.set(pitch * DEG * pitchSign, yaw * DEG * yawSign + yawOffset, 0, 'YXZ');
  cam.updateMatrixWorld(true);
}

function calibrateCamera() {
  const probe = new THREE.PerspectiveCamera();
  const samples = [[0, 0], [90, 0], [45, 30], [-60, -25], [180, 70]];
  let best = { score: -Infinity, ps: -1, ys: 1, off: Math.PI };
  let aligned = true;
  for (const [yaw, pitch] of samples) {
    setTestRotation(probe, yaw, pitch);
    // 相机默认看 -z, 直接从四元数取世界朝向, 不依赖具体 three.js 版本
    _fwd.set(0, 0, -1).applyQuaternion(probe.quaternion);
    const f = forwardVec(yaw, pitch);
    if (_fwd.dot(new THREE.Vector3(f[0], f[1], f[2])) < 0.999) aligned = false;
  }
  if (!aligned) {
    for (const ps of [-1, 1]) {
      for (const ys of [-1, 1]) {
        for (const off of [0, Math.PI]) {
          pitchSign = ps; yawSign = ys; yawOffset = off;
          let score = 0;
          for (const [yaw, pitch] of samples) {
            setTestRotation(probe, yaw, pitch);
            _fwd.set(0, 0, -1).applyQuaternion(probe.quaternion);
            const f = forwardVec(yaw, pitch);
            score += _fwd.x * f[0] + _fwd.y * f[1] + _fwd.z * f[2];
          }
          if (score > best.score) best = { score, ps, ys, off };
        }
      }
    }
  }
  pitchSign = best.ps; yawSign = best.ys; yawOffset = best.off;

  // 逻辑系是左手系: 纯旋转无法同时对齐 forward 与 right。
  // 水平镜像投影矩阵, 使屏幕右 = rightVec(yaw), A/D 不反向, 同时不影响
  // camera.position / 世界朝向 / quaternion (getCamera() 仍可直接用于逻辑计算)。
  // 镜像会反转三角形绕序, 因此场景内材质全部是 DoubleSide。
  mirrorX = false;
  setTestRotation(probe, 0, 0);
  _right.set(1, 0, 0).applyQuaternion(probe.quaternion);
  const rv = rightVec(0);
  if (_right.x * rv[0] + _right.y * rv[1] + _right.z * rv[2] < 0) mirrorX = true;
}

function applyMirror(cam) {
  if (!cam.userData.mirrorProjection) return;
  const e = cam.projectionMatrix.elements;
  e[0] = -e[0]; e[4] = -e[4]; e[8] = -e[8]; e[12] = -e[12];
  cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
}

function installMirror(cam) {
  if (cam.userData.mirrorProjection) return;
  cam.userData.mirrorProjection = true;
  // 覆盖 updateProjectionMatrix, 让外部模块重新计算投影时镜像依然生效
  const base = cam.updateProjectionMatrix.bind(cam);
  cam.updateProjectionMatrix = () => {
    base();
    // 投影矩阵第 0 行整体取反 => clip.x 取反, 屏幕左右翻转
    applyMirror(cam);
  };
  cam.updateProjectionMatrix();
}

function setFov(fov) {
  camera.fov = fov;
  camera.updateProjectionMatrix();
  skyCamera.fov = fov;
  skyCamera.updateProjectionMatrix();
  vmCamera.fov = fov;
  vmCamera.updateProjectionMatrix();
}

function syncCamera() {
  const p = S.player;
  camera.position.set(p.pos[0], p.pos[1] + eyeHeight(), p.pos[2]);
  camera.rotation.set(p.pitch * DEG * pitchSign, p.yaw * DEG * yawSign + yawOffset, 0, 'YXZ');
  camera.updateMatrixWorld();
  skyCamera.quaternion.copy(camera.quaternion);
  skyCamera.position.set(0, 0, 0);
}

// ---------------------------------------------------------------------------
// 贴花: 弹孔 (FIFO 40, 12s 淡出)
// ---------------------------------------------------------------------------
function disposeHole(h) {
  scene.remove(h.mesh);
  h.mesh.material.dispose();
}

export function addBulletHole(point, normal) {
  if (!scene) return;
  const p = posOf(point);
  if (!p) return;
  const n = normal || [0, 0, 1];
  const last = bulletHoles[bulletHoles.length - 1];
  if (last && dist3(p, last.point) < 2) return;
  const mat = new THREE.MeshBasicMaterial({
    color: 0x140f0a, side: THREE.DoubleSide, transparent: true, opacity: 0.86,
    depthTest: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1,
  });
  const mesh = new THREE.Mesh(holeGeo, mat);
  mesh.position.set(p[0] + n[0] * 0.5, p[1] + n[1] * 0.5, p[2] + n[2] * 0.5);
  mesh.lookAt(p[0] + n[0], p[1] + n[1], p[2] + n[2]);
  mesh.renderOrder = 1;
  scene.add(mesh);
  bulletHoles.push({ mesh, point: p, ttl: HOLE_TTL });
  while (bulletHoles.length > MAX_HOLES) disposeHole(bulletHoles.shift());
}

function updateHoles(dt) {
  for (let i = bulletHoles.length - 1; i >= 0; i--) {
    const h = bulletHoles[i];
    h.ttl -= dt;
    if (h.ttl < 2) h.mesh.material.opacity = 0.86 * Math.max(0, h.ttl) / 2;
    if (h.ttl <= 0) {
      disposeHole(h);
      bulletHoles.splice(i, 1);
    }
  }
}

// ---------------------------------------------------------------------------
// 射线: hull0 墙 + bot AABB (脚底为原点, 半宽 16, 高 72), 忽略玩家
// ---------------------------------------------------------------------------
function boxHit(o, d, p, maxT) {
  const lo = [p[0] - BOT_HALF, p[1], p[2] - BOT_HALF];
  const hi = [p[0] + BOT_HALF, p[1] + BOT_HEIGHT, p[2] + BOT_HALF];
  let tMin = 0, tMax = maxT, axis = 0, sign = -1;
  for (let a = 0; a < 3; a++) {
    const oa = o.getComponent(a), da = d.getComponent(a);
    if (Math.abs(da) < 1e-9) {
      if (oa < lo[a] || oa > hi[a]) return null;
      continue;
    }
    let t1 = (lo[a] - oa) / da, t2 = (hi[a] - oa) / da, s = -1;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; s = 1; }
    if (t1 > tMin) { tMin = t1; axis = a; sign = s; }
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return null;
  }
  if (tMin < 0 || tMin > maxT) return null;
  const n = [0, 0, 0];
  n[axis] = sign;
  return { t: tMin, normal: n };
}

export function rayHit(originVec3, dirVec3, maxDist = A.BULLET_RANGE) {
  const o = toVec3(originVec3);
  const d = toVec3(dirVec3).normalize();
  const maxT = Number.isFinite(maxDist) && maxDist > 0 ? maxDist : A.BULLET_RANGE;
  const back = [-d.x, -d.y, -d.z];

  let entity = null, entT = Infinity, entNormal = back;
  for (const list of [S.enemies, S.allies]) {
    if (!Array.isArray(list)) continue;
    for (const bot of list) {
      if (!bot || bot.dead === true || bot.enabled === false || bot.alive === false) continue;
      if (Number.isFinite(bot.health) && bot.health <= 0) continue;
      const p = posOf(bot.pos);
      if (!p) continue;
      const h = boxHit(o, d, p, maxT);
      if (h && h.t < entT) { entT = h.t; entity = bot; entNormal = h.normal; }
    }
  }
  const entityResult = () => ({
    kind: 'entity', entity,
    point: [o.x + d.x * entT, o.y + d.y * entT, o.z + d.z * entT],
    normal: entNormal,
  });
  // hull0 精确求交 (旧的 8 单位步长扫描会跨过比 8 单位更薄的墙 ——
  // de_dust2 的窗框/门缝/栅栏, 而且命中点固定偏移 4 单位不贴墙面)。
  // A.hitSolid 仍保留给视线/网格采样等"点测试"场景。
  const wallT = typeof A.raySolidDistance === 'function'
    ? A.raySolidDistance(o.x, o.y, o.z, d.x, d.y, d.z, maxT)
    : -1;
  if (wallT >= 0 && wallT <= maxT) {
    if (entity && entT < wallT) return entityResult();
    return {
      kind: 'wall', entity: null, normal: back,
      point: [o.x + d.x * wallT, o.y + d.y * wallT, o.z + d.z * wallT],
    };
  }
  if (entity) return entityResult();
  return {
    kind: 'none', entity: null, normal: back,
    point: [o.x + d.x * maxT, o.y + d.y * maxT, o.z + d.z * maxT],
  };
}

// ---------------------------------------------------------------------------
// 玩家物理: CSPlayer.update 1:1 移植
// ---------------------------------------------------------------------------
function solid(x, feet, z) { return A.hullSolid(x, feet + HULL_MID, z); }

let stepY = null;

function stepUp(nx, nz) {
  const p = S.player;
  const y0 = stepY === null ? p.pos[1] : stepY;
  const top = y0 + A.STEP_HEIGHT;
  if (solid(nx, top, nz)) return false;
  // 二分求刚好能通过的最小抬高量, 斜坡/台阶连续跟随
  let lo = y0, hi = top;
  for (let i = 0; i < 10; i++) {
    const mid = (lo + hi) * 0.5;
    if (solid(nx, mid, nz)) lo = mid; else hi = mid;
  }
  p.pos[0] = nx; p.pos[2] = nz; p.pos[1] = hi + 0.05;
  return true;
}

function groundAt(x, z) {
  const p = S.player;
  let prevSolid = null, prevY = null;
  let yy = p.pos[1] + A.STEP_HEIGHT;
  while (yy >= p.pos[1] - 20) {
    const s = solid(x, yy, z);
    if (s && prevSolid === false) {
      // 找到"空 -> 实"跳变, 二分求精确地面
      let lo = yy, hi = prevY;
      for (let i = 0; i < 10; i++) {
        const mid = (lo + hi) * 0.5;
        if (solid(x, mid, z)) lo = mid; else hi = mid;
      }
      return hi;
    }
    prevSolid = s; prevY = yy;
    yy -= 3;
  }
  return null;
}

function respawnPlayer() {
  const p = S.player;
  const spawns = (S.assets && S.assets.playerSpawns) || A.playerSpawns || [];
  if (!spawns.length) { p.pos[1] += 2; return; }
  const sp = choice(spawns);
  const i = Math.max(0, spawns.indexOf(sp));
  const yaws = (S.assets && S.assets.playerYaws) || A.playerYaws || [];
  p.pos[0] = sp[0]; p.pos[1] = sp[1] + 2; p.pos[2] = sp[2];
  // playerYaws 是 GoldSrc yaw(0 朝 +x), 逻辑 yaw=0 朝 +z, 用 yawTo 换算 (等价于 90 - yaw)
  if (Number.isFinite(yaws[i])) p.yaw = yawTo(Math.cos(yaws[i] * DEG), Math.sin(yaws[i] * DEG));
  p.vy = 0;
  p.airTime = 0;
  p.grounded = false;
}

function updatePhysics(dt) {
  const p = S.player;
  stepY = p.pos[1];

  // 分轴滑动, 每帧 X/Z 共用一个起始高度
  const f = forwardVec(p.yaw);
  const r = rightVec(p.yaw);
  const fw = (held('w', 'W', 'KeyW', 'arrowup', 'ArrowUp') ? 1 : 0)
           - (held('s', 'S', 'KeyS', 'arrowdown', 'ArrowDown') ? 1 : 0);
  const sd = (held('d', 'D', 'KeyD', 'arrowright', 'ArrowRight') ? 1 : 0)
           - (held('a', 'A', 'KeyA', 'arrowleft', 'ArrowLeft') ? 1 : 0);
  let dx = f[0] * fw + r[0] * sd;
  let dz = f[2] * fw + r[2] * sd;
  const len = Math.hypot(dx, dz);
  if (len > 0) {
    dx /= len; dz /= len;
    const crouch = ctrlHeld();
    p.crouching = crouch;
    p.speed = crouch ? A.CROUCH_SPEED : (shiftHeld() ? A.WALK_SPEED : A.RUN_SPEED);
    const spd = p.speed * (p.grounded ? 1 : 0.92);
    const nx = p.pos[0] + dx * spd * dt;
    const nz = p.pos[2] + dz * spd * dt;
    if (!solid(nx, p.pos[1], p.pos[2])) p.pos[0] = nx;
    else if (dx) stepUp(nx, p.pos[2]);
    if (!solid(p.pos[0], p.pos[1], nz)) p.pos[2] = nz;
    else if (dz) stepUp(p.pos[0], nz);
  } else {
    p.crouching = ctrlHeld();
    p.speed = p.crouching ? A.CROUCH_SPEED : (shiftHeld() ? A.WALK_SPEED : A.RUN_SPEED);
  }

  if (spaceHeld() && p.grounded) {
    p.vy = A.JUMP_SPEED;
    p.grounded = false;
  }

  if (p.grounded) {
    const gh = groundAt(p.pos[0], p.pos[2]);
    if (gh === null) { p.grounded = false; p.vy = 0; }
    else { p.pos[1] = gh; p.vy = 0; p.airTime = 0; }
  }

  if (!p.grounded) {
    p.vy -= A.GRAVITY * dt;
    const ny = p.pos[1] + p.vy * dt;
    if (solid(p.pos[0], ny, p.pos[2])) {
      if (p.vy <= 0) {
        let lo = ny, hi = p.pos[1];
        for (let i = 0; i < 12; i++) {
          const mid = (lo + hi) * 0.5;
          if (solid(p.pos[0], mid, p.pos[2])) lo = mid; else hi = mid;
        }
        p.pos[1] = hi; p.vy = 0; p.grounded = true; p.airTime = 0;
      } else {
        p.vy = 0;
      }
    } else {
      p.pos[1] = ny;
      p.airTime += dt;
    }
  }
  stepY = null;

  // 掉出世界 / 越界兜底
  if (p.pos[1] < -600 || !(p.pos[0] > -2900 && p.pos[0] < 2100)
      || !(p.pos[2] > -1700 && p.pos[2] < 4000)) respawnPlayer();
}

// ---------------------------------------------------------------------------
// 视角持枪模型
// ---------------------------------------------------------------------------
function disposeVMChildren() {
  for (let i = vmWrapper.children.length - 1; i >= 0; i--) {
    const m = vmWrapper.children[i];
    vmWrapper.remove(m);
    if (m.geometry) m.geometry.dispose();
    if (m.material) m.material.dispose();
  }
  muzzle = null;
  muzzleUntil = 0;
}

export function buildViewmodel(wid) {
  if (!vmRoot) return;
  vmWeapon = wid;
  const data = S.assets && S.assets.vm && S.assets.vm[wid];
  if (!data || !Array.isArray(data.groups)) {
    console.warn(`[engine] 视角模型未加载: ${wid}`);
    return;
  }
  if (A.WEAPONS[wid]) S.weapon = wid;
  disposeVMChildren();

  const scale = A.VM_SCALE[wid] || 0.06;
  const pos = A.VM_POS[wid] || [0.2, -0.15, 0.3];
  const rot = (A.VM_ROT[wid] || [0, 0, 0]).map(v => v * DEG);
  // 烘焙顶点是"x 右 / y 上 / z 前", three 相机看 -z:
  // 根节点的 z 取反, 内部 wrapper 再以 z=-1 反射顶点, 枪口 +z 才会指向画面深处。
  vmBasePos = [pos[0], pos[1], -pos[2]];
  vmBaseRot = [rot[0], -rot[1], -rot[2]];
  vmRoot.position.set(vmBasePos[0], vmBasePos[1], vmBasePos[2]);
  vmRoot.scale.setScalar(scale);
  vmRoot.rotation.set(vmBaseRot[0], vmBaseRot[1], vmBaseRot[2]);

  let gi = 0;
  for (const g of data.groups) {
    // asset.js 已过滤 skip 组; 每次重建都克隆几何, 避免 dispose 掉共享模板
    const geo = g.geometry.clone();
    const col = geo.getAttribute('color');
    if (col) {
      for (let i = 0; i < col.array.length; i++) {
        col.array[i] = Math.min(1, col.array[i] * A.VM_GAIN);
      }
      col.needsUpdate = true;
    }
    const mat = new THREE.MeshBasicMaterial({
      map: g.texture || null, vertexColors: true, side: THREE.DoubleSide,
      transparent: false, depthTest: false, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = gi++;   // 枪身按资产组顺序绘制, 枪口焰最后盖上去
    vmWrapper.add(mesh);
  }

  const meta = data.meta || null;
  let mz = 0;
  if (meta && meta.muzzle && Number.isFinite(meta.muzzle[0])) mz = meta.muzzle[0];
  else if (meta && meta.bbox && meta.bbox[0]) mz = -meta.bbox[0][1];
  muzzle = new THREE.Mesh(
    new THREE.PlaneGeometry(1.8, 1.8),
    new THREE.MeshBasicMaterial({
      color: 0xffe278, side: THREE.DoubleSide,
      transparent: false, depthTest: false, depthWrite: false,
    }),
  );
  // muzzle 挂在 wrapper 下, 烘焙 +z 同样经 z=-1 反射成相机空间的 -z
  muzzle.position.set(0, 0, mz);
  muzzle.frustumCulled = false;
  muzzle.renderOrder = gi;
  muzzle.visible = false;
  vmWrapper.add(muzzle);

  vmGroup.userData.root = vmRoot;
  vmGroup.userData.wrapper = vmWrapper;
  vmGroup.userData.muzzle = muzzle;
  vmGroup.userData.weapon = wid;
  vmSwing = 0;
}

function updateVM(dt, moving) {
  if (!vmRoot) return;
  const a = S.vmAnim;
  const wp = A.WEAPONS[S.weapon] || { recoil: 1 };
  a.t += dt;
  a.recoil = Math.max(0, a.recoil - dt / 0.18);
  a.dip = Math.max(0, a.dip - dt / 0.2);
  vmSwing = Math.max(0, vmSwing - dt / 0.35);

  if (moving && S.player.grounded) {
    vmRoot.position.y = vmBasePos[1] + Math.sin(engineTime * 10) * 0.02;
    S.stepTimer -= dt;
    if (S.stepTimer <= 0) {
      S.stepTimer = shiftHeld() ? 0.32 : 0.42;
      play('footstep');
    }
  } else {
    vmRoot.position.y += (vmBasePos[1] - vmRoot.position.y) * Math.min(1, dt * 8);
  }
  vmRoot.rotation.x = vmBaseRot[0] - 1.5 * wp.recoil * a.recoil * DEG;
  vmRoot.rotation.z = vmBaseRot[2] - 40 * vmSwing * DEG;
  // 后坐向相机方向回缩: 相机空间 z 为负, 回缩即 z 增大
  vmRoot.position.z = vmBasePos[2] + 0.08 * a.dip;
  if (muzzle) muzzle.visible = engineTime < muzzleUntil;
}

// ---------------------------------------------------------------------------
// 射击
// ---------------------------------------------------------------------------
export function shoot() {
  if (!S.shootingEnabled || S.buyMenuOpen || S.reloading || S.shootCd > 0
      || S.player.dead || S.BOMB.state === 'over') return;
  const p = S.player;
  const wp = A.WEAPONS[S.weapon];
  if (!wp) return;
  const origin = new THREE.Vector3(p.pos[0], p.pos[1] + eyeHeight(), p.pos[2]);

  if (wp.melee) {
    S.shootCd = wp.interval;
    vmSwing = 1;
    const f = forwardVec(p.yaw, p.pitch);
    const hit = rayHit(origin, new THREE.Vector3(f[0], f[1], f[2]), A.MELEE_RANGE);
    // CS 1.5 匕首: 正面砍 ~55, 背刺秒杀。背刺判定用攻击者与目标的朝向夹角。
    if (hit.kind === 'entity') {
      const e = hit.entity;
      if (e.team === 'ct') { showCenter('别打队友!', '#ff5050', 0.6); return; }
      const bp = posOf(e.pos);
      let backstab = false;
      if (bp && Number.isFinite(e.yaw)) {
        // 目标朝向 bot.yaw (度, 0 朝 +z); 攻击者相对目标的方位
        const toAtk = Math.atan2(p.pos[0] - bp[0], p.pos[2] - bp[2]) * 180 / Math.PI;
        let diff = ((toAtk - e.yaw) % 360 + 540) % 360 - 180;
        backstab = Math.abs(diff) < 60;   // 攻击者在目标背后 120° 扇区
      }
      play(backstab ? 'knife_stab' : 'knife');
      const zone = backstab ? 'chest' : hitZoneOf(hit.point, bp);
      const mult = backstab ? 4 : (A.HITBOX_MULT[zone] ?? 1);
      if (typeof e.takeDamage === 'function') {
        e.takeDamage(wp.dmg * mult, backstab, S.player.pos, '你', zone);
      }
      play('hit');
    } else if (hit.kind === 'wall') {
      addBulletHole(hit.point, hit.normal);
      play('knife_hitwall');
    } else {
      play('knife');
    }
    return;
  }

  if (!S.ammo[S.weapon]) giveAmmo(S.weapon);
  const ammo = S.ammo[S.weapon];
  if (!ammo) return;
  if (ammo[0] <= 0) {
    // 空仓: 手枪是清脆的空击, 步枪是撞针声 (CS 1.5 分两种)
    play(wp.kind === 'pistol' ? 'dryfire_pistol' : 'dryfire_rifle');
    S.shootCd = 0.3;
    if (!S.reloading && typeof S.hooks.reload === 'function') S.hooks.reload();
    return;
  }
  ammo[0] -= 1;
  hook('updateAmmo');
  S.shootCd = wp.interval;
  S.crossHeat = Math.min(S.crossHeat + 1, 3);
  play(wp.sfx || 'fire_ak47');
  reportPlayer(S.player.pos);

  if (muzzle) {
    muzzle.visible = true;
    muzzle.rotation.z = rand(0, Math.PI / 2);
    muzzleUntil = engineTime + 0.05;
  }
  S.vmAnim.recoil = 1;
  S.vmAnim.dip = 1;

  const spread = wp.spread * (S.scoped ? 0.3 : 1) * (shiftHeld() ? 2.5 : 1);
  const f = forwardVec(p.yaw, p.pitch);
  const r = rightVec(p.yaw);
  _fwd.set(f[0], f[1], f[2]);
  _right.set(r[0], r[1], r[2]);
  const up = new THREE.Vector3().crossVectors(_fwd, _right);
  p.pitch = clamp(p.pitch - wp.recoil * 0.5, -90, 90);

  // 霰弹枪一次打多颗弹丸, 每颗独立散射 / 独立判定 (CS 1.5 的 pellets 机制)。
  // 旧实现只发一条射线, 所以 M3 打不出"一枪糊脸"的效果。
  const pellets = Math.max(1, wp.pellets | 0 || 1);
  let anyEntity = false, anyHead = false, anyWall = null;
  for (let i = 0; i < pellets; i++) {
    _dir.set(f[0], f[1], f[2]);
    if (spread > 0) {
      _dir.addScaledVector(_right, rand(-spread, spread));
      _dir.addScaledVector(up, rand(-spread, spread));
    }
    _dir.normalize();

    const hit = rayHit(origin, _dir, A.BULLET_RANGE);
    if (hit.kind === 'entity') {
      const e = hit.entity;
      if (e.team === 'ct') {
        if (!anyEntity) showCenter('别打队友!', '#ff5050', 0.6);
        anyEntity = true;
        continue;
      }
      // 按命中高度判定部位, 应用 CS 1.5 的部位倍率与距离衰减
      const zone = hitZoneOf(hit.point, posOf(e.pos));
      const mult = A.HITBOX_MULT[zone] ?? 1;
      const travelled = dist3(p.pos, hit.point);
      const falloff = Math.max(0.4, 1 - travelled * (1 - (wp.range_mod ?? 0.98)) * 0.02);
      const dmg = wp.dmg * mult * falloff;
      if (typeof e.takeDamage === 'function') {
        e.takeDamage(dmg, zone === 'head', S.player.pos, '你', zone);
      }
      anyEntity = true;
      if (zone === 'head') anyHead = true;
    } else if (hit.kind === 'wall') {
      anyWall = hit;
    }
  }

  if (anyEntity) {
    play(anyHead ? 'head' : 'hit');
    hitText(anyHead ? '爆头!' : '命中');
  } else if (anyWall) {
    addBulletHole(anyWall.point, anyWall.normal);
    // 击中墙体: 溅射音 + 材质音
    play(Math.random() < 0.5 ? 'ric1' : 'ric2');
  }
}

// 命中部位: 用命中点相对 bot 脚底的高度分段 (CS 1.5 的 hitbox 比例:
// 头 ~0.85-1.0, 胸腹 ~0.5-0.85, 腿 0-0.5)
function hitZoneOf(point, feet) {
  if (!point || !feet) return 'chest';
  const rel = (point[1] - feet[1]) / BOT_HEIGHT;
  if (rel >= 0.86) return 'head';
  if (rel >= 0.55) return 'chest';
  if (rel >= 0.42) return 'stomach';
  return 'leg';
}

// ---------------------------------------------------------------------------
// bot 视觉: 每次调用都新建几何/材质, 不共享
// ---------------------------------------------------------------------------
export function makeBotMesh(modelName, weaponName) {
  const group = new THREE.Group();
  // 局部 y∈[0,1] -> 72 单位身高; 子节点保持 identity scale
  group.scale.set(32, 72, 32);
  const parts = [];
  const gunParts = [];

  const addModel = (name, out) => {
    const model = A.loadModel('player', name);
    for (const g of (model.groups || [])) {
      const mat = new THREE.MeshBasicMaterial({
        map: g.texture || null, vertexColors: true, side: THREE.DoubleSide,
        transparent: false, depthWrite: true, depthTest: true,
      });
      const mesh = new THREE.Mesh(g.geometry, mat);
      group.add(mesh);
      out.push({ mesh, texture: g.texture || null });
    }
    return model.meta || null;
  };
  addModel(modelName, parts);
  const wm = addModel(weaponName, gunParts);

  const hpBar = new THREE.Mesh(
    new THREE.PlaneGeometry(0.75, 0.055),
    new THREE.MeshBasicMaterial({
      color: 0x50ff50, side: THREE.DoubleSide,
      transparent: false, depthWrite: true, depthTest: true,
    }),
  );
  hpBar.position.set(0, 1.10, 0);
  group.add(hpBar);

  const flash = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      color: 0xffdc64, side: THREE.DoubleSide,
      transparent: false, depthWrite: true, depthTest: true,
    }),
  );
  const bb = wm && wm.bbox && wm.bbox[1];
  flash.position.set(bb ? bb[0] : 0, 0.80, bb ? bb[2] : 0);
  flash.scale.setScalar(0.16);
  flash.visible = false;
  group.add(flash);

  // 受击闪白只切换本 bot 自己材质上的 map
  const setHitFlash = on => {
    for (const p of parts) {
      p.mesh.material.map = on ? null : p.texture;
      p.mesh.material.needsUpdate = true;
    }
  };
  group.userData.hpBar = hpBar;
  group.userData.parts = parts;
  group.userData.gunParts = gunParts;
  group.userData.flash = flash;
  group.userData.setHitFlash = setHitFlash;
  botVisuals.add(group);
  return { group, parts, gunParts, hpBar, flash, setHitFlash };
}

export function addEntityMesh(mesh) {
  if (scene && mesh) {
    scene.add(mesh);
    if (mesh.userData && mesh.userData.hpBar) botVisuals.add(mesh);
  }
  return mesh;
}

export function removeEntityMesh(mesh) {
  if (scene && mesh) scene.remove(mesh);
  botVisuals.delete(mesh);
  return mesh;
}

// ---------------------------------------------------------------------------
// 初始化 / 每帧更新 / 渲染
// ---------------------------------------------------------------------------
function onResize() {
  const w = window.innerWidth || 1, h = window.innerHeight || 1;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h);
  for (const c of [camera, skyCamera, vmCamera]) {
    c.aspect = w / h;
    c.updateProjectionMatrix();
  }
}

export function initEngine(canvas) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.autoClear = false;

  const asp = window.innerWidth / Math.max(1, window.innerHeight);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(A.BASE_FOV, asp, 0.1, 10000);

  // 世界网格由 asset.js 建成 (DoubleSide / opaque), 原样加入, 不改材质
  const worldMeshes = (S.assets && S.assets.worldMeshes) || [];
  for (const m of worldMeshes) scene.add(m);

  // 天空: 独立场景 + 只同步旋转的相机。六面盒固定在 skyScene 原点,
  // 相当于永远以玩家为中心平移, 但不会随转头一起转 (远山不会变成墙纸)。
  skyScene = new THREE.Scene();
  skyCamera = new THREE.PerspectiveCamera(A.BASE_FOV, asp, 0.1, 10000);
  skyRoot = new THREE.Group();
  skyScene.add(skyRoot);
  const sky = (S.assets && S.assets.sky) || {};
  const faces = (S.assets && S.assets.skyFaces) || A.SKY_FACES;
  for (const face of faces) {
    const tex = sky[face.key];
    if (!tex) continue;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2 * SKY_D, 2 * SKY_D),
      new THREE.MeshBasicMaterial({
        map: tex, side: THREE.DoubleSide,
        depthTest: false, depthWrite: false,
      }),
    );
    mesh.position.set(face.pos[0], face.pos[1], face.pos[2]);
    mesh.rotation.set(face.rot[0] * DEG, face.rot[1] * DEG, face.rot[2] * DEG);
    mesh.renderOrder = -1000;
    mesh.frustumCulled = false;
    skyRoot.add(mesh);
  }

  vmScene = new THREE.Scene();
  vmCamera = new THREE.PerspectiveCamera(A.BASE_FOV, asp, 0.1, 10000);
  vmGroup = new THREE.Group();
  vmScene.add(vmGroup);
  vmRoot = new THREE.Group();
  vmGroup.add(vmRoot);
  vmWrapper = new THREE.Group();
  // 烘焙 z 前 -> three 相机 z 后; 负缩放是反射而非镜像 x, 不会左右翻转贴图
  vmWrapper.scale.set(1, 1, -1);
  vmRoot.add(vmWrapper);

  calibrateCamera();
  // 主场景/天空场景共用同一个镜像投影: 世界左右与 VM 一致
  if (mirrorX) {
    installMirror(camera);
    installMirror(skyCamera);
  }
  syncCamera();
  setFov(A.BASE_FOV);
  S.fov = A.BASE_FOV;
  buildViewmodel(S.weapon || 'usp');
  S.hooks.switchWeapon = buildViewmodel;
  S.hooks.shoot = shoot;

  window.addEventListener('resize', onResize);
  S.engine = Object.assign(S.engine || {}, {
    renderer, scene, camera, skyScene, skyCamera, vmScene, vmCamera,
    shoot, rayHit, buildViewmodel, addBulletHole,
    addEntityMesh, removeEntityMesh, makeBotMesh,
    getCamera, getScene, getVM,
  });
  return renderer;
}

export function updateEngine(dt) {
  if (!renderer) return;
  const d = Number.isFinite(dt) ? Math.max(0, dt) : 0;
  engineTime += d;
  const p = S.player;

  // 鼠标视角。
  //
  // 旧实现是 yaw += mouseDX * sensitivity * 0.02, sensitivity=40 -> 0.8 度/像素。
  // 那意味着横移 450 像素就转完 360 度, 鼠标稍微一动视角就飞掉。
  // 现在 sensitivity 改为"倍率"(默认 2.0), 每像素角度 = 0.06 * 倍率 = 0.12 度,
  // 与 CS 里 sensitivity 2~3 / 400~800 DPI 的手感接近 (约 3000 像素转一圈)。
  if (!S.buyMenuOpen && !p.dead) {
    const degPerPx = DEG_PER_COUNT * (Number.isFinite(p.sensitivity) ? p.sensitivity : DEFAULT_SENSITIVITY);
    p.yaw += (S.mouseDX || 0) * degPerPx;
    p.pitch = clamp(p.pitch + (S.mouseDY || 0) * degPerPx, -90, 90);
  }
  S.mouseDX = 0;
  S.mouseDY = 0;

  if (!p.dead && !S.buyMenuOpen) updatePhysics(d);

  S.shootCd -= d;
  S.crossHeat = Math.max(0, S.crossHeat - d * 6);
  const wp = A.WEAPONS[S.weapon];
  if (S.mouseDown && wp && wp.auto && !S.buyMenuOpen && !p.dead) shoot();

  if (S.weapon !== vmWeapon) buildViewmodel(S.weapon);
  const moving = held('w', 'W', 'KeyW', 'arrowup', 'ArrowUp')
    || held('s', 'S', 'KeyS', 'arrowdown', 'ArrowDown')
    || held('a', 'A', 'KeyA', 'arrowleft', 'ArrowLeft')
    || held('d', 'D', 'KeyD', 'arrowright', 'ArrowRight');
  updateVM(d, moving && !S.buyMenuOpen && !p.dead);

  const fov = S.scoped ? 22 : A.BASE_FOV;
  if (camera.fov !== fov) setFov(fov);
  S.fov = fov;

  updateHoles(d);
  syncCamera();
}

export function renderFrame() {
  if (!renderer) return;
  syncCamera();
  // 血条 billboard: 只处理由 makeBotMesh 登记的根组, 每帧朝向相机
  for (const root of botVisuals) {
    if (!root.parent || !root.visible) continue;
    const bar = root.userData.hpBar;
    if (!bar) continue;
    root.updateWorldMatrix(true, false);   // ai.js 本帧可能刚改过位置
    bar.lookAt(camera.position);
  }
  skyCamera.quaternion.copy(camera.quaternion);

  renderer.clear();
  renderer.render(skyScene, skyCamera);
  renderer.clearDepth();
  renderer.render(scene, camera);
  renderer.clearDepth();
  renderer.render(vmScene, vmCamera);
}

export function getCamera() { return camera; }
export function getScene() { return scene; }
export function getVM() { return vmGroup; }
