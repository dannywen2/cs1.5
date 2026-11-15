// web/engine.js
// three.js 渲染层 + 第一人称玩家/武器控制。
// 逻辑坐标(state.js): x 右 / y 上 / z 前, yaw=0 朝 +z —— 这是左手系;
// three.js 相机默认朝 -z 且为右手系, 两者之间需要一次反射, 见 calibrateCamera()。
import * as THREE from './vendor/three.module.js';
import * as A from './asset.js';
import { S, clamp, rand, choice, forwardVec, rightVec, yawTo, play, showCenter, reportPlayer, hitText, giveAmmo, dist3, notifyGunfire } from './state.js';

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
const MAX_SHELLS = 24;
const MAX_BLOOD = 30;
const MAX_TRACERS = 32;
const SHELL_TTL = 1.2;
const TRACER_TTL = 0.07;
const BLOOD_TTL = 20;
const SPECTATE_CYCLE = 4;
const RECOIL_RESET = 0.35;
const RECOIL_DIR_SCALE = 0.45;
const STEP_MATERIALS = {
  concrete: 'step_conc', metal: 'step_metal', wood: 'step_wood',
  tile: 'step_tile', dirt: 'step_conc',
};
const RIC_MATERIALS = {
  metal: 'ric_metal', concrete: 'ric_conc', wood: 'ric_wood',
  tile: 'ric_conc', dirt: 'ric_conc',
};
// asset.js 扩展前的兜底: 有 zoomLevels 时以武器表为准
const ZOOM_FALLBACK = {
  awp: [40, 15], sg550: [40, 15], g3sg1: [40, 15],
  scout: [40], aug: [40], sg552: [40],
};

let renderer = null;
let scene = null, camera = null;
let skyScene = null, skyCamera = null, skyRoot = null;
let vmScene = null, vmCamera = null, vmGroup = null, vmRoot = null, vmWrapper = null;
let muzzle = null, muzzleUntil = 0, vmWeapon = null;
let worldMuzzleLight = null, vmMuzzleLight = null, muzzleLightUntil = 0;
let vmBasePos = [0, 0, 0], vmBaseRot = [0, 0, 0], vmSwing = 0;
let defuseAmt = 0;         // 拆弹/下包姿态过渡量 0..1
let engineTime = 0;
let lastSpectateCycle = -99;
let burstQueue = 0, burstWid = null, burstLatch = false;
const shellGeo = new THREE.CylinderGeometry(0.9, 0.9, 3.2, 6);
const shellMat = new THREE.MeshBasicMaterial({ color: 0xc9923a, side: THREE.DoubleSide });
const bloodGeo = new THREE.PlaneGeometry(16, 16);

// 相机欧拉参数由 calibrateCamera() 实测确定 (不写死符号, 便于换 three.js 版本)
let pitchSign = -1, yawSign = 1, yawOffset = Math.PI, mirrorX = false;

const holeGeo = new THREE.PlaneGeometry(2, 2);
const bulletHoles = [];                 // {mesh, point, ttl}
const botVisuals = new Set();           // makeBotMesh 返回的根组, 用于血条 billboard

const _v3 = new THREE.Vector3();   // 枪模摆放计算的临时向量
const _dir = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _shellPos = new THREE.Vector3();
const _tracerEnd = new THREE.Vector3();

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

function effectArrays() {
  if (!S.effects) S.effects = { shells: [], tracers: [], blood: [] };
  if (!Array.isArray(S.effects.shells)) S.effects.shells = [];
  if (!Array.isArray(S.effects.tracers)) S.effects.tracers = [];
  if (!Array.isArray(S.effects.blood)) S.effects.blood = [];
  return S.effects;
}

function removeEffect(e) {
  if (!e || !e.mesh) return;
  if (e.mesh.parent) e.mesh.parent.remove(e.mesh);
  if (e.mesh.geometry && !e.sharedGeometry) e.mesh.geometry.dispose();
  if (e.mesh.material && !e.sharedMaterial) e.mesh.material.dispose();
}

function trimEffect(list, cap) {
  while (list.length > cap) removeEffect(list.shift());
}

function surfaceName(pos) {
  if (typeof A.materialAt !== 'function') return 'concrete';
  try { return A.materialAt(pos) || 'concrete'; }
  catch (_) { return 'concrete'; }
}

function wallRicochet(point, normal) {
  // rayHit 的 wall normal 指向射手, 沿它退到墙面外侧再取材质
  const n = posOf(normal) || [0, 0, 1];
  const probe = [point[0] + n[0] * 3, point[1] + n[1] * 3, point[2] + n[2] * 3];
  const name = surfaceName(probe);
  if (RIC_MATERIALS[name]) return RIC_MATERIALS[name];
  return Math.random() < 0.5 ? 'ric1' : 'ric2';
}

function updateMuzzleLight() {
  if (!worldMuzzleLight || !vmMuzzleLight) return;
  const left = muzzleLightUntil - engineTime;
  const k = clamp(left / 0.06, 0, 1);
  worldMuzzleLight.intensity = 22 * k;
  vmMuzzleLight.intensity = 1.8 * k;
  if (camera) {
    worldMuzzleLight.position.copy(camera.position);
    const f = forwardVec(S.player.yaw, S.player.pitch);
    worldMuzzleLight.position.x += f[0] * 12;
    worldMuzzleLight.position.y += f[1] * 12;
    worldMuzzleLight.position.z += f[2] * 12;
  }
}

function flashMuzzleLight() {
  muzzleLightUntil = engineTime + 0.06;
  updateMuzzleLight();
}

// ---------------------------------------------------------------------------
// 弹壳 / 曳光弹 / 血迹: 网格归 engine.js 所有, 数组与 game.js 共享
// ---------------------------------------------------------------------------
function spawnShell(origin, fwd, right, up) {
  if (!scene) return;
  const shells = effectArrays().shells;
  const mesh = new THREE.Mesh(shellGeo, shellMat);
  _shellPos.copy(origin)
    .addScaledVector(fwd, 24)
    .addScaledVector(right, 10)
    .addScaledVector(up, -6);
  mesh.position.copy(_shellPos);
  scene.add(mesh);
  shells.push({
    mesh, ttl: SHELL_TTL, sharedGeometry: true, sharedMaterial: true,
    played: false,
    vel: [right.x * rand(28, 52) + fwd.x * rand(4, 14) + rand(-8, 8),
      rand(35, 65),
      right.z * rand(28, 52) + fwd.z * rand(4, 14) + rand(-8, 8)],
    spin: [rand(-12, 12), rand(-12, 12), rand(-12, 12)],
  });
  trimEffect(shells, MAX_SHELLS);
}

