#!/usr/bin/env python3
"""CS 1.5 three.js 版静态服务器 (无需 npm / 构建工具).

用法:
    python serve.py            # 默认 http://127.0.0.1:8080/web/
    python serve.py 9000       # 指定端口

以项目根目录为文档根, 这样 /web/*.js 里的 ../assets/、../sfx_*.wav
与 ../radar_v2.png 都能正确解析。二进制资产不使用 gzip/缓存, 方便调试。
"""
import http.server
import os
import socketserver
import sys
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))


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

    def end_headers(self):
        # 开发期禁用缓存, 改完 JS 刷新即生效
        self.send_header('Cache-Control', 'no-store, max-age=0')
        super().end_headers()

    def log_message(self, fmt, *args):
        if os.environ.get('QUIET'):
            return
        super().log_message(fmt, *args)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


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
