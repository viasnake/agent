"""Exercise the real terminal, SDK and application in a foreground PTY."""
import fcntl
import json
import os
import pty
import re
import select
import signal
import sqlite3
import struct
import subprocess
import sys
import termios
import time
import unicodedata

node, cli, provider, home, scenario = sys.argv[1:]
master, slave = pty.openpty()
original = termios.tcgetattr(slave)
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))

# OpenTUI 按差量重绘：不变的单元格不会重复输出，且全角字符逐格写入。
# 用一个极简终端模型维护"当前画面"，wait_for 才能按当前显示断言。
# 只处理本程序实际发出的序列：绝对定位、擦除、换行、保存/恢复光标。
CSI_RE = re.compile(r"\x1b\[([0-9;?]*)([A-Za-z@`])")
OSC_RE = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")
OTHER_ESC_RE = re.compile(r"\x1b(?:\([^0-9a-zA-Z]?[0-9a-zA-Z]|[=>MN78cDEZ#.]|[PX^_][^\x1b]*\x1b\\)?")

def char_width(ch):
    if unicodedata.combining(ch):
        return 0
    return 2 if unicodedata.east_asian_width(ch) in "WF" else 1

class ScreenModel:
    def __init__(self, cols, rows):
        self.cols, self.rows = cols, rows
        self.grid = [[" "] * cols for _ in range(rows)]
        self.r = self.c = 0
        self.saved = (0, 0)

    def resize(self, cols, rows):
        new = [[" "] * cols for _ in range(rows)]
        for y in range(min(rows, self.rows)):
            for x in range(min(cols, self.cols)):
                new[y][x] = self.grid[y][x]
        self.grid, self.cols, self.rows = new, cols, rows
        self.r = min(self.r, rows - 1)
        self.c = min(self.c, cols - 1)

    def _newline(self):
        self.r += 1
        if self.r >= self.rows:
            self.grid.pop(0)
            self.grid.append([" "] * self.cols)
            self.r = self.rows - 1

    def _put(self, ch):
        w = char_width(ch)
        if w == 0:
            if self.c > 0:
                self.grid[self.r][min(self.cols - 1, self.c - 1)] += ch  # 组合符附加到前一格
            return
        if self.c + w > self.cols:  # 延迟换行：写到最后一列后先标记，下一个字符才换行
            self.c = 0
            self._newline()
        self.grid[self.r][self.c] = ch
        if w == 2 and self.c + 1 < self.cols:
            self.grid[self.r][self.c + 1] = ""
        self.c += w

    def _csi(self, params, final):
        ps = params.lstrip("?")
        parts = [int(p) if p else 0 for p in ps.split(";")] if ps else []
        def p(i, default):
            return parts[i] if i < len(parts) and parts[i] else default
        if final in "Hf":
            self.r = max(0, min(self.rows - 1, p(0, 1) - 1))
            self.c = max(0, min(self.cols - 1, p(1, 1) - 1))
        elif final == "A": self.r = max(0, self.r - p(0, 1))
        elif final == "B": self.r = min(self.rows - 1, self.r + p(0, 1))
        elif final == "C": self.c = min(self.cols - 1, self.c + p(0, 1))
        elif final == "D": self.c = max(0, self.c - p(0, 1))
        elif final == "E": self.r = min(self.rows - 1, self.r + p(0, 1)); self.c = 0
        elif final == "F": self.r = max(0, self.r - p(0, 1)); self.c = 0
        elif final in "G`": self.c = max(0, min(self.cols - 1, p(0, 1) - 1))
        elif final == "d": self.r = max(0, min(self.rows - 1, p(0, 1) - 1))
        elif final == "J":
            mode = p(0, 0)
            if mode >= 2 or params.startswith("?"):
                self.grid = [[" "] * self.cols for _ in range(self.rows)]
            else:
                for x in range(self.c, self.cols): self.grid[self.r][x] = " "
                for y in range(self.r + 1, self.rows): self.grid[y] = [" "] * self.cols
        elif final == "K":
            mode = p(0, 0)
            rng = range(self.c, self.cols) if mode == 0 else range(0, self.c + 1) if mode == 1 else range(self.cols)
            for x in rng: self.grid[self.r][x] = " "
        elif final == "X":
            for x in range(self.c, min(self.cols, self.c + p(0, 1))): self.grid[self.r][x] = " "
        elif final == "L":
            for _ in range(p(0, 1)):
                self.grid.insert(self.r, [" "] * self.cols)
                self.grid.pop()
        elif final == "M":
            for _ in range(p(0, 1)):
                self.grid.pop(self.r)
                self.grid.append([" "] * self.cols)
        elif final == "S":
            for _ in range(p(0, 1)):
                self.grid.pop(0)
                self.grid.append([" "] * self.cols)
        elif final == "T":
            for _ in range(p(0, 1)):
                self.grid.pop()
                self.grid.insert(0, [" "] * self.cols)
        elif final == "s": self.saved = (self.r, self.c)
        elif final == "u": self.r, self.c = self.saved
        elif final in "hl" and "1049" in ps.split(";"):
            self.grid = [[" "] * self.cols for _ in range(self.rows)]
            self.r = self.c = 0

    def feed(self, data):
        s = data.decode("utf-8", "replace")
        i, n = 0, len(s)
        while i < n:
            ch = s[i]
            if ch == "\x1b":
                m = CSI_RE.match(s, i) or OSC_RE.match(s, i)
                if m:
                    if m.re is CSI_RE:
                        self._csi(m.group(1), m.group(2))
                    i = m.end()
                    continue
                m = OTHER_ESC_RE.match(s, i)
                if m:
                    if m.group(0) == "\x1b7": self.saved = (self.r, self.c)
                    elif m.group(0) == "\x1b8": self.r, self.c = self.saved
                    i = m.end()
                    continue
                i += 1
                continue
            if ch == "\r": self.c = 0
            elif ch == "\n" or ch == "\x0b" or ch == "\x0c": self._newline()
            elif ch == "\x08": self.c = max(0, self.c - 1)
            elif ch >= " ": self._put(ch)
            i += 1

    def text(self):
        return "\n".join("".join(row) for row in self.grid)

