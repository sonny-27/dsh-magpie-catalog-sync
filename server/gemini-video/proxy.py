"""Fixed TCP relay allowing only the dedicated browser's configured HTTP proxy."""
import os
import select
import socket
import socketserver


class Forward(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            with socket.create_connection((os.environ.get('PROXY_HOST', 'searxng-clash'), int(os.environ.get('PROXY_PORT', '7896'))), timeout=10) as upstream:
                streams = [self.request, upstream]
                while True:
                    readable, _, _ = select.select(streams, [], [], 120)
                    if not readable:
                        break
                    for source in readable:
                        data = source.recv(65536)
                        if not data:
                            return
                        (upstream if source is self.request else self.request).sendall(data)
        except OSError:
            pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == '__main__':
    Server(('0.0.0.0', 7896), Forward).serve_forever()
