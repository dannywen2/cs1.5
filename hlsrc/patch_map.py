"""把 main.py 的玩具地图层替换成真实 de_dust2 (按行区间打补丁, 从后往前)."""
import io
import os

SRC = os.path.join(os.path.dirname(__file__), "..", "main.py")
SRC = os.path.abspath(SRC)

WORLD = r'''# ============================================================
# 真实 de_dust2 资产 (自原版 BSP/WAD 烘焙, 见 hlsrc/)
#   dust2.geo  按贴图分组的三角网格 + 烘焙 lightmap 顶点色
#   dust2.col  hull1 clipnode 精确碰撞 (32x32x72 玩家盒)
#   dust2.nav  16 单位导航网格, 每格若干可站立高度层
#   dust2.meta 贴图表 / 原版出生点 / 包点 / 包围盒
# 坐标: GoldSrc(x 东, y 北, z 上) -> Ursina(x, z, -y)
# ============================================================
HERE = os.path.dirname(os.path.abspath(__file__))
ASSET = os.path.join(HERE, 'assets')
CELL = 16.0                     # 1 GoldSrc 单位 = 1 Ursina 单位, 导航格 16
WALL_H = 128

# ---- CS 1.6 真实运动参数 (单位: 单位/秒) ----
RUN_SPEED = 250.0
WALK_SPEED = 133.0
CROUCH_SPEED = 130.0
JUMP_SPEED = 268.0              # 起跳初速 -> 约 45 单位高
GRAVITY = 800.0
EYE_HEIGHT = 64.0
PLAYER_HALF = 16.0


def _rd(fn):
    with open(os.path.join(ASSET, fn), 'rb') as f:
        return f.read()


def _load_nav():
    raw = _rd('dust2.nav')
    nx, ny = _st.unpack_from('<ii', raw, 0)
    wx0, wy0 = _st.unpack_from('<ff', raw, 8)
    cell, = _st.unpack_from('<f', raw, 16)
    n, = _st.unpack_from('<I', raw, 20)
    offs = _st.unpack_from('<%dI' % n, raw, 24)
    m, = _st.unpack_from('<I', raw, 24 + n * 4)
    hts = _st.unpack_from('<%dh' % m, raw, 28 + n * 4)
    return nx, ny, wx0, wy0, cell, offs, hts


def _load_col():
    raw = _rd('dust2.col')
    head, cnt = _st.unpack_from('<ii', raw, 0)
    planes = []
    nodes = []
    p = 8
    for _ in range(cnt):
        nx, ny, nz, dist, c0, c1 = _st.unpack_from('<ffffhh', raw, p)
        planes.append((nx, ny, nz, dist))
        nodes.append((len(planes) - 1, c0, c1))
        p += 20
    return head, planes, nodes


NAV_NX, NAV_NY, NAV_WX0, NAV_WY0, _nc, NAV_OFFS, NAV_Z = _load_nav()
COL_HEAD, COL_PLANES, COL_NODES = _load_col()
W, H = NAV_NX, NAV_NY

# 可通行表: 有可站立层即 '.', 否则 '#'
MAP = [''.join('.' if NAV_OFFS[cy * W + cx + 1] > NAV_OFFS[cy * W + cx] else '#'
               for cx in range(W)) for cy in range(H)]


def layers(cx, cy):
    """该格全部可站立高度 (脚底 z, 升序)"""
    if not (0 <= cx < W and 0 <= cy < H):
        return ()
    i = cy * W + cx
    return NAV_Z[NAV_OFFS[i]:NAV_OFFS[i + 1]]


def hull_solid(x, y, z):
    """hull1 点测试: 玩家中心在 (x,y,z) 是否与实体相交 (y 为 Ursina 高度)"""
    gz = y
    gy = -z
    num = COL_HEAD
    i = 0
    while num >= 0:
        if num >= len(COL_NODES) or i > 256:
            return False
        i += 1
        pn, c0, c1 = COL_NODES[num]
        nx, ny, nz, d = COL_PLANES[pn]
        num = c0 if (nx * x + ny * gy + nz * gz - d) >= 0 else c1
    return num == -2


def cell_pos(cx, cy, y=0.0):
    return Vec3(NAV_WX0 + (cx + 0.5) * CELL, y, -(NAV_WY0 + (cy + 0.5) * CELL))


def cell_of(wp):
    return (int((wp.x - NAV_WX0) // CELL), int((-wp.z - NAV_WY0) // CELL))


def surface_at(cx, cy, near=None):
    """该格最合适的站立高度: 优先取不高于 near+40 的最高层"""
    ls = layers(cx, cy)
    if not ls:
        return None
    if near is None:
        return ls[0]
    cand = [z for z in ls if z <= near + 40]
    return max(cand) if cand else ls[0]


spawn_points = []       # T 方出生点
player_spawns = []      # 玩家 / CT 方出生点
'''