screen = ScreenModel(80, 24)
fed_len = 0

def screen_text():
    global fed_len
    if fed_len < len(output):
        screen.feed(output[fed_len:])
        fed_len = len(output)
    return screen.text()

def collapse(s):
    return re.sub(r"\s+", "", s)
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

ANSI_PATTERN = re.compile(
    rb"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-_]"
)

def wait_for(text, timeout=10, after=0):
    # 命中条件: mark 之后新输出的字节里出现该文本（去除控制序列后），
    # 或当前终端画面上正显示该文本（忽略空白差异）。
    deadline = time.monotonic()+timeout
    while True:
        plain = ANSI_PATTERN.sub(b"", output[after:])
        if text.encode() in plain or collapse(text) in collapse(screen_text()):
            return
        if proc.poll() is not None:
            raise AssertionError(f"early exit {proc.returncode}: {output[-4000:].decode(errors='replace')}")
        if time.monotonic()>deadline:
            raise AssertionError(f"missing {text}: {output[-4000:].decode(errors='replace')}")
        read_for(.05)

def send(text):
    os.write(master, text.encode())
    read_for(.15)

try:
    wait_for("新しい会話")
    deadline = time.monotonic() + 10
    while True:
        try:
            with sqlite3.connect(f"file:{home}/state.sqlite?mode=ro", uri=True) as db:
                if db.execute("SELECT COUNT(*) FROM conversations").fetchone()[0]:
                    break
        except sqlite3.OperationalError:
            pass
        assert time.monotonic() < deadline, "conversation was not initialized"
        read_for(.05)
    read_for(.15)
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
        send("先頭")
        send("\n")
        send("続き")
        send("\x1b[200~日本語 é\n貼り付け\x1b]52;c;ZXhmaWw=\x07\x1b[201~")
        requests = os.environ["AGENT_TEST_REQUESTS"]
        assert not os.path.exists(requests), "paste submitted before Enter"
        send("\x1bOM")
        send("Shift+Enterの改行")
        assert not os.path.exists(requests), "Shift+Enter submitted the draft"
        send("\r")
        wait_for("PTY 応答")
        wait_for("作業中")
        mark = len(output)
        send("短く答えて\r")
        send("次の質問\x1b\r")
        wait_for("AGENT", after=mark)
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
        mark = len(output)
        send("/quit\r")
        wait_for("作業を中断し", after=mark)
        send("\x1b")
        assert proc.poll() is None, "canceling busy quit ended the process"
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        screen.resize(120, 40)
        proc.send_signal(signal.SIGWINCH)
        send("\x1b[5~")
        send("/history\r")
        send("\x1b")
        wait_for("中断 ·")
        # Ctrl+D inside a draft edits; idle quit saves without another dialog.
        send("保存する下書き")
        send("\x04")
        assert proc.poll() is None
        send("\x03")
        send("\x04")
        proc.wait(timeout=10)
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
        mark = len(output)
        send("日本語の質問\r")
        wait_for("PTY 応答", after=mark)
        wait_for("AGENT", after=mark)
        send("/help\r")
        wait_for("PgUp/PgDn")
        send("\x1b")
        # tmux's legacy Escape disambiguation timer must expire before another key.
        read_for(.8)
        send("/quit\r")
        proc.wait(timeout=10)
    elif scenario == "editor":
        editor = os.path.abspath(os.path.join(os.path.dirname(__file__), "editor.py"))
        send("/editor-config " + json.dumps(["python3", editor]) + "\r")
        wait_for("このエディタをホスト上で起動する設定を保存しますか")
        send("\r")
        wait_for("表示した内容で実行しますか")
        send("\x1b[B\r")
        wait_for("エディタ設定を保存しました")
        mark = len(output)
        send("/editor\r")
        wait_for("editor-return-marker", timeout=5, after=mark)
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
        assert "▎".encode() not in restored_output, "composer remained on main screen"
        assert "作業中".encode() not in restored_output, "workbench controls remained on main screen"
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
