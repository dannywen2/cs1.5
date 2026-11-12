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

export const WEAPONS = {
  knife: { name: '匕首', dmg: 55, interval: 0.45, clip_size: null, reserve: null, recoil: 0.5, spread: 0, price: 0, kill_reward: 1500, melee: true, sfx: 'knife' },
  usp: { name: 'USP', dmg: 24, interval: 0.28, clip_size: 12, reserve: 36, recoil: 1, spread: 0.012, price: 0, kill_reward: 300, melee: false, sfx: 'shot', auto: false },
  ak47: { name: 'AK-47', dmg: 32, interval: 0.10, clip_size: 30, reserve: 90, recoil: 1.6, spread: 0.020, price: 2500, kill_reward: 300, melee: false, sfx: 'shot', auto: true },
  awp: { name: 'AWP', dmg: 115, interval: 1.30, clip_size: 10, reserve: 30, recoil: 3.5, spread: 0.001, price: 4750, kill_reward: 100, melee: false, sfx: 'awp', auto: false, zoom: true },
};

export const VM_SCALE = { usp: 0.10, ak47: 0.058, awp: 0.055, knife: 0.14 };
export const VM_POS = {
  usp: [0.72, 0.02, 1.0],
  ak47: [0.70, -0.22, 1.5],
  awp: [0.68, -0.20, 1.45],
  knife: [0.72, -0.18, 1.0],
};
// 角度 (度), 由 Three.js 侧转成弧度
export const VM_ROT = {
  usp: [0, -15, 15],
  ak47: [-6, -15, 12],
  awp: [-4, -15, 12],
  knife: [0, -15, 12],
};
export const VM_GAIN = 1.55;
export const PLAYER_MODELS = { t: ['leet', 'terror'], ct: ['sas', 'urban'] };
export const BOT_WEAPONS = { t: ['w_ak47', 'w_awp'], ct: ['w_m4a1', 'w_usp'] };

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

export const PLAYER_MODEL_NAMES = ['leet', 'terror', 'sas', 'urban',
  'w_ak47', 'w_awp', 'w_m4a1', 'w_usp', 'w_knife'];
export const VM_NAMES = ['usp', 'ak47', 'awp', 'knife'];
// 根目录 sfx_<key>.wav (见 hlsrc/bake_sound.py 的 MAP)
export const SFX_NAMES = ['shot', 'awp', 'hit', 'head', 'kill', 'reload',
  'hurt', 'empty', 'buy', 'win', 'lose', 'footstep', 'knife', 'explode',
  'flash', 'pin', 'c4_beep', 'c4_plant', 'c4_defuse', 'radio', 'deploy'];

// ---------------------------------------------------------------------------
// 模块内状态: 由 loadAll 一次性装入, 其余导出函数全部同步读取
// ---------------------------------------------------------------------------
const ROOT = '../';
const ASSET = '../assets/';
let navState = null;   // { nx, ny, wx0, wy0, cell, offs, heights }
let colState = null;   // hull1 clipnode 树
let hitState = null;   // hull0 渲染节点树
const MODEL_TEMPLATES = new Map();  // 'player/leet' -> { meta, groups: [typed arrays...] }
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
  if (nx !== W || ny !== H || cell !== CELL || wx0 !== NAV_WX0 || wy0 !== NAV_WY0) {
    console.warn('[asset] dust2.nav 尺寸/原点与导出常量不符, 按文件实际值索引', { nx, ny, wx0, wy0, cell });
  }
  return { nx, ny, wx0, wy0, cell, offs, heights };
}

// dust2.col: <i32 head><i32 cnt> + cnt * <4 f32 平面, i16 c0, i16 c1> (20 B/条)
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
  return { head, cnt, nx, ny, nz, dist, c0, c1 };
}

// dust2.hit: <i32 head><i32 np><i32 nn><i32 nl> | np*<4 f32> | nn*<i32,i16,i16> | nl*i32
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
  return { head, np, nn, nl, planes, plane, c0, c1, leaves };
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
    // VM 的 skip 组是手/前臂: 只推进字节游标, 不生成渲染组
    if (folder === 'vm' && g.skip) {
      p += nv * 32 + nt * 12;             // 3f verts + 2f uv + 3f color = 32 B/顶点
      continue;
    }
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

