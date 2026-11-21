"""Relay a dedicated worker's stdio to a controlling terminal."""

import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def resize(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def relay(master, shell):
    os.set_blocking(1, True)
    os.set_blocking(master, False)
    source = bytearray()
    pending = b""
    output = sys.stdout.buffer
    output.write(b"\0")
    output.flush()
    while True:
        while not pending and len(source) >= 4:
            (size,) = struct.unpack_from("!I", source)
            if size > 65536:
                raise ValueError("Terminal frame too large")
            end = 4 + (size or 4)
            if len(source) < end:
                break
            if size:
                pending = bytes(source[4:end])
            else:
                cols, rows = struct.unpack_from("!HH", source, 4)
                if not (2 <= cols <= 512 and 1 <= rows <= 256):
                    raise ValueError("Invalid terminal size")
                resize(master, cols, rows)
            del source[:end]

        readers, writers, _ = select.select(
            [master, shell] if pending else [0, master, shell],
            [master] if pending else [],
            [],
        )
        if master in readers:
            try:
                data = os.read(master, 16384)
            except OSError as error:
                if error.errno == errno.EIO:
                    return
                raise
            if not data:
                return
            output.write(data)
            output.flush()
        if shell in readers:
            return
        if master in writers:
            pending = pending[os.write(master, pending):]
        if 0 in readers:
            data = os.read(0, 16384)
            if not data:
                return
            source.extend(data)


def main():
    os.umask(0o077)
    shell, master = pty.fork()
    if shell == 0:
        os.execv("/bin/bash", ["bash", "--noprofile", "--norc", "-i"])
    pidfd = os.pidfd_open(shell)
    try:
        resize(master, 80, 24)
        relay(master, pidfd)
    finally:
        os.close(pidfd)
        os.close(master)
        # On disconnect the worker's cgroup also drains detached descendants.
        try:
            os.kill(shell, signal.SIGHUP)
        except ProcessLookupError:
            pass
        os.waitpid(shell, 0)


if __name__ == "__main__":
    main()