GEOM = r'''# ============================================================
# 世界几何: 原版 de_dust2 三角网格 (按贴图分组, 顶点色 = 烘焙 lightmap)
# ============================================================
META = _js.load(open(os.path.join(ASSET, 'dust2.meta.json'), encoding='utf-8'))
TEX = {}
world_entities = []
LIGHT_GAIN = 1.45          # lightmap 平均色偏暗, 统一提亮


def build_world():
    from panda3d.core import Texture as _PT
    raw = _rd('dust2.geo')
    pos = 4
    gi = 0
    while pos < len(raw):
        nv, nt = _st.unpack_from('<ii', raw, pos)
        pos += 8
        verts = _st.unpack_from('<%df' % (nv * 3), raw, pos)
        pos += nv * 12
        uvs = _st.unpack_from('<%df' % (nv * 2), raw, pos)
        pos += nv * 8
        cols = _st.unpack_from('<%df' % (nv * 3), raw, pos)
        pos += nv * 12
        tris = _st.unpack_from('<%dI' % (nt * 3), raw, pos)
        pos += nt * 12
        g = META['groups'][gi]
        gi += 1
        tex = load_texture(g['tex'], folder=Path(ASSET, 'tex'))
        try:
            tex._texture.setWrapU(_PT.WM_repeat)
            tex._texture.setWrapV(_PT.WM_repeat)
        except Exception:
            pass
        v3 = []
        for i in range(0, len(verts), 3):
            v3.append(Vec3(verts[i], verts[i + 2], -verts[i + 1]))
        uv2 = []
        for i in range(0, len(uvs), 2):
            uv2.append(uvs[i])
            uv2.append(-uvs[i + 1])
        c4 = []
        for i in range(0, len(cols), 3):
            c4.append(Vec4(min(1.0, cols[i] * LIGHT_GAIN),
                           min(1.0, cols[i + 1] * LIGHT_GAIN),
                           min(1.0, cols[i + 2] * LIGHT_GAIN), 1))
        m = Mesh(vertices=v3, triangles=list(tris), uvs=uv2, colors=c4,
                 mode='triangle', static=True)
        world_entities.append(Entity(model=m, texture=tex, double_sided=False,
                                     unlit=True, shader=unlit_shader))


build_world()


# ---- 出生点: 用原版 info_player_start / info_player_deathmatch ----
def _spawn_at(x, y, yaw, eye=0.0):
    cx, cy = cell_of(Vec3(x, 0, -y))
    z = surface_at(cx, cy, None)
    if z is None:
        z = 0
    return Vec3(x, z + 1.0, -y), yaw


for _s in META['ct_spawns']:
    _p, _yaw = _spawn_at(_s[0], _s[1], _s[3])
    player_spawns.append(_p)
for _s in META['t_spawns']:
    _p, _yaw = _spawn_at(_s[0], _s[1], _s[3])
    spawn_points.append(_p)

# ---- 包点: func_bomb_target 的 brush 中心 ----
_site_cells = {}
for _k, _v in META['sites'].items():
    _c = _v['center']
    _site_cells[_k] = cell_of(Vec3(_c[0], 0, -_c[1]))
if 'tgt_a' in _site_cells:
    SITE_A = _site_cells['tgt_a']
if 'tgt_b' in _site_cells:
    SITE_B = _site_cells['tgt_b']
SITE_A_POS = cell_pos(*SITE_A, y=surface_at(*SITE_A) or 0)
SITE_B_POS = cell_pos(*SITE_B, y=surface_at(*SITE_B) or 0)

# 包点地面标记 (dust2 黄色下包圈)
for _sp, _col in ((SITE_A_POS, C(255, 210, 60)), (SITE_B_POS, C(255, 210, 60))):
    _ring = Entity(model=Circle(24, mode='line'), rotation_x=90,
                   scale=7.2, color=_col, position=_sp + Vec3(0, 0.6, 0),
                   unlit=True, shader=unlit_shader)

# ---- 兼容旧逻辑的空容器 (真实地图不需要人工阻挡) ----
PIT_CELLS = set()
WINDOW_CELLS = set()
EXTRA_BLOCKED = set()
CAT_LAYER_Y = {}
CAT_ENTRIES = set()
CAT_TOP_CELLS = []
CAT_POSTS = []
'''