function layerHeight(cx, cy, li) {
  if (!navState) return 0;
  const [nx] = gridDims();
  return navState.heights[navState.offs[cy * nx + cx] + li] || 0;
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

// hull1: 玩家碰撞。平面仍是 GoldSrc 坐标, three.js 入参按 (x, z, y) 代入
export function hullSolid(x, y, z) {
  if (!colState) return false;
  let num = colState.head;
  for (let i = 0; num >= 0 && i < 256; i++) {
    if (num >= colState.cnt) return false;
    const d = colState.nx[num] * x + colState.ny[num] * z
      + colState.nz[num] * y - colState.dist[num];
    num = d >= 0 ? colState.c0[num] : colState.c1[num];
  }
  return num === -2;
}

// hull0: 子弹/视线点碰撞, 叶内容 -2 即实体
export function hitSolid(x, y, z) {
  if (!hitState) return false;
  let num = hitState.head;
  for (let i = 0; i < 256; i++) {
    if (num < 0) {
      const leaf = -num - 1;
      return leaf >= 0 && leaf < hitState.nl && hitState.leaves[leaf] === -2;
    }
    if (num >= hitState.nn) return false;
    const b = hitState.plane[num] * 4;
    if (b < 0 || b + 3 >= hitState.planes.length) return false;
    const d = hitState.planes[b] * x + hitState.planes[b + 1] * z
      + hitState.planes[b + 2] * y - hitState.planes[b + 3];
    num = d >= 0 ? hitState.c0[num] : hitState.c1[num];
  }
  return false;
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
  if (layers(ox, oy).length) return [ox, oy];
  const key = `${ox},${oy}`;
  const cached = nearCache.get(key);
  if (cached) return cached;
  for (let r = 1; r < 24; r++) {
    let best = null;
    for (let dx = -r; dx <= r; dx++) {
      for (const dy of [-r, r]) {
        const cand = [[ox + dx, oy + dy], [ox + dy, oy + dx]];
        for (const c of cand) {
          if (!layers(c[0], c[1]).length) continue;
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

class MinHeap {
  constructor() { this.a = []; this.seq = 0; }
  get size() { return this.a.length; }
  push(f, value) {
    const item = { f, seq: this.seq++, value };
    const a = this.a;
    let i = a.length;
    a.push(item);
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (MinHeap.cmp(a[par], item) <= 0) break;
      a[i] = a[par];
      i = par;
    }
    a[i] = item;
  }
  pop() {
    const a = this.a;
    if (!a.length) return null;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      let i = 0;
      for (;;) {
        let c = i * 2 + 1;
        if (c >= a.length) break;
        if (c + 1 < a.length && MinHeap.cmp(a[c + 1], a[c]) < 0) c++;
        if (MinHeap.cmp(a[c], last) >= 0) break;
        a[i] = a[c];
        i = c;
      }
      a[i] = last;
    }
    return top;
  }
  static cmp(x, y) { return (x.f - y.f) || (x.seq - y.seq); }
}

const stateKey = s => `${s[0]},${s[1]},${s[2]}`;

function asCell(v) {
  if (Array.isArray(v)) return v.length === 2 ? [Math.floor(v[0]), Math.floor(v[1])] : cellOf(v);
  if (v && typeof v === 'object' && Number.isFinite(v.cx)) return [Math.floor(v.cx), Math.floor(v.cy)];
  return cellOf(v);  // Vec3-like {x,y,z} 或坐标数组
}

// 多层加权 A* (w=1.7): 状态 [cx,cy,layer], 8 邻域, 禁止斜穿墙角
export function findPath(a, b, aLayer = 0, bLayer = 0) {
  let ac = asCell(a), bc = asCell(b);
  if (!layers(ac[0], ac[1]).length) ac = nearestOpen(ac[0], ac[1]);
  if (!layers(bc[0], bc[1]).length) bc = nearestOpen(bc[0], bc[1]);
  const als = layers(ac[0], ac[1]), bls = layers(bc[0], bc[1]);
  if (!als.length || !bls.length) return [];
  const bl = Math.min(bLayer, bls.length - 1);
  const start = [ac[0], ac[1], Math.min(aLayer, als.length - 1)];
  const startKey = stateKey(start);
  const goalKey = stateKey([bc[0], bc[1], bl]);
  const states = new Map([[startKey, start]]);
  const gScore = new Map([[startKey, 0]]);
  const came = new Map();
  const seen = new Set();
  const open = new MinHeap();
  open.push(0, startKey);
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  let it = 0;
  while (open.size && it < 9000) {
    it++;
    const ck = open.pop().value;
    if (seen.has(ck)) continue;
    seen.add(ck);
    if (ck === goalKey) {
      const path = [];
      let k = ck;
      while (k !== undefined) { path.push(states.get(k)); k = came.get(k); }
      path.reverse();
      return path;
    }
    const cur = states.get(ck);
    const cx = cur[0], cy = cur[1], li = cur[2];
    const hc = layerHeight(cx, cy, li);
    const gc = gScore.get(ck);
    for (const [dx, dy] of dirs) {
      const nx = cx + dx, ny = cy + dy;
      const nls = layers(nx, ny);
      if (!nls.length) continue;
      if (dx && dy && (!layers(cx + dx, cy).length || !layers(cx, cy + dy).length)) continue;
      const step = (dx === 0 || dy === 0) ? 1.0 : 1.414;
      for (let lj = 0; lj < nls.length; lj++) {
        const rise = nls[lj] - hc;
        if (rise > 26 || rise < -160) continue;      // 可上台阶, 允许跳落
        const nb = [nx, ny, lj];
        const nk = stateKey(nb);
        const ng = gc + step;
        if (ng >= (gScore.has(nk) ? gScore.get(nk) : Infinity)) continue;
        gScore.set(nk, ng);
        came.set(nk, ck);
        states.set(nk, nb);
        const h = 1.7 * Math.hypot(nx - bc[0], ny - bc[1]);
        open.push(ng + h, nk);
      }
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// 模型: 缓存 typed array 模板, 每次调用新建独立 BufferGeometry
// (避免 Python 里共享 Mesh 节点被后生成的 bot 抢走的问题)
// ---------------------------------------------------------------------------
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
    return { geometry, texture: g.texture, material, tex: g.tex, groupIndex: g.groupIndex };
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

// 出生点: GoldSrc [gsx, gsy(北), gsz(高), yaw] -> three [gsx, gsz, gsy],
// 高度用 surfaceAt(cellOf(...), near=gsz-36) 吸附后 +1。
function deriveSpawns(meta) {
  playerSpawns.length = 0;
  playerYaws.length = 0;
  tSpawns.length = 0;
  tYaws.length = 0;
  const convert = (s, out, yaws) => {
    const gsx = s[0], gsy = s[1], gsz = s[2], yaw = s[3];
    const [cx, cy] = cellOf(gsx, gsy);
    const ls = layers(cx, cy);
    if (ls.length) {
      out.push([gsx, (surfaceAt(cx, cy, gsz - 36) ?? gsz) + 1, gsy]);
    } else {
      const [nx, ny] = nearestOpen(cx, cy);
      const nls = layers(nx, ny);
      const h = (nls.length ? (surfaceAt(nx, ny, gsz - 36) ?? gsz) : gsz) + 1;
      // 孤岛出生点收进最近可站立格 (留出玩家半宽)
      const bx = Math.min(Math.max(gsx, NAV_WX0 + nx * CELL + PLAYER_HALF),
        NAV_WX0 + (nx + 1) * CELL - PLAYER_HALF);
      const bz = Math.min(Math.max(gsy, NAV_WY0 + ny * CELL + PLAYER_HALF),
        NAV_WY0 + (ny + 1) * CELL - PLAYER_HALF);
      out.push([bx, h, bz]);
    }
    yaws.push(yaw);   // 玩家 rotation_y = 90 - yaw
  };
  for (const s of meta.ct_spawns || []) convert(s, playerSpawns, playerYaws);
  for (const s of meta.t_spawns || []) convert(s, tSpawns, tYaws);
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

  job('player models', Promise.all(
    PLAYER_MODEL_NAMES.map(name => loadModelAssets('player', name))));
  job('view models', Promise.all(
    VM_NAMES.map(name => loadModelAssets('vm', name))));

  job('sky', Promise.all(SKY_KEYS.map(async key => [
    key, await loadTexture(`${ASSET}sky/des_${key}.png`, SKY_TEX),
  ])));
  job('sfx', Promise.all(SFX_NAMES.map(async name => [
    name, await fetchBuffer(`${ROOT}sfx_${name}.wav`),
  ])));
  // radar_v2.png 在项目根目录, 不在 assets/
  job('radar', loadTexture(`${ROOT}radar_v2.png`, RADAR_TEX));

  const [meta, geoBuf, navBuf, colBuf, hitBuf, worldTex, , , skyEntries, audioEntries, radarTexture] =
    await Promise.all(jobs);

  navState = navBuf ? parseNav(navBuf) : null;
  colState = colBuf ? parseCol(colBuf) : null;
  hitState = hitBuf ? parseHit(hitBuf) : null;
  nearCache.clear();
  deriveSpawns(meta);

  const worldMeshes = geoBuf ? buildWorldMeshes(geoBuf, meta, worldTex) : [];
  const sky = {};
  for (const [key, tex] of skyEntries) if (tex) sky[key] = tex;
  const audio = {};
  for (const [name, buf] of audioEntries) if (buf) audio[name] = buf;
  const models = {};
  for (const name of PLAYER_MODEL_NAMES) models[name] = loadModel('player', name);
  const vm = {};
  for (const name of VM_NAMES) vm[name] = loadModel('vm', name);

  if (typeof onProgress === 'function') {
    try { onProgress(1, 'done', done, total); } catch (_) { /* 同上 */ }
  }

  return {
    worldMeshes,
    sky,
    skyFaces: SKY_FACES,
    models,
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
