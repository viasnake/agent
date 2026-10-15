import importlib.util
import json
import os
import socket
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).parents[2]


def _load(name: str, relative: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


helper = _load("firecracker_helper", "scripts/firecracker/helper.py")
installer = _load("firecracker_install", "scripts/firecracker/install.py")
runner = _load("guest_runner", "scripts/firecracker/guest_runner.py")

ENV_ID = "123e4567-e89b-12d3-a456-426614174000"
SECRET = "ab" * 32


def installer_config(root: Path) -> dict:
    binaries = root / "lib"
    images = root / "images"
    state = root / "state"
    jailer_dir = root / "jailer"
    for directory in (binaries, images, state, jailer_dir):
        directory.mkdir(parents=True, exist_ok=True)
    firecracker = binaries / "firecracker"
    jailer = binaries / "jailer"
    kernel = images / "vmlinux-6.1.128"
    rootfs = images / "ubuntu-24.04.ext4"
    for path in (firecracker, jailer, kernel, rootfs):
        path.write_bytes(b"fixture")
    return {
        "version": 1,
        "firecracker_version": installer.VERSION,
        "jailer_version": installer.VERSION,
        "firecracker": str(firecracker),
        "jailer": str(jailer),
        "kernel": str(kernel),
        "base_rootfs": str(rootfs),
        "state_dir": str(state),
        "jailer_dir": str(jailer_dir),
        "cgroup_parent": "local-agent-firecracker",
        "vmm_uids": installer.VMM_UIDS,
        "limits": dict(installer.LIMITS),
        "pins": {
            "firecracker": "0" * 64,
            "jailer": "0" * 64,
            "kernel": "0" * 64,
            "base_rootfs": "0" * 64,
        },
    }


class InstallationContractTests(unittest.TestCase):
    def test_installer_configuration_is_accepted_by_the_helper(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config_path = root / "firecracker.json"
            config_path.write_text(json.dumps(installer_config(root)), encoding="utf-8")
            config_path.chmod(0o600)
            with patch.object(helper, "CONFIG_PATH", config_path), patch.object(
                helper, "_safe_path", lambda *_args, **_kwargs: None
            ), patch.object(helper, "_sha256", lambda _path: "0" * 64):
                loaded = helper.load_config()
            self.assertEqual(loaded["firecracker_version"], installer.VERSION)

    def test_helper_path_and_binary_basenames_are_consistent(self):
        source = (ROOT / "src/execution/firecracker.ts").read_text(encoding="utf-8")
        self.assertIn(f'"{installer.HELPER}"', source)
        self.assertEqual(installer.HELPER.name, "local-agent-firecracker")
        self.assertEqual((installer.BIN_ROOT / "firecracker").name, "firecracker")
        self.assertEqual((installer.BIN_ROOT / "jailer").name, "jailer")

    def test_installer_requires_an_explicit_non_root_account(self):
        with self.assertRaises(SystemExit):
            installer.validate_user("root")
        with self.assertRaises(SystemExit):
            installer.validate_user("")

    def test_generated_unit_symlink_resolves_inside_the_guest_tree(self):
        with tempfile.TemporaryDirectory() as temporary:
            tree = Path(temporary) / "rootfs"
            unit_dir = installer._guest_directory(tree, "/etc/systemd/system")
            unit = unit_dir / "local-agent-guest-runner.service"
            unit.write_text("[Unit]\n", encoding="utf-8")
            wants = installer._guest_directory(
                tree, "/etc/systemd/system/multi-user.target.wants"
            )
            link = wants / unit.name
            link.symlink_to(f"../{unit.name}")
            self.assertFalse(os.readlink(link).startswith("/"))
            resolved = installer._resolve_guest_path(
                tree, "/etc/systemd/system/multi-user.target.wants/" + unit.name
            )
            self.assertEqual(resolved.resolve(), unit.resolve())
            self.assertTrue(str(resolved.resolve()).startswith(str(tree.resolve())))

    def test_absolute_guest_symlinks_resolve_within_the_tree(self):
        with tempfile.TemporaryDirectory() as temporary:
            tree = Path(temporary) / "rootfs"
            target = installer._guest_directory(tree, "/usr/bin") / "python3.12"
            target.write_bytes(b"#!/bin/true\n")
            target.chmod(0o755)
            (tree / "usr/bin/python3").symlink_to("/usr/bin/python3.12")
            installer._require_guest_executable(tree, "/usr/bin/python3")


class GuestTransportTests(unittest.TestCase):
    def _serve(self, directory: Path, acknowledgement: bytes = b"OK 1073741824\n", *, close_early: bool = False):
        socket_path = directory / "run" / "vsock.sock"
        socket_path.parent.mkdir(parents=True, exist_ok=True)
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(os.fspath(socket_path))
        listener.listen(1)
        errors: list[BaseException] = []

        def serve() -> None:
            try:
                channel, _ = listener.accept()
            except OSError:
                return
            try:
                request = b""
                while not request.endswith(b"\n"):
                    block = channel.recv(1)
                    if not block:
                        return
                    request += block
                if close_early:
                    channel.close()
                    return
                channel.sendall(acknowledgement)
                runner._session(channel, ENV_ID, bytes.fromhex(SECRET))
            except BaseException as error:  # noqa: BLE001
                errors.append(error)
            finally:
                channel.close()
                socket_path.unlink(missing_ok=True)

        thread = threading.Thread(target=serve, daemon=True)
        thread.start()
        return listener, thread, errors

    def _metadata(self, directory: Path) -> dict:
        return {
            "id": ENV_ID,
            "owner_uid": 1000,
            "vmm_uid": 2000,
            "state": "ready",
            "secret": SECRET,
            "disk": str(directory / "disk.ext4"),
            "jail_root": str(directory),
            "netns": None,
        }

    def test_authenticated_ready_and_exec_pass_through_the_vsock_proxy(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            listener, thread, errors = self._serve(directory)
            try:
                result = helper._authenticated_request(
                    self._metadata(directory), {"op": "ready"}, 10_000
                )
            finally:
                listener.close()
                thread.join(timeout=5)
                (directory / "run" / "vsock.sock").unlink(missing_ok=True)
            self.assertEqual(errors, [])
            self.assertIs(result["ok"], True)
            self.assertEqual(result["id"], ENV_ID)

            listener, thread, errors = self._serve(directory)
            try:
                original_popen = runner.subprocess.Popen

                def popen(argv, **kwargs):
                    kwargs["cwd"] = str(directory)
                    return original_popen(argv, **kwargs)

                with patch.object(runner.subprocess, "Popen", side_effect=popen):
                    executed = helper._authenticated_request(
                        self._metadata(directory),
                        {
                            "op": "exec",
                            "argv": ["/bin/sh", "-c", "exit 3"],
                            "timeout_ms": 10_000,
                            "max_output_bytes": 1024,
                        },
                        20_000,
                    )
            finally:
                listener.close()
                thread.join(timeout=5)
                (directory / "run" / "vsock.sock").unlink(missing_ok=True)
            self.assertEqual(errors, [])
            self.assertEqual(executed["code"], 3)

    def test_invalid_acknowledgement_and_eof_fail_closed(self):
        for acknowledgement, close_early in ((b"OK five\n", False), (b"", True)):
            with self.subTest(acknowledgement=acknowledgement):
                with tempfile.TemporaryDirectory() as temporary:
                    directory = Path(temporary)
                    listener, thread, _errors = self._serve(
                        directory, acknowledgement or b"OK 1\n", close_early=close_early
                    )
                    try:
                        with self.assertRaises(helper.HelperError) as caught:
                            helper._authenticated_request(
                                self._metadata(directory), {"op": "ready"}, 2_000
                            )
                    finally:
                        listener.close()
                        thread.join(timeout=5)
                    self.assertIn(caught.exception.code, {"TRANSPORT", "READINESS", "TIMEOUT"})


class LifecycleDurabilityTests(unittest.TestCase):
    def _environment(self, root: Path) -> tuple[dict, dict]:
        config = installer_config(root)
        env_dir = Path(config["state_dir"]) / ENV_ID
        env_dir.mkdir(parents=True, exist_ok=True)
        disk = env_dir / "disk.ext4"
        disk.write_bytes(b"persistent")
        jail_root = Path(config["jailer_dir"]) / "firecracker" / ENV_ID / "root"
        jail_root.mkdir(parents=True, exist_ok=True)
        metadata = {
            "id": ENV_ID,
            "owner_uid": 1000,
            "vmm_uid": 2000,
            "state": "ready",
            "secret": SECRET,
            "disk": str(disk),
            "jail_root": str(jail_root),
            "netns": None,
        }
        (jail_root / "rootfs.ext4").hardlink_to(disk)
        return config, metadata

    def test_normal_stop_syncs_before_kill_and_never_copies_the_disk(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config, metadata = self._environment(root)
            order: list[str] = []
            helper.CLEANED.clear()
            with patch.object(helper, "_authenticated_request") as request, patch.object(
                helper, "_kill_cgroup"
            ) as kill, patch.object(helper, "_destroy_netns"), patch.object(
                helper.shutil, "copyfile"
            ) as copyfile:
                def sync(_metadata, payload, _timeout):
                    order.append(payload["op"])
                    return {"ok": True, "synced": True}

                request.side_effect = sync
                kill.side_effect = lambda *_args: order.append("kill")
                helper._stop(metadata, config)
            self.assertEqual(order, ["sync", "kill"])
            copyfile.assert_not_called()
            self.assertEqual(metadata["state"], "stopped")
            self.assertEqual(Path(metadata["disk"]).read_bytes(), b"persistent")
            self.assertFalse((Path(metadata["jail_root"]) / "rootfs.ext4").exists())

    def test_failed_sync_reclaims_but_never_reports_a_clean_stop(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config, metadata = self._environment(root)
            helper.CLEANED.clear()
            with patch.object(
                helper, "_authenticated_request", side_effect=OSError("transport lost")
            ), patch.object(helper, "_kill_cgroup") as kill, patch.object(
                helper, "_destroy_netns"
            ):
                with self.assertRaises(helper.HelperError) as caught:
                    helper._stop(metadata, config)
            self.assertEqual(caught.exception.code, "UNKNOWN_RESULT")
            kill.assert_called_once()
            self.assertEqual(metadata["state"], "failed")
            self.assertEqual(Path(metadata["disk"]).read_bytes(), b"persistent")

    def test_cleanup_failure_is_never_reported_as_success(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config, metadata = self._environment(root)
            helper.CLEANED.clear()
            with patch.object(
                helper,
                "_authenticated_request",
                return_value={"ok": True, "synced": True},
            ), patch.object(
                helper,
                "_kill_cgroup",
                side_effect=helper.HelperError("CLEANUP_UNKNOWN", "kill failed"),
            ):
                with self.assertRaises(helper.HelperError) as caught:
                    helper._stop(metadata, config)
            self.assertEqual(caught.exception.code, "CLEANUP_UNKNOWN")
            self.assertEqual(metadata["state"], "failed")
            self.assertTrue((Path(metadata["jail_root"]) / "rootfs.ext4").exists())

    def test_destroy_cleanup_failures_retain_metadata_for_retry(self):
        for failure in ("netns", "jail"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                config, metadata = self._environment(root)
                metadata["netns"] = (
                    f"local-agent-{ENV_ID}" if failure == "netns" else None
                )
                metadata_path = Path(config["state_dir"]) / ENV_ID / "metadata.json"
                metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
                helper.CLEANED.clear()
                original_rmtree = helper.shutil.rmtree

                def rmtree(path, *args, **kwargs):
                    if failure == "jail" and Path(path) == Path(metadata["jail_root"]).parent:
                        raise OSError("jail removal failed")
                    return original_rmtree(path, *args, **kwargs)

                netns = (
                    patch.object(
                        helper,
                        "_destroy_netns",
                        side_effect=helper.HelperError(
                            "NETWORK_NAMESPACE", "namespace removal failed"
                        ),
                    )
                    if failure == "netns"
                    else patch.object(helper, "_destroy_netns")
                )
                with patch.object(
                    helper, "_safe_path", lambda *_args, **_kwargs: None
                ), patch.object(
                    helper, "_sudo_uid", return_value=1000
                ), netns, patch.object(
                    helper.shutil, "rmtree", side_effect=rmtree
                ):
                    with self.assertRaises(helper.HelperError):
                        helper._operate(config, "destroy", ENV_ID)
                self.assertTrue(metadata_path.exists())
                self.assertTrue((Path(config["state_dir"]) / ENV_ID).exists())
                retained = json.loads(metadata_path.read_text(encoding="utf-8"))
                if failure == "netns":
                    self.assertEqual(retained["netns"], f"local-agent-{ENV_ID}")
                else:
                    self.assertTrue(Path(metadata["jail_root"]).exists())

    def test_start_failed_state_reclaims_before_reusing_runtime_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config, metadata = self._environment(root)
            metadata["state"] = "failed"
            metadata_path = Path(config["state_dir"]) / ENV_ID / "metadata.json"
            metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
            helper.CLEANED.clear()
            with patch.object(
                helper, "_safe_path", lambda *_args, **_kwargs: None
            ), patch.object(
                helper, "_sudo_uid", return_value=1000
            ), patch.object(
                helper,
                "_stop",
                side_effect=helper.HelperError("CLEANUP_UNKNOWN", "stale jail remains"),
            ) as stop, patch.object(helper, "_start") as start:
                with self.assertRaises(helper.HelperError):
                    helper._operate(config, "start", ENV_ID)
            stop.assert_called_once_with(metadata, config, failed=True)
            start.assert_not_called()

    def test_timeouts_and_os_errors_stop_a_running_environment(self):
        for failure in (TimeoutError("slow frame"), OSError("socket error")):
            with self.subTest(failure=type(failure).__name__):
                with tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary)
                    config, metadata = self._environment(root)
                    helper.CLEANED.clear()
                    stopped: list[bool] = []
                    with patch.object(
                        helper, "_read_metadata", return_value=metadata
                    ), patch.object(
                        helper, "_authenticated_request", side_effect=failure
                    ), patch.object(
                        helper,
                        "_stop",
                        side_effect=lambda *_args, **kwargs: stopped.append(
                            bool(kwargs.get("failed"))
                        ),
                    ):
                        with self.assertRaises((TimeoutError, OSError)):
                            helper._operate(
                                config,
                                "execute",
                                ENV_ID,
                                {
                                    "argv": ["/bin/true"],
                                    "timeoutMs": 1000,
                                    "maxOutputBytes": 1024,
                                },
                            )
                    self.assertEqual(stopped, [True])


class GuestReadinessTests(unittest.TestCase):
    def test_readiness_never_touches_existing_guest_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            sentinel = workspace / ".local-agent-runner-check"
            sentinel.write_text("user data\n", encoding="utf-8")
            before = set(os.listdir(workspace))
            with patch.object(runner, "Path", lambda value: workspace if value == "/workspace" else Path(value)):
                result = runner._ready(ENV_ID)
            self.assertIs(result["workspace"], True)
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "user data\n")
            self.assertEqual(set(os.listdir(workspace)), before)

    def test_spawn_failures_respect_the_requested_output_cap(self):
        result = runner._execute(
            {
                "op": "exec",
                "argv": ["/nonexistent/" + "x" * 200],
                "timeout_ms": 1000,
                "max_output_bytes": 8,
            }
        )
        self.assertNotEqual(result["code"], 0)
        self.assertLessEqual(len(result["stderr"].encode("utf-8")), 8)
        self.assertIs(result["truncated"], True)

    def test_sync_is_only_served_inside_an_authenticated_session(self):
        left, right = socket.socketpair()
        errors: list[BaseException] = []

        def serve() -> None:
            try:
                runner._session(right, ENV_ID, bytes.fromhex(SECRET))
            except BaseException as error:  # noqa: BLE001
                errors.append(error)
            finally:
                right.close()

        thread = threading.Thread(target=serve, daemon=True)
        thread.start()
        try:
            runner._frame_send(left, {"op": "sync"})
            thread.join(timeout=5)
        finally:
            left.close()
        self.assertTrue(errors and isinstance(errors[0], runner.RunnerError))


if __name__ == "__main__":
    unittest.main()
