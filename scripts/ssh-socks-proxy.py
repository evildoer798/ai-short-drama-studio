from __future__ import annotations

import os
import socket
import struct
import sys
import threading


def receive_exact(connection: socket.socket, size: int) -> bytes:
    chunks: list[bytes] = []
    remaining = size
    while remaining:
        chunk = connection.recv(remaining)
        if not chunk:
            raise ConnectionError("SOCKS proxy closed the connection")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def open_socks_tunnel(proxy_host: str, proxy_port: int, target_host: str, target_port: int) -> socket.socket:
    connection = socket.create_connection((proxy_host, proxy_port), timeout=20)
    connection.sendall(b"\x05\x01\x00")
    if receive_exact(connection, 2) != b"\x05\x00":
        raise ConnectionError("SOCKS proxy rejected unauthenticated access")

    encoded_host = target_host.encode("idna")
    if len(encoded_host) > 255:
        raise ValueError("Target hostname is too long for SOCKS5")
    request = b"\x05\x01\x00\x03" + bytes([len(encoded_host)]) + encoded_host + struct.pack("!H", target_port)
    connection.sendall(request)

    version, reply, _, address_type = receive_exact(connection, 4)
    if version != 5 or reply != 0:
        raise ConnectionError(f"SOCKS proxy connection failed with reply code {reply}")
    if address_type == 1:
        receive_exact(connection, 4)
    elif address_type == 3:
        receive_exact(connection, receive_exact(connection, 1)[0])
    elif address_type == 4:
        receive_exact(connection, 16)
    else:
        raise ConnectionError(f"SOCKS proxy returned unknown address type {address_type}")
    receive_exact(connection, 2)
    connection.settimeout(None)
    return connection


def forward_stdin(connection: socket.socket) -> None:
    try:
        while data := os.read(sys.stdin.fileno(), 65_536):
            connection.sendall(data)
    except (BrokenPipeError, ConnectionError, OSError):
        pass
    finally:
        try:
            connection.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def main() -> int:
    if len(sys.argv) != 5:
        print("usage: ssh-socks-proxy.py <proxy-host> <proxy-port> <target-host> <target-port>", file=sys.stderr)
        return 2

    connection = open_socks_tunnel(sys.argv[1], int(sys.argv[2]), sys.argv[3], int(sys.argv[4]))
    threading.Thread(target=forward_stdin, args=(connection,), daemon=True).start()
    try:
        while data := connection.recv(65_536):
            os.write(sys.stdout.fileno(), data)
    except (BrokenPipeError, ConnectionError, OSError):
        pass
    finally:
        connection.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
