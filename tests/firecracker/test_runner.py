import importlib.util
import socket
import struct
import threading
import unittest
from pathlib import Path


ROOT = Path(__file__).parents[2]
SPEC = importlib.util.spec_from_file_location(
    "guest_runner", ROOT / "scripts/firecracker/guest_runner.py"
)
assert SPEC and SPEC.loader
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


def send_frame(channel, value):
    import json

    encoded = json.dumps(value, separators=(",", ":"), sort_keys=True).encode()
    channel.sendall(struct.pack("!I", len(encoded)) + encoded)


def receive_frame(channel):
    import json

    size = struct.unpack("!I", channel.recv(4))[0]
    return json.loads(channel.recv(size))


class GuestRunnerTests(unittest.TestCase):
    def test_frame_sizes_and_json_are_strict(self):
        left, right = socket.socketpair()
        try:
            left.sendall(struct.pack("!I", runner.MAX_FRAME_BYTES + 1))
            with self.assertRaises(runner.RunnerError):
                runner._frame_recv(right)
            duplicate = b'{"op":"ready","op":"exec"}'
            left.sendall(struct.pack("!I", len(duplicate)) + duplicate)
            with self.assertRaises(runner.RunnerError):
                runner._frame_recv(right)
        finally:
            left.close()
            right.close()

    def test_host_identity_and_proof_are_authenticated(self):
        env_id = "123e4567-e89b-12d3-a456-426614174000"
        left, right = socket.socketpair()
        errors = []

        def serve():
            try:
                runner._session(right, env_id, bytes.fromhex("01" * 32))
            except Exception as error:
                errors.append(error)
            finally:
                right.close()

        thread = threading.Thread(target=serve)
        thread.start()
        try:
            send_frame(
                left,
                {"type": "hello", "version": 1, "id": env_id, "nonce": "11" * 32},
            )
            receive_frame(left)
            send_frame(left, {"type": "proof", "mac": "00" * 32})
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive())
            self.assertIsInstance(errors[0], runner.RunnerError)
        finally:
            left.close()
            thread.join(timeout=2)

    def test_guest_command_schema_rejects_out_of_bounds_values(self):
        with self.assertRaises(runner.RunnerError):
            runner._execute(
                {
                    "op": "exec",
                    "argv": ["/bin/true"],
                    "timeout_ms": 600001,
                    "max_output_bytes": 10,
                }
            )

    def test_output_decoding_respects_the_byte_limit(self):
        decoded, limited = runner._decode_limited(b"\xff" * 20, 7)
        self.assertTrue(limited)
        self.assertLessEqual(len(decoded.encode("utf-8")), 7)


if __name__ == "__main__":
    unittest.main()
