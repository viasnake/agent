import importlib.util
import json
import os
import socket
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path


ROOT = Path(__file__).parents[2]
SPEC = importlib.util.spec_from_file_location(
    "firecracker_helper", ROOT / "scripts/firecracker/helper.py"
)
assert SPEC and SPEC.loader
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)


class HelperContractTests(unittest.TestCase):
    def test_ids_are_strict(self):
        valid = "123e4567-e89b-12d3-a456-426614174000"
        self.assertEqual(helper.validate_id(valid), valid)
        for value in ("/tmp/host", "not-an-id", valid + "x"):
            with self.subTest(value=value):
                with self.assertRaises(helper.HelperError):
                    helper.validate_id(value)

    def test_request_rejects_paths_and_unknown_fields(self):
        with self.assertRaises(helper.HelperError):
            helper.validate_request({"op": "status", "id": "/etc/passwd"})
        with self.assertRaises(helper.HelperError):
            helper.validate_request({"op": "diagnose", "config": "/tmp/user.json"})
        with self.assertRaises(helper.HelperError):
            helper.validate_request(
                {
                    "op": "execute",
                    "id": "123e4567-e89b-12d3-a456-426614174000",
                    "command": {
                        "argv": ["/bin/true"],
                        "timeoutMs": 999999999,
                        "maxOutputBytes": 1,
                    },
                }
            )

    def test_request_limits_and_shapes(self):
        request = helper.validate_request(
            {
                "op": "execute",
                "id": "123e4567-e89b-12d3-a456-426614174000",
                "command": {
                    "argv": ["/bin/printf", "marker"],
                    "timeoutMs": 1000,
                    "maxOutputBytes": 100,
                },
            }
        )
        self.assertEqual(request["command"]["argv"][1], "marker")

    def test_frames_reject_oversized_and_malformed_payloads(self):
        left, right = socket.socketpair()
        try:
            left.sendall((helper.MAX_FRAME_BYTES + 1).to_bytes(4, "big"))
            with self.assertRaises(helper.HelperError):
                helper._frame_recv(right)
            payload = b'{"op":"status","op":"destroy"}'
            left.sendall(len(payload).to_bytes(4, "big") + payload)
            with self.assertRaises(helper.HelperError):
                helper._frame_recv(right)
        finally:
            left.close()
            right.close()

    def test_metadata_is_bound_to_the_sudo_owner(self):
        env_id = "123e4567-e89b-12d3-a456-426614174000"
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            metadata_path = root / "metadata.json"
            config = {
                "state_dir": str(root),
                "jailer_dir": str(root / "jailer"),
                "vmm_uids": [2000],
            }
            metadata_path.write_text(
                json.dumps(
                    {
                        "id": env_id,
                        "owner_uid": 1000,
                        "vmm_uid": 2000,
                        "state": "stopped",
                        "secret": "01" * 32,
                        "disk": str(root / env_id / "disk.ext4"),
                        "jail_root": str(root / "jailer" / "firecracker" / env_id / "root"),
                        "netns": None,
                    }
                ),
                encoding="utf-8",
            )
            original_path = helper._metadata_path
            original_safe_path = helper._safe_path
            helper._metadata_path = lambda _config, _env_id: metadata_path
            helper._safe_path = lambda *_args, **_kwargs: None
            try:
                with patch.dict(os.environ, {"SUDO_UID": "1001"}):
                    with self.assertRaises(helper.HelperError) as caught:
                        helper._read_metadata(config, env_id)
                self.assertEqual(caught.exception.code, "OWNERSHIP")
            finally:
                helper._metadata_path = original_path
                helper._safe_path = original_safe_path

    def test_cleanup_only_targets_the_supplied_cgroup_path(self):
        config = {"cgroup_parent": "test-parent"}
        original = helper._cgroup_path
        helper._cgroup_path = lambda _config, env_id: Path("/nonexistent") / env_id
        try:
            helper._kill_cgroup(config, "123e4567-e89b-12d3-a456-426614174000")
        finally:
            helper._cgroup_path = original


if __name__ == "__main__":
    unittest.main()