NAV = r'''# ============================================================
# 导航: 真实 dust2 网格上的多层 A*
# ============================================================
OPEN_CELLS = [(x, y) for y in range(H) for x in range(W) if MAP[y][x] == '.']
ROAM_CELLS = OPEN_CELLS


def bot_surface_y(wp, layer=0):
    """bot 脚底高度: 取该格第 layer 层"""
    cx, cy = cell_of(wp)
    ls = layers(cx, cy)
    if not ls:
        return 0.0
    return float(ls[min(layer, len(ls) - 1)])


def cell_blocked_at(wp, extra=True):
    return not layers(*cell_of(wp))


def grid_clear(a, b, step=6.0, extra=True):
    """网格直线检测: 用可通行表代替 raycast, 每 6 单位采样一次"""
    dx, dz = b.x - a.x, b.z - a.z
    n = max(1, int(math.hypot(dx, dz) / step))
    for i in range(1, n):
        cx = int((a.x + dx * i / n - NAV_WX0) // CELL)
        cy = int((-(a.z + dz * i / n) - NAV_WY0) // CELL)
        if not (0 <= cx < W and 0 <= cy < H) or MAP[cy][cx] != '.':
            return False
    return True


def nearest_open(cell):
    if layers(*cell):
        return cell
    for r in range(1, 24):
        best = None
        for dx in range(-r, r + 1):
            for dy in (-r, r):
                for c in ((cell[0] + dx, cell[1] + dy), (cell[0] + dy, cell[1] + dx)):
                    if layers(*c):
                        d = (c[0] - cell[0]) ** 2 + (c[1] - cell[1]) ** 2
                        if best is None or d < best[0]:
                            best = (d, c)
        if best:
            return best[1]
    return cell


def find_path(a, b, a_layer=0, b_layer=0):
    """多层 A*: 状态 (cx, cy, layer); 相邻格高度差 <= 26 可走"""
    import heapq
    ac, bc = cell_of(a), cell_of(b)
    if not layers(*ac):
        ac = nearest_open(ac)
    if not layers(*bc):
        bc = nearest_open(bc)
    als, bls = layers(*ac), layers(*bc)
    if not als or not bls:
        return []
    start = (ac[0], ac[1], 0)
    goals = {(bc[0], bc[1], i) for i in range(len(bls))}
    openq = [(0.0, start)]
    gsc = {start: 0.0}
    came = {}
    seen = set()
    it = 0
    while openq and it < 60000:
        it += 1
        _f, cur = heapq.heappop(openq)
        if cur in seen:
            continue
        seen.add(cur)
        if cur in goals:
            path = [cur]
            while cur in came:
                cur = came[cur]
                path.append(cur)
            path.reverse()
            return [cell_pos(c[0], c[1], NAV_Z[NAV_OFFS[c[1] * W + c[0]] + c[2]])
                    for c in path]
        cx, cy, li = cur
        hc = NAV_Z[NAV_OFFS[cy * W + cx] + li]
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1),
                       (1, 1), (1, -1), (-1, 1), (-1, -1)):
            nb2 = cx + dx, cy + dy
            nls = layers(*nb2)
            if not nls:
                continue
            step = 1.0 if dx == 0 or dy == 0 else 1.414
            for lj, hz in enumerate(nls):
                if abs(hz - hc) > 26:
                    continue
                nb = (nb2[0], nb2[1], lj)
                ng = gsc[cur] + step
                if ng < gsc.get(nb, 1e18):
                    gsc[nb] = ng
                    came[nb] = cur
                    heapq.heappush(openq,
                                   (ng + math.hypot(nb2[0] - bc[0], nb2[1] - bc[1]), nb))
    return []
'''

OUT = {"world": WORLD, "geom": GEOM, "nav": NAV}


def main():
    with io.open(SRC, encoding="utf-8") as f:
        lines = f.readlines()

    def repl(a, b, key):
        new = OUT[key].splitlines(True)
        lines[a - 1:b] = new

    # 从后往前: 玩家 -> 导航 -> 几何 -> 常量 (行号已含 +3 的 import 偏移)
    repl(552, 920, "nav")
    repl(419, 550, "geom")
    repl(175, 221, "world")
    with io.open(SRC, "w", encoding="utf-8") as f:
        f.writelines(lines)
    print("patched", SRC, "lines now", len(lines))


if __name__ == "__main__":
    main()
