"""Exercise the real terminal, SDK and application in a foreground PTY."""
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time

node, cli, provider, home, scenario = sys.argv[1:]
master, slave = pty.openpty()
original = termios.tcgetattr(slave)
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
started = time.monotonic()
socket = os.path.join(home, "test-tmux.sock")
command = [node, "--import", provider, cli, "--home", home]
if scenario == "tmux":
    command = ["tmux", "-S", socket, "-f", "/dev/null", "new-session", "-s", "agent-test", "--", *command]
proc = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
output = bytearray()

def read_for(seconds):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        if select.select([master], [], [], min(.05, max(0, until-time.monotonic())))[0]:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                return
            if not chunk:
                return
            output.extend(chunk)
            if len(output) > 5_000_000:
                raise AssertionError("unbounded terminal output")

def wait_for(text, timeout=10, after=0):
    deadline = time.monotonic()+timeout
    while text.encode() not in output[after:]:
        if proc.poll() is not None:
            raise AssertionError(f"early exit {proc.returncode}: {output[-4000:].decode(errors='replace')}")
        if time.monotonic()>deadline:
            raise AssertionError(f"missing {text}: {output[-4000:].decode(errors='replace')}")
        read_for(.05)

def send(text):
    os.write(master, text.encode())
    read_for(.15)

try:
    wait_for("接続設定あり")
    ready_ms = (time.monotonic()-started)*1000
    rss = None
    conversation_rss = None
    try:
        target_pid = proc.pid
        if scenario == "tmux":
            target_pid = int(subprocess.check_output(["tmux", "-S", socket, "display-message", "-p", "#{pane_pid}"]))
        with open(f"/proc/{target_pid}/status") as status:
            rss = int(next(line for line in status if line.startswith("VmRSS:")).split()[1])
    except (FileNotFoundError, StopIteration):
        pass
    if scenario == "conversation":
        # Search by the Japanese label, cancel a nested picker, retain the draft.
        send("下書きを保持")
        send("\x10")
        wait_for("操作を検索")
        send("モデル\r")
        wait_for("モデルを選択")
        mark = len(output)
        send("\x1b")
        wait_for("下書きを保持", after=mark)
        send("\x15")
        send("/help\r")
        wait_for("PgUp/PgDn")
        send("\x1b[6~")
        send("\x1b")
        # Bracketed paste must not submit embedded newlines or send terminal controls.
        send("\x1b[200~日本語 é\n貼り付け\x1b]52;c;ZXhmaWw=\x07\x1b[201~")
        requests = os.environ["AGENT_TEST_REQUESTS"]
        assert not os.path.exists(requests), "paste submitted before Enter"
        send("\r")
        wait_for("PTY 応答")
        wait_for("作業への追加指示")
        send("短く答えて\r")
        send("次の質問\x1b\r")
        wait_for("完了 · 続き", after=0)
        read_for(3)
        with open(requests) as trace:
            records = [json.loads(line) for line in trace]
        assert len(records) == 3, records
        assert "日本語" in records[0]["text"] and "貼り付け" in records[0]["text"]
        assert "短く答えて" in records[1]["text"]
        assert "次の質問" in records[2]["text"]
        with open(f"/proc/{proc.pid}/status") as status:
            conversation_rss = int(next(line for line in status if line.startswith("VmRSS:")).split()[1])
        # Resize while a long stream is active; history remains usable and Esc stops it.
        send("long-output\r")
        wait_for("全角")
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        proc.send_signal(signal.SIGWINCH)
        send("\x1b[5~")
        send("/history\r")
        wait_for("PgUp/PgDn")
        send("\x1b")
        send("\x1b")
        wait_for("中断 ·")
        # Ctrl+D inside a draft must edit, not exit. A quit cancellation retains input.
        send("保存する下書き")
        send("\x04")
        assert proc.poll() is None
        send("\x03")
        send("\x04")
        wait_for("保存して終了")
        send("\x1b")
        assert proc.poll() is None
    elif scenario == "coding":
        for request in ["fix-code-first", "fix-code-second"]:
            mark = len(output)
            send(request + "\r")
            wait_for("検査 / unit", after=mark)
            check_mark = output.find("検査 / unit".encode(), mark)
            wait_for("検査完了", after=check_mark)
        with open("app.txt") as source:
            assert source.read() == "baseline"
        mark = len(output)
        send("/tasks\r")
        wait_for("保存済み検査", after=mark)
        wait_for("合格 / unit", after=mark)
        send("\x1b")
        send("/diff\r")
        wait_for("-baseline")
        wait_for("+second")
        send("\x1b")
        mark = len(output)
        send("/apply\r")
        wait_for("適用へ進む", after=mark)
        send("\x1b")
        assert "検証済み変更".encode() not in output[mark:], "Esc opened approval"
        with open("app.txt") as source:
            assert source.read() == "baseline"
        # Enter advances from the diff. Approval still defaults to cancellation.
        send("/diff\r")
        send("\r")
        wait_for("検証済み変更")
        send("\r")
        with open("app.txt") as source:
            assert source.read() == "baseline"
        mark = len(output)
        send("/diff\r")
        wait_for("適用へ進む", after=mark)
        send("\r")
        wait_for("検証済み変更", after=mark)
        send("\x1b[B\r")
        wait_for("適用完了")
        with open("app.txt") as source:
            assert source.read() == "second"
        mark = len(output)
        send("fix-code-third\r")
        wait_for("検査完了", after=mark)
        send("/diff\r")
        wait_for("-second")
        wait_for("+third")
        send("\x1b")
    elif scenario == "tmux":
        send("日本語の質問\r")
        wait_for("完了 · 続き")
        send("/help\r")
        wait_for("PgUp/PgDn")
        send("\x1b")
        # tmux's legacy Escape disambiguation timer must expire before another key.
        read_for(.8)
        send("/quit\r")
        wait_for("保存して終了")
        send("\x1b[B\r")
        proc.wait(timeout=10)
    elif scenario == "exception":
        # An explicitly injected process exception checks the shared restoration path.
        proc.send_signal(signal.SIGUSR2)
        proc.wait(timeout=10)
    proc.send_signal(signal.SIGTERM) if proc.poll() is None else None
    proc.wait(timeout=10)
    read_for(.2)
    restored = termios.tcgetattr(slave)
    assert restored[3] & termios.ICANON, "raw mode leaked"
    assert restored[3] & termios.ECHO, "echo remained disabled"
    assert b"\x1b[?2004l" in output, "bracketed paste not restored"
    assert b"\x1b[?25h" in output, "cursor not restored"
    assert b"\x1b[?1049h" in output, "fullscreen was not entered"
    assert b"\x1b[?1049l" in output, "main screen was not restored"
    if scenario != "tmux":
        restored_output = output.rsplit(b"\x1b[?1049l", 1)[1]
        assert "依頼を書く".encode() not in restored_output, "composer remained on main screen"
        assert b"Ctrl+P" not in restored_output, "workbench controls remained on main screen"
    assert b"\x1b]52;c;ZXhmaWw=" not in output, "untrusted clipboard escape reached terminal"
    assert proc.returncode == (1 if scenario == "exception" else 0), proc.returncode
    print(json.dumps({"readyMs":ready_ms,"idleRssKiB":rss,"conversationRssKiB":conversation_rss,"bytes":len(output),"scenario":scenario,"restored":True}))
finally:
    if proc.poll() is None:
        proc.kill()
        proc.wait()
    if scenario == "tmux":
        subprocess.run(["tmux", "-S", socket, "kill-server"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os.close(master)
    os.close(slave)