function spawnTracer(origin, fwd, right, up, end) {
  if (!scene) return;
  const tracers = effectArrays().tracers;
  const start = new THREE.Vector3().copy(origin)
    .addScaledVector(fwd, 18)
    .addScaledVector(right, 9)
    .addScaledVector(up, -7);
  _tracerEnd.set(end[0], end[1], end[2]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([
    start.x, start.y, start.z, _tracerEnd.x, _tracerEnd.y, _tracerEnd.z,
  ], 3));
  const mat = new THREE.LineBasicMaterial({
    color: 0xffe6a0, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const mesh = new THREE.Line(geo, mat);
  mesh.frustumCulled = false;
  scene.add(mesh);
  tracers.push({ mesh, ttl: TRACER_TTL, life: TRACER_TTL });
  trimEffect(tracers, MAX_TRACERS);
}

function spawnBlood(point, forward) {
  if (!scene || typeof A.raySolidDistance !== 'function') return;
  const d = toVec3(forward).normalize();
  const ox = point[0] + d.x * 20, oy = point[1] + d.y * 20, oz = point[2] + d.z * 20;
  const t = A.raySolidDistance(ox, oy, oz, d.x, d.y, d.z, 140);
  if (!(t >= 0 && t <= 140)) return;
  const tex = S.assets && S.assets.sprites && S.assets.sprites.blood;
  const n = [-d.x, -d.y, -d.z];
  const p = [ox + d.x * t, oy + d.y * t, oz + d.z * t];
  const mat = new THREE.MeshBasicMaterial({
    map: tex || null, color: tex ? 0xffffff : 0x8b1010,
    side: THREE.DoubleSide, transparent: true, opacity: 0.9,
    depthWrite: false, depthTest: true,
    polygonOffset: true, polygonOffsetFactor: -2,
  });
  const mesh = new THREE.Mesh(bloodGeo, mat);
  mesh.position.set(p[0] + n[0] * 0.7, p[1] + n[1] * 0.7, p[2] + n[2] * 0.7);
  mesh.lookAt(p[0] + n[0], p[1] + n[1], p[2] + n[2]);
  mesh.rotation.z = rand(0, Math.PI * 2);
  mesh.renderOrder = 2;
  scene.add(mesh);
  const blood = effectArrays().blood;
  blood.push({ mesh, ttl: BLOOD_TTL, life: BLOOD_TTL, sharedGeometry: true });
  trimEffect(blood, MAX_BLOOD);
  play('blood1', p);
}

export function clearEffects() {
  const fx = effectArrays();
  for (const list of [fx.shells, fx.tracers, fx.blood]) {
    while (list.length) removeEffect(list.pop());
  }
  if (worldMuzzleLight) worldMuzzleLight.intensity = 0;
  if (vmMuzzleLight) vmMuzzleLight.intensity = 0;
  muzzleLightUntil = 0;
  burstQueue = 0;
  burstWid = null;
  burstLatch = false;
}

function updateEffects(dt) {
  const fx = effectArrays();
  const shells = fx.shells;
  for (let i = shells.length - 1; i >= 0; i--) {
    const s = shells[i];
    s.ttl -= dt;
    if (s.ttl > 0) {
      s.vel[1] -= A.GRAVITY * dt;
      s.mesh.position.x += s.vel[0] * dt;
      s.mesh.position.y += s.vel[1] * dt;
      s.mesh.position.z += s.vel[2] * dt;
      s.mesh.rotation.x += s.spin[0] * dt;
      s.mesh.rotation.y += s.spin[1] * dt;
      s.mesh.rotation.z += s.spin[2] * dt;
      const ground = (() => {
        if (typeof A.surfaceAt !== 'function' || typeof A.cellOf !== 'function') return null;
        try {
          const [cx, cz] = A.cellOf(s.mesh.position.x, s.mesh.position.z);
          return A.surfaceAt(cx, cz, s.mesh.position.y + 4);
        } catch (_) { return null; }
      })();
      const floorY = Number.isFinite(ground) ? ground + 1.6 : 2;
      if (s.mesh.position.y <= floorY) {
        s.mesh.position.y = floorY;
        if (!s.played) {
          s.played = true;
          play(`shell${1 + ((Math.random() * 3) | 0)}`, [s.mesh.position.x, s.mesh.position.y, s.mesh.position.z]);
        }
        s.ttl = Math.min(s.ttl, 0.25);
      }
    }
    if (s.ttl <= 0) {
      removeEffect(s);
      shells.splice(i, 1);
    }
  }
  const tracers = fx.tracers;
  for (let i = tracers.length - 1; i >= 0; i--) {
    const t = tracers[i];
    t.ttl -= dt;
    if (t.mesh.material) t.mesh.material.opacity = 0.9 * clamp(t.ttl / t.life, 0, 1);
    if (t.ttl <= 0) {
      removeEffect(t);
      tracers.splice(i, 1);
    }
  }
  const blood = fx.blood;
  for (let i = blood.length - 1; i >= 0; i--) {
    const b = blood[i];
    b.ttl -= dt;
    if (b.mesh.material) b.mesh.material.opacity = 0.9 * clamp(b.ttl / 2, 0, 1);
    if (b.ttl <= 0) {
      removeEffect(b);
      blood.splice(i, 1);
    }
  }
}

function toggleSilencer() {
  const wid = S.weapon;
  const wp = A.WEAPONS[wid];
  const canSilence = !!wp && (wp.silencer || wid === 'usp' || wid === 'm4a1');
  if (!canSilence) return;
  if (!S.silenced) S.silenced = {};
  S.silenced[wid] = !S.silenced[wid];
  play('deploy');
  showCenter(`${wp.name} 消音器 ${S.silenced[wid] ? '已开启' : '已关闭'}`, '#b4d2ff', 1.4);
}

function toggleGlockMode() {
  S.glockMode = S.glockMode === 'burst' ? 'semi' : 'burst';
  play('deploy');
  showCenter(`Glock-18 ${S.glockMode === 'burst' ? '三连发' : '单发'}`, '#b4d2ff', 1.4);
}

function getSpectate() {
  // 兼容两种落盘形态: 契约的 S.spectate 与 state.js 里的 S.player.spectate,
  // 始终让两个字段指向同一个对象, 避免观战状态分裂。
  const sp = S.spectate || (S.player && S.player.spectate) || {
    target: null, index: 0, yaw: 0, free: false, freePos: null, targetName: '',
  };
  S.spectate = sp;
  if (S.player) S.player.spectate = sp;
  return sp;
}

function cycleSpectate() {
  const sp = getSpectate();
  sp.index = (Number(sp.index) || 0) + 1;
  sp.target = null;
  sp.targetName = '';
  if (S.player && S.player.dead) spectatorTarget();
  else lastSpectateCycle = -99;
}

function toggleFreeCam() {
  const sp = getSpectate();
  sp.free = !sp.free;
  if (sp.free && !sp.freePos && camera) {
    sp.freePos = [camera.position.x, camera.position.y, camera.position.z];
  }
  showCenter(sp.free ? '自由观战' : '跟随队友', '#b4d2ff', 1.4);
}

function updateFreeCam(dt) {
  const sp = getSpectate();
  if (!sp.free || !S.player.dead || !camera) return;
  if (!sp.freePos) sp.freePos = [camera.position.x, camera.position.y, camera.position.z];
  const yaw = Number(sp.yaw) || 0;
  const f = forwardVec(yaw);
  const r = rightVec(yaw);
  const fw = (held('w', 'W', 'KeyW', 'arrowup', 'ArrowUp') ? 1 : 0)
           - (held('s', 'S', 'KeyS', 'arrowdown', 'ArrowDown') ? 1 : 0);
  const sd = (held('d', 'D', 'KeyD', 'arrowright', 'ArrowRight') ? 1 : 0)
           - (held('a', 'A', 'KeyA', 'arrowleft', 'ArrowLeft') ? 1 : 0);
  const rise = (spaceHeld() ? 1 : 0) - (ctrlHeld() ? 1 : 0)
             + (held('e', 'E', 'KeyE') ? 1 : 0) - (held('q', 'Q', 'KeyQ') ? 1 : 0);
  const len = Math.max(1, Math.hypot(fw, sd));
  const spd = 420 * dt;
  sp.freePos[0] += (f[0] * fw + r[0] * sd) / len * spd;
  sp.freePos[2] += (f[2] * fw + r[2] * sd) / len * spd;
  sp.freePos[1] += rise * spd;
}

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
  // 注意: 不要动 vmCamera.fov。第一人称枪模的摆放距离/缩放是按 BASE_FOV
  // 反算出来的 (见 buildViewmodel), 一旦跟着开镜改成 22, 枪会被放大 5 倍
  // 并挤出画面, 只剩一块残片。VM 永远用自己的固定 FOV。
}

// 阵亡后的观战目标: 唯一目标源, 不再依赖 S.player.pos 被传送。
function spectatorTarget() {
  const sp = getSpectate();
  const pool = (S.allies || []).filter(b => b && b.enabled !== false && b.dead !== true
    && (b.health === undefined || b.health > 0));
  if (!pool.length) {
    sp.target = null;
    sp.targetName = '';
    return null;
  }
  const valid = !!sp.target && sp.target.enabled !== false
    && (sp.target.health === undefined || sp.target.health > 0) && pool.includes(sp.target);
  const cycle = S.time - lastSpectateCycle >= SPECTATE_CYCLE;
  if (!valid || cycle) {
    const next = (Number(sp.index) || 0) + ((valid && cycle) ? 1 : 0);
    sp.index = pool.length ? ((next % pool.length) + pool.length) % pool.length : 0;
    sp.target = pool[sp.index] || null;
    lastSpectateCycle = S.time;
  }
  sp.targetName = (sp.target && sp.target.name) || '';
  return sp.target;
}

let lastSyncT = 0;
function syncCamera() {
  const p = S.player;
  // 供蹲起插值用: syncCamera 每帧可能调用多次, 用真实时钟差近似 dt
  const nowSync = performance.now();
  const dtSyncCam = Math.min(0.05, Math.max(0.001, (nowSync - lastSyncT) / 1000));
  lastSyncT = nowSync;

  // 阵亡 -> 第三人称跟随队友。
  // 旧实现无论如何都把相机放在玩家位置, 玩家死后位置不变, 相机就卡在尸体里;
  // bot 走近时会直接穿进模型内部 (实测画面 79.7% 是肤色, 能看到头的内侧)。
  if (p.dead) {
    const sp = getSpectate();
    if (sp.free) {
      if (!sp.freePos) sp.freePos = [p.pos[0], p.pos[1] + eyeHeight() + 40, p.pos[2]];
      camera.position.set(sp.freePos[0], sp.freePos[1], sp.freePos[2]);
      camera.rotation.set(0, (sp.yaw || 0) * DEG * yawSign + yawOffset, 0, 'YXZ');
      camera.updateMatrixWorld();
      skyCamera.quaternion.copy(camera.quaternion);
      skyCamera.position.set(0, 0, 0);
      return;
    }
    const t = spectatorTarget();
    if (t) {
      // 肩后视角: 目标身后 110 单位、上方 55 单位, 略微偏右
      const yaw = Number.isFinite(t.yaw) ? t.yaw : 0;
      const bx = -Math.sin(yaw * DEG), bz = -Math.cos(yaw * DEG);   // 目标背后
      const rx = Math.cos(yaw * DEG), rz = -Math.sin(yaw * DEG);    // 目标右侧
      const camX = t.pos[0] + bx * 110 + rx * 24;
      const camY = t.pos[1] + 55;
      const camZ = t.pos[2] + bz * 110 + rz * 24;
      // 防止贴墙时相机穿进墙里
      let fx = camX, fy = camY, fz = camZ;
      // 相机与目标之间若被墙挡住, 就退近一点 (用 engine 自己的射线检测)
      const ex = t.pos[0] - camX, ey = (t.pos[1] + A.EYE_HEIGHT) - camY, ez = t.pos[2] - camZ;
      const eLen = Math.hypot(ex, ey, ez) || 1;
      const blocked = typeof A.raySolidDistance === 'function'
        && A.raySolidDistance(camX, camY, camZ, ex / eLen, ey / eLen, ez / eLen, eLen) >= 0;
      if (blocked) {
        // 退回到更靠近目标的位置
        fx = t.pos[0] + bx * 55 + rx * 12;
        fy = t.pos[1] + 48;
        fz = t.pos[2] + bz * 55 + rz * 12;
      }
      camera.position.set(fx, fy, fz);
      // 望向目标头部
      const dx = t.pos[0] - fx, dy = (t.pos[1] + A.EYE_HEIGHT) - fy, dz = t.pos[2] - fz;
      const horiz = Math.hypot(dx, dz) || 1;
      const camYaw = Math.atan2(dx, dz);
      const camPitch = Math.atan2(dy, horiz);
      camera.rotation.set(camPitch * pitchSign, camYaw * yawSign + yawOffset, 0, 'YXZ');
      camera.updateMatrixWorld();
      skyCamera.quaternion.copy(camera.quaternion);
      skyCamera.position.set(0, 0, 0);
      return;
    }
    // 没有存活队友: 停在原地但抬高, 避免嵌进尸体
    camera.position.set(p.pos[0], p.pos[1] + eyeHeight() + 40, p.pos[2]);
    camera.rotation.set(p.pitch * DEG * pitchSign, p.yaw * DEG * yawSign + yawOffset, 0, 'YXZ');
    camera.updateMatrixWorld();
    skyCamera.quaternion.copy(camera.quaternion);
    skyCamera.position.set(0, 0, 0);
    return;
  }

  // 蹲起眼高平滑过渡 (原版蹲下有 ~0.3s 的过渡动画, 不是瞬切):
  // 指数逼近目标眼高, 起身时相机缓缓抬回, 不再"砰"地一下跳起。
  // 顺带缓冲上台阶: 物理位置精确抬高 ≤18 单位, 相机用短平滑跟随,
  // 走楼梯变成"轻微下沉-回弹"的节奏而不是逐级顿挫。
  {
    const want = p.crouching ? CROUCH_EYE : A.EYE_HEIGHT;
    if (!Number.isFinite(p.eyeSmooth)) p.eyeSmooth = want;
    p.eyeSmooth += (want - p.eyeSmooth) * Math.min(1, dtSyncCam * 10);
    // 相机 y 对物理 y 突变 (台阶) 做快速平滑: 大跳变以 ~15/s 速率追赶,
    // 18 单位的台阶约 0.1s 走完, 既消除顿挫又不产生明显滞后。
    if (!Number.isFinite(p.camYSmooth)) p.camYSmooth = p.pos[1];
    const dy = p.pos[1] - p.camYSmooth;
    p.camYSmooth = Math.abs(dy) < 1 ? p.pos[1]
      : p.camYSmooth + dy * Math.min(1, dtSyncCam * 15);
    // 重生/掉出世界后 y 差异大, 直接硬切避免相机飞过整个地图
    if (Math.abs(dy) > 200) p.camYSmooth = p.pos[1];
    camera.position.set(p.pos[0], p.camYSmooth + p.eyeSmooth, p.pos[2]);
  }
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
    // 穿墙 (wallbang): 若墙后近距离内有 bot (薄墙/木箱后), 标记穿透命中,
    // 由调用方按墙厚/材质衰减伤害。厚度 = bot 入射 t - 墙入射 t。
    if (entity && typeof A.raySolidDistanceAfter === 'function') {
      const exitT = A.raySolidDistanceAfter(o.x, o.y, o.z, d.x, d.y, d.z,
        Math.min(entT + 1, maxT), wallT + 0.1);
      const wallThick = exitT >= 0 ? exitT - wallT : entT - wallT;
      if (wallThick > 0 && wallThick <= 64) {
        const r = entityResult();
        r.wallbang = true;
        r.wallThick = wallThick;
        return r;
      }
    }
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
  p.crouching = ctrlHeld();
  p.speed = p.crouching ? A.CROUCH_SPEED : (shiftHeld() ? A.WALK_SPEED : A.RUN_SPEED);
  // 空中用速度向量积分 (GoldSrc air accelerate): 起跳保留地面速度, 空中按键
  // 加速度补充、上限钳制 —— 空中可以小幅变向但不能瞬间转向。
  if (p.vel2 === undefined) p.vel2 = [0, 0];
  if (len > 0) {
    dx /= len; dz /= len;
    if (p.grounded) {
      p.vel2[0] = dx * p.speed;
      p.vel2[1] = dz * p.speed;
    } else {
      // 空中加速度: wishdir * airAccel * dt, 速度增量钳制在 RUN_SPEED 内
      const acc = A.AIR_CONTROL * A.RUN_SPEED * dt;
      const nvx = p.vel2[0] + dx * acc, nvz = p.vel2[1] + dz * acc;
      const cur = Math.hypot(p.vel2[0], p.vel2[1]);
      const nxt = Math.hypot(nvx, nvz);
      if (nxt > Math.max(cur, A.RUN_SPEED)) {
        const k = Math.max(cur, A.RUN_SPEED) / nxt;
        p.vel2[0] = nvx * k; p.vel2[1] = nvz * k;
      } else {
        p.vel2[0] = nvx; p.vel2[1] = nvz;
      }
    }
  } else if (p.grounded) {
    p.vel2[0] = 0; p.vel2[1] = 0;
  }
  {
    const mx = p.vel2[0] * dt, mz = p.vel2[1] * dt;
    if (!solid(p.pos[0] + mx, p.pos[1], p.pos[2])) p.pos[0] += mx;
    else if (mx) stepUp(p.pos[0] + mx, p.pos[2]);
    if (!solid(p.pos[0], p.pos[1], p.pos[2] + mz)) p.pos[2] += mz;
    else if (mz) stepUp(p.pos[0], p.pos[2] + mz);
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
        p.pos[1] = hi; p.vy = 0; p.grounded = true;
        // 落地音效: 下落速度越大声音越重 (原版 pl_fall / pl_step 重击)
        if (p.airTime > 0.25) {
          const name = STEP_MATERIALS[surfaceName(p.pos)] || 'step_conc';
          play(name, p.pos);
        }
        p.airTime = 0;
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

    // Placement: centre the model, then scale it so its *rendered* vertical
    // extent matches the per-class target from VM_TUNE.
    //
    // Model units are GoldSrc units (a rifle spans 30+ along the barrel), so a
    // fixed hand-tuned scale per weapon never lines up: measured on-screen
    // height ranged from 25% to 336%. Here the scale is solved from the
    // geometry itself, so every weapon of a class ends up the same size.
    const tune = A.vmLds(wid);
    const dist = Math.max(0.15, tune.toCam);
    const halfFovTan = Math.tan((A.BASE_FOV * DEG) / 2);
    const rot = tune.rot.map(v => v * DEG);

    // bounding box in baked space
    let bMinY = Infinity, bMaxY = -Infinity, bMinX = Infinity, bMaxX = -Infinity;
    let bMinZ = Infinity, bMaxZ = -Infinity;
    for (const g of data.groups) {
      const pa = g.geometry && g.geometry.getAttribute && g.geometry.getAttribute("position");
      if (!pa) continue;
      for (let i = 0; i < pa.count; i++) {
        const x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i);
        if (y < bMinY) bMinY = y; if (y > bMaxY) bMaxY = y;
        if (x < bMinX) bMinX = x; if (x > bMaxX) bMaxX = x;
        if (z < bMinZ) bMinZ = z; if (z > bMaxZ) bMaxZ = z;
      }
    }
    const cx0 = (bMinX + bMaxX) / 2, cy0 = (bMinY + bMaxY) / 2, cz0 = (bMinZ + bMaxZ) / 2;

    // Solve scale so that (model vertical span * scale) / (dist * tan(fov/2))
    // equals the target NDC height. Uses the *rotated* vertical extent, which
    // is what the player actually sees.
    const euler = new THREE.Euler(rot[0], -rot[1], -rot[2], "XYZ");
    const q = new THREE.Quaternion().setFromEuler(euler);
    let minY = Infinity, maxY = -Infinity, maxAbsZ = 0;
    for (const g of data.groups) {
      const pa = g.geometry && g.geometry.getAttribute && g.geometry.getAttribute("position");
      if (!pa) continue;
      const step = Math.max(1, Math.floor(pa.count / 128));
      for (let i = 0; i < pa.count; i += step) {
        _v3.set(pa.getX(i) - cx0, pa.getY(i) - cy0, -(pa.getZ(i) - cz0));
        _v3.applyQuaternion(q);
        if (_v3.y < minY) minY = _v3.y;
        if (_v3.y > maxY) maxY = _v3.y;
        const az = Math.abs(_v3.z);
        if (az > maxAbsZ) maxAbsZ = az;
      }
    }
    const spanY = Math.max(1e-4, maxY - minY);
    const targetNdc = (tune.heightPct / 100) * 2;
    // Nearest face of the model sits at dist - scale*maxAbsZ; use it for the
    // projection so the visible size matches the target rather than being
    // computed from the model centre.
    const k = targetNdc * maxAbsZ * halfFovTan;
    let scale = (targetNdc * dist * halfFovTan) / (spanY + k);
    if (Number.isFinite(tune.fit)) scale *= tune.fit;   // 逐武器实测修正 (见 VM_FIT)
    scale = Math.max(1e-6, Math.min(scale, 5.0));

    vmBasePos = [tune.right, tune.down, -dist];
    vmBaseRot = [rot[0], -rot[1], -rot[2]];
    vmRoot.position.set(vmBasePos[0], vmBasePos[1], vmBasePos[2]);
    vmRoot.rotation.set(vmBaseRot[0], vmBaseRot[1], vmBaseRot[2]);
    vmRoot.scale.setScalar(scale);
    vmWrapper.position.set(-cx0, -cy0, -cz0);

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
      // Hand/thumb textures use palette index 255 as a cut-out (finger edges,
      // trigger-guard holes); mdl.py maps that index to alpha=0, so alphaTest
      // is required or those holes get painted as near-black blotches.
      // alphaTest (not transparent) keeps the opaque pipeline and render order.
      const hasAlpha = !!(g.texture && g.hand);
      const mat = new THREE.MeshBasicMaterial({
        map: g.texture || null, vertexColors: true, side: THREE.DoubleSide,
        transparent: false, depthTest: false, depthWrite: false,
        alphaTest: hasAlpha ? 0.5 : 0,
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
  const sprites = (S.assets && S.assets.sprites) || {};
  muzzle = new THREE.Mesh(
    new THREE.PlaneGeometry(1.8, 1.8),
    new THREE.MeshBasicMaterial({
      map: sprites.muzzle || null, color: sprites.muzzle ? 0xffffff : 0xffe278,
      side: THREE.DoubleSide, transparent: !!sprites.muzzle, alphaTest: sprites.muzzle ? 0.02 : 0,
      depthTest: false, depthWrite: false,
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

// 换弹动作: 按换弹进度 (0..1) 驱动第一人称枪模做"下沉 -> 侧倾 -> 归位"。
// 旧实现换弹只有音效, 枪模纹丝不动, 玩家完全看不出在换弹。
// 曲线: 前 18% 快速下沉, 中段保持并在抖动中"换弹匣", 后 30% 回升到原位。
function reloadPose(t) {
  if (t <= 0 || t >= 1) return { drop: 0, roll: 0, pitch: 0, yaw: 0, forward: 0 };
  const smooth = x => x * x * (3 - 2 * x);      // smoothstep
  let drop, roll;
  if (t < 0.18) {
    const k = smooth(t / 0.18);
    drop = k; roll = k;
  } else if (t < 0.70) {
    drop = 1; roll = 1;
  } else {
    const k = smooth((t - 0.70) / 0.30);
    drop = 1 - k; roll = 1 - k;
  }
  // 中段插入一个换弹匣的顿挫 (两次小幅抖动), 让动作不是匀速平移
  let jitter = 0;
  if (t > 0.22 && t < 0.68) {
    const phase = (t - 0.22) / 0.46;            // 0..1
    jitter = Math.sin(phase * Math.PI * 4) * 0.35 * Math.sin(phase * Math.PI);
  }
  return {
    drop: drop + jitter * 0.12,
    roll: roll,
    pitch: roll * 18 * DEG,                      // 枪口下压
    yaw: roll * 10 * DEG,                        // 枪身向内侧转
    forward: drop * 0.14 + jitter * 0.05,        // 轻微前后推拉 (幅度要小, 否则枪会缩进相机)
  };
}

// 拆弹 / 下包时的手部姿态 (CS 1.5 会明显把枪收下去俯身操作)。
// amt 0..1 是动作的过渡量, 避免瞬间切换。
function defusePose(amt) {
  const k = Math.max(0, Math.min(1, amt));
  return {
    drop: 0.85 * k,
    roll: 0.7 * k,
    pitch: 20 * k * Math.PI / 180,
    yaw: 14 * k * Math.PI / 180,
    forward: 0.10 * k,
  };
}


function updateVM(dt, moving) {
  if (!vmRoot) return;
  const a = S.vmAnim;
  const wp = A.WEAPONS[S.weapon] || { recoil: 1 };
  a.t += dt;
  a.recoil = Math.max(0, a.recoil - dt / 0.18);
  a.dip = Math.max(0, a.dip - dt / 0.2);
  vmSwing = Math.max(0, vmSwing - dt / 0.35);

  // 换弹动作叠加 (按换弹进度插值)
  const rp = S.reloading ? reloadPose(S.reloadProgress || 0) : { drop: 0, roll: 0, pitch: 0, yaw: 0, forward: 0 };

  // 注意: 位置必须**基于基准值赋值**, 不能用 += / -= 累积。旧实现
  // vmRoot.position.y -= rp.drop * 0.16 每帧在上帧结果上继续偏移,
  // 换弹两秒后枪会沉到屏幕外 (实测 y 从 -0.22 漂到 -1.45)。
  let baseY = vmBasePos[1];
  if (moving && S.player.grounded) {
    baseY += Math.sin(engineTime * 10) * 0.02;
    S.stepTimer -= dt;
    if (S.stepTimer <= 0) {
      S.stepTimer = shiftHeld() ? 0.32 : 0.42;
      const name = STEP_MATERIALS[surfaceName(S.player.pos)] || 'step_conc';
      play(name, S.player.pos);
    }
  }
  // 拆弹/下包姿态: 按住 E 拆包时把枪收下去并俯身。
  // S.defuseHeld 由输入层维护, BOMB.state 决定现在是否真的在操作。
  const wantDefuse = (S.defuseHeld && !S.player.dead && !S.buyMenuOpen &&
                      (S.BOMB.state === 'planted' || S.BOMB.state === 'live')) ? 1 : 0;
  // 0.25 秒的淡入淡出, 避免动作瞬间弹出
  defuseAmt += (wantDefuse - defuseAmt) * Math.min(1, dt * 4);
  const dp = defusePose(defuseAmt);

  // 相机空间 y 向下为负 -> 下沉即减小 y
  vmRoot.position.y = baseY - (rp.drop + dp.drop) * 0.16;

  vmRoot.rotation.x = vmBaseRot[0] - 1.5 * wp.recoil * a.recoil * DEG + rp.pitch + dp.pitch;
  vmRoot.rotation.y = vmBaseRot[1] + rp.yaw + dp.yaw;
  vmRoot.rotation.z = vmBaseRot[2] - 40 * vmSwing * DEG - (rp.roll + dp.roll) * 8 * DEG;
  // 后坐向相机方向回缩: 相机空间 z 为负, 回缩即 z 增大
  vmRoot.position.z = vmBasePos[2] + 0.08 * a.dip + rp.forward + dp.forward;
  if (muzzle) muzzle.visible = engineTime < muzzleUntil;
}

// ---------------------------------------------------------------------------
// 射击
// ---------------------------------------------------------------------------
function canFire(ignoreCd = false) {
  return !!S.shootingEnabled && !S.buyMenuOpen && !S.reloading && (ignoreCd || S.shootCd <= 0)
    && !S.player.dead && S.BOMB.state !== 'over'
    && (!S.round || (S.round.phase !== 'freeze' && S.round.phase !== 'over'));
}

function pumpBurst() {
  if (!burstQueue) return;
  if (S.weapon !== burstWid || !canFire(true)) {
    burstQueue = 0; burstWid = null; return;
  }
  burstQueue -= 1;
  fireOne(true);
  if (burstQueue) {
    const wp = A.WEAPONS[burstWid];
    // interval 是真实时间间隔, setTimeout 不受 updateEngine 的 dt 钳制影响
    setTimeout(pumpBurst, Math.max(0, (wp && wp.interval ? wp.interval : 0.15)) * 1000);
  } else {
    burstWid = null;
  }
}

export function shoot() {
  fireOne(false);
}

function fireOne(fromBurst = false) {
  if (!canFire(fromBurst)) return;
  const p = S.player;
  const wid = S.weapon;
  const wp = A.WEAPONS[wid];
  if (!wp) return;
  // 三连发是「按一次左键」触发, 不因按住左键进入自动武器的持续射击
  const canBurst = wid === 'glock18' && (wp.burst !== false || S.glockMode === 'burst');
  if (!fromBurst && canBurst && S.glockMode === 'burst') {
    if (burstQueue || burstLatch) return;
    burstLatch = true;
    burstWid = S.weapon;
    burstQueue = 3;
    pumpBurst();
    return;
  }
  const canSilence = !!wp && (wp.silencer || wid === 'usp' || wid === 'm4a1');
  const silenced = canSilence && !!(S.silenced && S.silenced[wid]);
  const origin = new THREE.Vector3(p.pos[0], p.pos[1] + eyeHeight(), p.pos[2]);

  if (wp.melee) {
    S.shootCd = wp.interval;
    vmSwing = 1;
    const f = forwardVec(p.yaw, p.pitch);
    const hit = rayHit(origin, new THREE.Vector3(f[0], f[1], f[2]), A.MELEE_RANGE);
    // CS 1.5 匕首: 正面砍 ~55, 背刺秒杀。背刺判定用攻击者与目标的朝向夹角。
    if (hit.kind === 'entity') {
      const e = hit.entity;
      if (e.team === (S.playerTeam || 'ct')) { showCenter('队友!', '#ff5050', 0.6); return; }
      const bp = posOf(e.pos);
      let backstab = false;
      if (bp && Number.isFinite(e.yaw)) {
        // 目标朝向 bot.yaw (度, 0 朝 +z); 攻击者相对目标的方位
        const toAtk = Math.atan2(p.pos[0] - bp[0], p.pos[2] - bp[2]) * 180 / Math.PI;
        let diff = ((toAtk - e.yaw) % 360 + 540) % 360 - 180;
        // toAtk 是"目标 -> 攻击者"的方位角: 站在目标正前方时 diff≈0, 站在
        // 正后方时 diff≈±180。所以背刺应取 |diff| > 120 (后方 120° 扇区);
        // 旧代码写成 < 60, 等于正面砍也算背刺 (4 倍伤害秒杀)。
        backstab = Math.abs(diff) > 120;
      }
      play(backstab ? 'knife_stab' : 'knife');
      const zone = backstab ? 'chest' : hitZoneOf(hit.point, bp);
      const mult = backstab ? 4 : (A.HITBOX_MULT[zone] ?? 1);
      if (typeof e.takeDamage === 'function') {
        e.takeDamage(wp.dmg * mult, backstab, S.player.pos, '你', zone);
      }
      spawnBlood(hit.point, f);
      play('hit');
    } else if (hit.kind === 'wall') {
      addBulletHole(hit.point, hit.normal);
      play('knife_hitwall');
    } else {
      play('knife');
    }
    return;
  }

  if (!S.ammo[wid]) giveAmmo(wid);
  const ammo = S.ammo[wid];
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
  play((silenced ? `${wp.sfx}_sil` : wp.sfx) || 'fire_ak47');
  reportPlayer(S.player.pos);
  // 枪声事件只写一次: 直接调用 state.js 的函数, 不再触发 game.js 注册的 hook
  notifyGunfire(S.player.pos, S.playerTeam, silenced ? 0.35 : 1);

  if (muzzle) {
    muzzle.visible = true;
    muzzle.rotation.z = rand(0, Math.PI / 2);
    muzzleUntil = engineTime + 0.05;
  }
  flashMuzzleLight();
  S.vmAnim.recoil = 1;
  S.vmAnim.dip = 1;

  const f = forwardVec(p.yaw, p.pitch);
  const r = rightVec(p.yaw);
  _fwd.set(f[0], f[1], f[2]).normalize();
  _right.set(r[0], r[1], r[2]);
  _up.crossVectors(_fwd, _right).normalize();   // 屏幕上方 = forwardVec(yaw, pitch-90)
  spawnShell(origin, _fwd, _right, _up);

  // 确定性后坐力: 停火 0.35s 后弹道归零, 角度抬枪 + 射线方向同步偏移。
  const pattern = (Array.isArray(wp.recoilPattern) && wp.recoilPattern.length)
    ? wp.recoilPattern
    : ((A.RECOIL_PATTERNS && A.RECOIL_PATTERNS[wid]) || [[0, wp.recoil || 1]]);
  const rec = S.recoil || (S.recoil = { index: 0, lastAt: -99 });
  const lastAt = Number.isFinite(rec.lastAt) ? rec.lastAt : -99;
  if (S.time - lastAt > RECOIL_RESET) rec.index = 0;
  const step = pattern[(Number(rec.index) || 0) % pattern.length] || [0, 0];
  const kickYaw = Number(step[0]) || 0;
  const kickPitch = Math.abs(Number(step[1]) || 0);
  p.yaw += kickYaw;
  p.pitch = clamp(p.pitch - kickPitch, -90, 90);
  rec.index = (Number(rec.index) || 0) + 1;
  rec.lastAt = S.time;

  // 动态散布 (还原 CS 1.5 的 inaccuracy 机制, 逐枪调参见 asset.js SPREAD_TUNING):
  //   移动惩罚按实际速度比例 × 该枪 move 系数, 空中 × air (狙击跳狙最惨),
  //   蹲下 × crouch 收束, 连射热度 = heat × 武器 recoil, 狙击未开镜腰射 ×6。
  const tun = A.SPREAD_TUNING[wid] || A.DEFAULT_TUNING;
  const moveK = p.grounded
    ? clamp((p.speed || 0) / A.RUN_SPEED, 0, 1) * (S.scoped ? tun.scopedMove : tun.move)
    : tun.air;
  // 霰弹枪的弹丸锥是固定的 (原版 pellets 不随连射变), heatK 只作用于单弹丸武器
  const heatK = (wp.pellets | 0 || 1) > 1
    ? 1
    : 1 + (S.crossHeat || 0) * tun.heat * (wp.recoil || 1);
  const burstK = (S.glockMode === 'burst' && wid === 'glock18') ? tun.burst : 0;
  const scopeK = wp.zoom && !S.scoped ? 6 : 1;
  const spread = wp.spread * (1 + moveK)
    * (p.crouching ? tun.crouch : 1) * heatK * (1 + burstK) * scopeK
    * (silenced ? 0.85 : 1)
    // 换弹后精度不会立刻恢复 (原版换弹收枪动作打断了持枪稳定): 保留一半热度
    * (S.reloading ? 1.5 : 1);
  const dmgScale = silenced ? 0.9 : 1;
  const dirYaw = kickYaw * DEG * RECOIL_DIR_SCALE;
  const dirPitch = kickPitch * DEG * RECOIL_DIR_SCALE;

  // 霰弹枪一次打多颗弹丸, 每颗独立散射 / 独立判定 (CS 1.5 的 pellets 机制)。
  // 弹丸散布用圆形锥形分布 (均匀角度 + 半径开方), 而不是方形随机 ——
  // 方形分布会在对角线方向堆积, 视觉上"弹道挤成一束"。
  const pellets = Math.max(1, wp.pellets | 0 || 1);
  const isPellet = pellets > 1;
  let anyEntity = false, anyHead = false, anyWall = null, bloodDone = false;
  let farthest = null, farthestD = -1;
  let holeCount = 0, tracerCount = 0;
  for (let i = 0; i < pellets; i++) {
    _dir.copy(_fwd)
      .addScaledVector(_right, dirYaw)
      .addScaledVector(_up, dirPitch);
    if (spread > 0) {
      // 圆形锥形: 角度均匀取 [0,2π), 半径按 sqrt(u) 均匀铺满圆盘
      const ang = Math.random() * Math.PI * 2;
      const rad = Math.sqrt(Math.random()) * spread;
      _dir.addScaledVector(_right, Math.cos(ang) * rad)
        .addScaledVector(_up, Math.sin(ang) * rad);
    }
    _dir.normalize();

    const hit = rayHit(origin, _dir, A.BULLET_RANGE);
    const hp = posOf(hit.point);
    if (hp) {
      const d = dist3([origin.x, origin.y, origin.z], hp);
      if (d > farthestD) { farthestD = d; farthest = hp; }
    }
    // 每颗弹丸一条曳光 (霰弹最多画 4 条, 避免糊屏; 步枪只 1 条)
    if (isPellet ? tracerCount < 4 : i === 0) {
      tracerCount += 1;
      spawnTracer(origin, _fwd, _right, _up, hp || [origin.x + _dir.x * A.BULLET_RANGE,
        origin.y + _dir.y * A.BULLET_RANGE, origin.z + _dir.z * A.BULLET_RANGE]);
    }
    if (hit.kind === 'entity') {
      const e = hit.entity;
      if (!bloodDone) {
        bloodDone = true;
        spawnBlood(hit.point, _dir);
      }
      if (e.team === (S.playerTeam || 'ct')) {
        if (!anyEntity) showCenter('别打队友!', '#ff5050', 0.6);
        anyEntity = true;
        continue;
      }
      // 按命中高度判定部位, 应用 CS 1.5 的部位倍率与距离衰减。
      // GoldSrc 原版公式: damage × range_mod^(distance/500) —— 250 单位内
      // 几乎无衰减, 旧实现 (1 - d×k) 线性衰减对霰弹枪过于苛刻, 糊脸打不出
      // 应有的秒杀感。
      const zone = hitZoneOf(hit.point, posOf(e.pos));
      const mult = A.HITBOX_MULT[zone] ?? 1;
      const travelled = dist3(p.pos, hit.point);
      const falloff = Math.max(0.25, Math.pow(wp.range_mod ?? 0.98, travelled / 500));
      // 穿墙 (wallbang): 伤害按穿透厚度衰减, 64 单位内 30%~70%
      const penK = hit.wallbang
        ? Math.max(0.30, 1 - (hit.wallThick || 32) / 64 * 0.7) : 1;
      const dmg = wp.dmg * mult * falloff * dmgScale * penK;
      if (typeof e.takeDamage === 'function') {
        e.takeDamage(dmg, zone === 'head', S.player.pos, '你', zone);
      }
      anyEntity = true;
      if (zone === 'head') anyHead = true;
    } else if (hit.kind === 'wall') {
      anyWall = hit;
      // 每颗弹丸独立弹孔 (霰弹最多 3 个, 一面墙上是散开的孔洞簇)
      if (holeCount < (isPellet ? 3 : 1)) {
        holeCount += 1;
        addBulletHole(hit.point, hit.normal);
      }
    }
  }

  // 非霰弹: 曳光弹已在循环里画 (第 0 颗); 霰弹一条都没有时兜底画中心一条
  if (!tracerCount && farthest) spawnTracer(origin, _fwd, _right, _up, farthest);

  if (anyEntity) {
    play(anyHead ? 'head' : 'hit');
    hitText(anyHead ? '爆头!' : '命中');
  } else if (anyWall) {
    addBulletHole(anyWall.point, anyWall.normal);
    const ric = wallRicochet(anyWall.point, anyWall.normal);
    play(ric, anyWall.point);
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
  // 局部 y∈[0,1] -> 72 单位身高。三轴等比: .geo 归一化时保持了真实宽高比,
  // x/z 用 32 会把模型横向压瘦约 44% (与原版相比显得"瘦长")。
  group.scale.setScalar(72);
  const parts = [];
  const gunParts = [];
  // 该玩家模型的行走/奔跑动画 (可能缺失 -> 退回静态姿态)
  const animData = (S.assets && S.assets.anims && S.assets.anims[modelName]) || null;

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

  // 动画播放: 逐帧把烘焙好的顶点位置写进 position 属性。
  // 每帧顶点数必须与静态几何一致 (同一模型烘焙而来), 否则跳过。
  let animClip = null;
  let animTime = 0;
  let animFrame = -1;
  const animParts = parts.filter(p => p.mesh && p.mesh.geometry &&
    p.mesh.geometry.getAttribute && p.mesh.geometry.getAttribute("position"));

  // .anim 的顶点按"三角形展开"布局烘焙, 且记录了每个几何组的顶点数
  // (例如 leet 是 [2220, 36])。播放时按组把顶点流切回去分别写入,
  // 否则多贴图模型只有第一组会动。
  const setClip = (name) => {
    if (!animData || !animData.clips || !animData.clips[name]) return false;
    if (animClip && animClip.name === name) return true;
    const c = animData.clips[name];
    if (!c.groupVerts || c.groupVerts.length < animParts.length) return false;
    // 每个组的顶点数都必须与静态几何一致, 否则这份动画不能用于该模型
    for (let i = 0; i < animParts.length; i++) {
      const n = animParts[i].mesh.geometry.getAttribute("position").count;
      if (c.groupVerts[i] !== n) return false;
    }
    animClip = c;
    animFrame = -1;
    animTime = 0;
    return true;
  };

  const updateAnim = (dt, speed) => {
    if (!animData) return;
    const want = speed > 150 ? "run" : (speed > 12 ? "walk" : null);
    if (!want) { animClip = null; return; }
    if (!setClip(want)) return;
    // GoldSrc 实测: 走路 133 单位/秒, 跑步 250 单位/秒
    const baseSpeed = want === "run" ? 250 : 133;
    const rate = Math.max(0.35, Math.min(speed / baseSpeed, 2.2));
    const fps = 30 * rate;
    animTime += dt;
    const nf = animClip.nframes;
    const f = Math.floor(animTime * fps) % nf;
    if (f === animFrame) return;
    animFrame = f;
    const src = animClip.frames[f];
    // 按组切片写入
    let off = 0;
    for (let i = 0; i < animParts.length; i++) {
      const attr = animParts[i].mesh.geometry.getAttribute("position");
      const n = attr.count * 3;
      if (off + n <= src.length) {
        for (let k = 0; k < n; k++) attr.array[k] = src[off + k];
        attr.needsUpdate = true;
      }
      off += n;
    }
  };

  const hpBar = new THREE.Mesh(
    new THREE.PlaneGeometry(0.75, 0.055),
    new THREE.MeshBasicMaterial({
      color: 0x50ff50, side: THREE.DoubleSide,
      transparent: false, depthWrite: true, depthTest: true,
    }),
  );
  hpBar.position.set(0, 1.10, 0);
  group.add(hpBar);

  // 枪口焰: 一块小方片, 只在开火瞬间显示。
  //
  // 坐标系: group 的缩放是等比 72 (0..1 模型局部 -> 世界单位), 位置取
  // 包围盒最前端 (z 最大) 的中心, 再往前推一点避免被身体挡住。
  // 火光世界尺寸约 4 单位 (屏高约 4%), 与原版小闪光相称。
  const flash = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      color: 0xffdc64, side: THREE.DoubleSide,
      transparent: false, depthWrite: false, depthTest: false,
    }),
  );
  const wb = (wm && wm.bbox) || null;
  if (wb && wb[0] && wb[1]) {
    // 枪口 = 包围盒最前端 (z 最大) 的中心, 再往前推一点避免被身体挡住
    const cx = (wb[0][0] + wb[1][0]) / 2;
    const cy = (wb[0][1] + wb[1][1]) / 2;
    flash.position.set(cx, cy, wb[1][2] + 0.12);
  } else {
    flash.position.set(0, 0.80, 0.62);
  }
  // 火光世界尺寸 4 单位 (group 等比缩放 72, 直接除 72 即可)
  const FSIZE = 4.0;
  flash.scale.setScalar(FSIZE / 72);
  flash.visible = false;
  group.add(flash);

  // 受击闪白只切换本 bot 自己材质上的 map
  // 受击闪白: 只调颜色的加成, 不碰 map / needsUpdate。
  // 旧实现把 material.map 在 null 与 texture 之间来回切, 会改变 USE_MAP 宏,
  // 每次命中触发两次完整 shader 重编译 —— 交火时成片卡顿。
  const setHitFlash = on => {
    for (const p of parts) {
      const m = p.mesh.material;
      if (!m || !m.color) continue;
      if (on) m.color.setRGB(2.2, 2.2, 2.2);      // 过曝泛白
      else m.color.setRGB(1, 1, 1);
    }
  };
  let deathPlayed = false;
  const playDeath = () => {
    if (deathPlayed) return;
    deathPlayed = true;
    if (hpBar) hpBar.visible = false;
    if (flash) flash.visible = false;
    try {
      const clips = animData && animData.clips;
      const c = clips && (clips.death || clips.die || clips.dying);
      if (c && Array.isArray(c.frames) && c.frames.length) {
        const src = c.frames[c.frames.length - 1];
        if (src) {
          let off = 0;
          for (let i = 0; i < animParts.length; i++) {
            const attr = animParts[i].mesh.geometry.getAttribute("position");
            const n = attr.count * 3;
            if (off + n <= src.length) {
              for (let k = 0; k < n; k++) attr.array[k] = src[off + k];
              attr.needsUpdate = true;
            }
            off += n;
          }
          return;
        }
      }
    } catch (_) { /* 动画数据异常时退回倒地姿态 */ }
    group.rotation.x = -Math.PI / 2;
    group.position.y -= 10;
  };

  group.userData.hpBar = hpBar;
  group.userData.parts = parts;
  group.userData.gunParts = gunParts;
  group.userData.flash = flash;
  group.userData.setHitFlash = setHitFlash;
  botVisuals.add(group);
  return { group, parts, gunParts, hpBar, flash, setHitFlash, updateAnim, playDeath, hasAnim: !!animData };
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

  // 主场景是 MeshBasicMaterial, 点光不会给世界着色; 仍保留随相机的动态光,
  // 供后续换成受光材质时使用, 同时给 VM 场景一份同参数光源。
  worldMuzzleLight = new THREE.PointLight(0xffc060, 0, 320, 2);
  worldMuzzleLight.visible = true;
  scene.add(worldMuzzleLight);
  vmMuzzleLight = new THREE.PointLight(0xffc060, 0, 8, 2);
  vmScene.add(vmMuzzleLight);

  calibrateCamera();
  // 主场景/天空场景共用同一个镜像投影: 世界左右与 VM 一致
  if (mirrorX) {
    installMirror(camera);
    installMirror(skyCamera);
  }
  syncCamera();
  setFov(A.BASE_FOV);
  S.fov = A.BASE_FOV;
  effectArrays();
  buildViewmodel(S.weapon || 'usp');
  S.hooks.switchWeapon = buildViewmodel;
  S.hooks.shoot = shoot;
  S.engine = Object.assign(S.engine || {}, {
    renderer, scene, camera, skyScene, skyCamera, vmScene, vmCamera,
    shoot, rayHit, buildViewmodel, addBulletHole,
    addEntityMesh, removeEntityMesh, makeBotMesh,
    getCamera, getScene, getVM,
    toggleSilencer, toggleGlockMode, cycleSpectate, toggleFreeCam,
    clearEffects, getEffects: () => effectArrays(),
  });
  window.addEventListener('resize', onResize);
  S.hooks.toggleSilencer = toggleSilencer;
  S.hooks.toggleGlockMode = toggleGlockMode;
  S.hooks.cycleSpectate = cycleSpectate;
  S.hooks.toggleFreeCam = toggleFreeCam;
  return renderer;
}

export function updateEngine(dt) {
  if (!renderer) return;
  const d = Number.isFinite(dt) ? Math.max(0, dt) : 0;
  engineTime += d;
  const p = S.player;
  const frozen = !!S.round && S.round.phase === 'freeze';
  const over = !!S.round && S.round.phase === 'over';
  const sp = getSpectate();

  // 鼠标视角。冻结时间允许原地转头, 但禁止移动/开火 (购买菜单仍可用)。
  // 观战时鼠标转向由自由视角的 yaw 承担, 不改动玩家视角。
  //
  // 旧实现是 yaw += mouseDX * sensitivity * 0.02, sensitivity=40 -> 0.8 度/像素。
  // 那意味着横移 450 像素就转完 360 度, 鼠标稍微一动视角就飞掉。
  // 现在 sensitivity 改为"倍率"(默认 2.0), 每像素角度 = 0.06 * 倍率 = 0.12 度,
  // 与 CS 里 sensitivity 2~3 / 400~800 DPI 的手感接近 (约 3000 像素转一圈)。
  const degPerPx = DEG_PER_COUNT * (Number.isFinite(p.sensitivity) ? p.sensitivity : DEFAULT_SENSITIVITY);
  if (!S.buyMenuOpen && p.dead && sp.free) {
    sp.yaw = (Number(sp.yaw) || 0) + (S.mouseDX || 0) * degPerPx;
  } else if (!S.buyMenuOpen && !p.dead) {
    p.yaw += (S.mouseDX || 0) * degPerPx;
    p.pitch = clamp(p.pitch + (S.mouseDY || 0) * degPerPx, -90, 90);
  }
  S.mouseDX = 0;
  S.mouseDY = 0;

  // 冻结时间不调 updatePhysics; 自由观战走独立的相机飞行, 也不动玩家位置。
  if (!frozen && !p.dead && !S.buyMenuOpen) updatePhysics(d);
  else if (p.dead && sp.free) updateFreeCam(d);

  S.shootCd -= d;
  // 换弹进度: 驱动第一人称换弹动作 (0..1)。
  // 用 performance.now() (真实时间), 因为 reloadWeapon 的完成回调走 setTimeout
  // (也是真实时间), 而主循环把 dt clamp 到 0.05。低帧率下两者会脱钩 —— 实测
  // 6fps 时游戏时间只有真实时间的 30%, 枪只沉到 1/3 就弹回去, 动作看着断掉。
  if (S.reloading) {
    const dur = Number.isFinite(S.reloadDuration) && S.reloadDuration > 0 ? S.reloadDuration : 1.6;
    if (!Number.isFinite(S.reloadStartedAt) || S.reloadStartedAt <= 0) S.reloadStartedAt = performance.now();
    S.reloadProgress = Math.min(1, (performance.now() - S.reloadStartedAt) / (dur * 1000));
  } else if (S.reloadProgress) {
    S.reloadProgress = 0;
    S.reloadStartedAt = 0;
  }
  S.crossHeat = Math.max(0, S.crossHeat - d * 6);
  const wp = A.WEAPONS[S.weapon];
  if (S.mouseDown && wp && wp.auto && !frozen && !over && !S.buyMenuOpen && !p.dead) {
    if (!burstQueue && !burstLatch) shoot();
  } else if (!S.mouseDown) {
    burstLatch = false;
  }

  if (S.weapon !== vmWeapon) buildViewmodel(S.weapon);
  const moving = held('w', 'W', 'KeyW', 'arrowup', 'ArrowUp')
    || held('s', 'S', 'KeyS', 'arrowdown', 'ArrowDown')
    || held('a', 'A', 'KeyA', 'arrowleft', 'ArrowLeft')
    || held('d', 'D', 'KeyD', 'arrowright', 'ArrowRight');
  updateVM(d, moving && !S.buyMenuOpen && !p.dead);

  // 开镜 FOV 完全由武器表驱动: AWP/SG550/G3SG1 两级, Scout/AUG/SG552 一级。
  const levels = (wp && Array.isArray(wp.zoomLevels)) ? wp.zoomLevels
    : (ZOOM_FALLBACK[S.weapon] || (wp && wp.zoom ? [40] : []));
  let level = Math.max(0, Math.floor(Number(S.scopeLevel) || 0));
  if (level > levels.length) { level = 0; S.scopeLevel = 0; }
  const fov = level > 0
    ? (Number.isFinite(levels[level - 1]) ? levels[level - 1] : 40)
    : (Number.isFinite(S.baseFov) ? S.baseFov : A.BASE_FOV);
  if (camera.fov !== fov) setFov(fov);
  S.fov = fov;

  updateHoles(d);
  updateEffects(d);
  updateMuzzleLight();
  syncCamera();
  if (S.audio && typeof S.audio.updateListener === 'function' && camera) {
    try {
      S.audio.updateListener(camera.position, forwardVec(p.yaw, p.pitch));
    } catch (_) { /* 音频后端未就绪时忽略 */ }
  }
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
  // 阵亡后不画第一人称枪模: 那时相机已经跟随队友, 再叠一把枪在脸上很怪
  if (!S.player.dead) renderer.render(vmScene, vmCamera);
}

export function getCamera() { return camera; }
export function getScene() { return scene; }
export function getVM() { return vmGroup; }
