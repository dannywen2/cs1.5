#!/usr/bin/env python3
"""CS 1.5 three.js 版静态服务器 (无需 npm / 构建工具).

用法:
    python serve.py            # 默认 http://127.0.0.1:8080/web/
    python serve.py 9000       # 指定端口

以项目根目录为文档根, 这样 /web/*.js 里的 ../assets/、../sfx_*.wav
与 ../radar_v2.png 都能正确解析。二进制资产不使用 gzip/缓存, 方便调试。

安全: 只放行游戏真正需要的路径 (白名单)。SimpleHTTPRequestHandler 会把
文档根下的一切都暴露出去 —— 包括 .git/ 目录、hlsrc/ 烘焙脚本、_tools/
里的第三方二进制 —— 一旦有人把 host 改成 0.0.0.0 就是源码与凭据外泄。
"""
import http.server
import os
import posixpath
import re
import socketserver
import sys
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))

# 允许对外提供的路径 (相对 URL, 已规范化)。其余一律 404。
ALLOW_FILES = {
    'web/index.html',
    'web/style.css',
    'web/main.js',
    'web/state.js',
    'web/asset.js',
    'web/engine.js',
    'web/game.js',
    'web/package.json',
    'web/README.md',
    'radar_v2.png',
}
ALLOW_PREFIXES = (
    'web/vendor/',      # three.js
    'assets/tex/',      # 世界贴图
    'assets/sky/',      # 天空盒六面
    'assets/player/',   # 人物/武器模型 + 贴图
    'assets/vm/',       # 第一人称枪模
)
ALLOW_EXACT_ASSETS = {
    'assets/dust2.geo',
    'assets/dust2.nav',
    'assets/dust2.col',
    'assets/dust2.hit',
    'assets/dust2.meta.json',
}
SFX_RE = re.compile(r'^sfx_[a-z0-9_]+\.wav$')
# 只允许这些扩展名, 防止白名单前缀下混入意外文件
ALLOW_EXT = {'.html', '.css', '.js', '.mjs', '.json', '.png', '.wav',
             '.geo', '.col', '.hit', '.nav'}


def is_allowed(url_path: str) -> bool:
    """把 URL 规范化后判断是否命中白名单。"""
    p = posixpath.normpath(url_path.lstrip('/'))
    if p in ('.', ''):
        return False                       # 不提供目录列表
    if '..' in p.split('/'):
        return False
    # 入口: /web/ 与 /web 等价于 /web/index.html (README 里写的就是这个地址)
    if p in ('web', 'web/index.html'):
        return True
    if p in ALLOW_FILES or p in ALLOW_EXACT_ASSETS:
        return True
    if SFX_RE.match(p):
        return True
    if any(p.startswith(pre) for pre in ALLOW_PREFIXES):
        return os.path.splitext(p)[1].lower() in ALLOW_EXT
    return False


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript; charset=utf-8',
        '.mjs': 'text/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.wasm': 'application/wasm',
        '.geo': 'application/octet-stream',
        '.col': 'application/octet-stream',
        '.hit': 'application/octet-stream',
        '.nav': 'application/octet-stream',
        '.wav': 'audio/wav',
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):
        if not self._allowed():
            return self.send_error(404, 'Not Found')
        return super().do_GET()

    def do_HEAD(self):
        if not self._allowed():
            return self.send_error(404, 'Not Found')
        return super().do_HEAD()

    def _allowed(self):
        # self.path 含 query, 只取路径部分
        raw = self.path.split('?', 1)[0].split('#', 1)[0]
        # 未转义的路径也先解码, 防止 %2e%2e 绕过
        from urllib.parse import unquote
        return is_allowed(unquote(raw))

    def list_directory(self, path):
        # 目录一律 404, 不暴露文件清单
        self.send_error(404, 'Not Found')
        return None

    def end_headers(self):
        # 开发期禁用缓存, 改完 JS 刷新即生效
        self.send_header('Cache-Control', 'no-store, max-age=0')
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()

    def log_message(self, fmt, *args):
        if os.environ.get('QUIET'):
            return
        super().log_message(fmt, *args)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    # socketserver.TCPServer 默认 listen backlog 只有 5。游戏启动时会并行拉取
    # 100+ 个资产文件 (贴图/模型/音效), 连接瞬间打满 backlog, 多出来的连接被
    # 内核直接 RST -> 浏览器/脚本侧看到 "Failed to fetch" / ECONNREFUSED。
    # 实测 backlog=5 时 40 并发里有 33 个失败; 调到 128 后全部成功。
    request_queue_size = 128


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    url = f'http://127.0.0.1:{port}/web/'
    with Server(('127.0.0.1', port), Handler) as httpd:
        print(f'CS 1.5 (three.js)  ->  {url}')
        print('Ctrl+C 退出')
        if not os.environ.get('NOBROWSER'):
            webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\nbye')


if __name__ == '__main__':
    main()
