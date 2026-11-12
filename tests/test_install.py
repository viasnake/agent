"""Filesystem fixtures never install users, mount storage or modify host policy."""

import argparse
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

INSTALL = Path(__file__).resolve().parents[1] / "install"
sys.path.insert(0, str(INSTALL))
import system

spec = importlib.util.spec_from_file_location("installer", INSTALL / "install.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)

MOUNT = {"target": "/", "uuid": "ordinary-root-uuid", "fstype": "ext4", "fsroot": "/"}


def user(name, uid, gid, home="/nonexistent"):
    return SimpleNamespace(
        pw_name=name, pw_uid=uid, pw_gid=gid, pw_shell="/usr/sbin/nologin", pw_dir=home
    )


class SystemChecks(unittest.TestCase):
    def test_network_update_migrates_only_the_old_stock_policy(self):
        with tempfile.TemporaryDirectory() as temporary:
            etc = Path(temporary)
            template = (INSTALL / "egress.nft").read_text()
            old = template.replace("tcp dport { 22, 80, 443 }", "tcp dport { 80, 443 }")
            policy = etc / "egress.nft"
            protected = etc / "protected-cidrs.nft"
            protected.write_text("custom protected networks")
            with patch.object(installer, "ETC", etc), patch.object(installer, "trusted"):
                policy.write_text(old)
                installer.install_network_policy(INSTALL)
                self.assertEqual(policy.read_text(), template)
                policy.write_text(old + "# administrator policy\n")
                installer.install_network_policy(INSTALL)
                self.assertEqual(policy.read_text(), old + "# administrator policy\n")
                self.assertEqual(protected.read_text(), "custom protected networks")

    def test_mount_accepts_root_or_dedicated_storage_without_disk_labels(self):
        for target in ["/", "/mnt/persistent"]:
            mount = {**MOUNT, "target": target}
            with patch.object(
                system, "run", return_value=json.dumps({"filesystems": [mount]})
            ):
                self.assertEqual(system.storage("/mnt/persistent/agent"), mount)
        for mount in [{**MOUNT, "uuid": None}, {**MOUNT, "fstype": "tmpfs"}]:
            with patch.object(
                system, "run", return_value=json.dumps({"filesystems": [mount]})
            ):
                with self.assertRaisesRegex(RuntimeError, "persistent"):
                    system.storage("/srv/agent-data")

    def test_missing_or_replaced_mount_stops_before_touching_data(self):
        record = {"dataRoot": "/srv/agent-data", "storage": MOUNT}
        for field, value in [
            ("uuid", "different"),
            ("target", "/srv/agent-data"),
            ("fsroot", "/other"),
        ]:
            with (
                patch.object(system, "trusted"),
                patch.object(system, "storage", return_value={**MOUNT, field: value}),
                patch.object(system, "private_directory") as data,
            ):
                with self.assertRaisesRegex(RuntimeError, "refusing fallback"):
                    system.check(record)
                data.assert_not_called()

    def test_recorded_ids_are_checked_without_fixed_uid_values(self):
        control, work = (
            user("agent-control", 1234, 2234),
            user("agent-work", 1235, 2235),
        )
        record = {
            "dataRoot": "/srv/agent-data",
            "storage": MOUNT,
            "controlUid": 1234,
            "controlGid": 2234,
            "workUid": 1235,
            "workGid": 2235,
        }
        with (
            patch.object(system, "trusted"),
            patch.object(system, "storage", return_value=MOUNT),
            patch.object(
                system,
                "account",
                side_effect=lambda name: control if name == "agent-control" else work,
            ),
            patch.object(system, "private_directory"),
            patch.object(system, "skills_directory"),
            patch.object(os, "geteuid", return_value=0),
        ):
            self.assertEqual(system.check(record), record)
            for key in ["controlUid", "workUid", "controlGid", "workGid"]:
                with self.assertRaisesRegex(RuntimeError, "identities|groups"):
                    system.check({**record, key: 5678})

    def test_skills_root_is_control_owned_and_unsafe_permissions_are_not_repaired(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "skills"
            uid, gid = os.getuid(), os.getgid()
            with patch.object(system, "trusted"), patch.object(os, "chown") as chown:
                system.skills_directory(path, uid, create=True, gid=gid)
                self.assertEqual(path.stat().st_mode & 0o777, 0o755)
                chown.assert_called_once_with(path, uid, gid)
                chown.reset_mock()
                skill = path / "SKILL.md"
                skill.write_bytes(b"unchanged administrator content")
                system.skills_directory(path, uid, create=True, gid=gid)
                chown.assert_not_called()
                for mode in [0o700, 0o777]:
                    path.chmod(mode)
                    with self.assertRaisesRegex(RuntimeError, "readable"):
                        system.skills_directory(path, uid, create=True, gid=gid)
                    self.assertEqual(path.stat().st_mode & 0o777, mode)
                    self.assertEqual(skill.read_bytes(), b"unchanged administrator content")
                chown.assert_not_called()

    def test_legacy_skills_migration_validates_before_reowning_and_preserves_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "skills"
            path.mkdir(mode=0o755)
            directory = path / "sample"
            directory.mkdir(mode=0o755)
            skill = directory / "SKILL.md"
            skill.write_bytes(b"unchanged skill")
            skill.chmod(0o644)
            original = Path.lstat
            def legacy_info(current):
                info = original(current)
                return os.stat_result((info.st_mode, info.st_ino, info.st_dev,
                    info.st_nlink, 0, 0, info.st_size, info.st_atime, info.st_mtime, info.st_ctime))
            with patch.object(system, "trusted"), patch.object(Path, "lstat", legacy_info), patch.object(os, "chown") as chown:
                system.skills_directory(path, 1234, create=False)
                chown.assert_not_called()
                skill.chmod(0o666)
                with self.assertRaisesRegex(RuntimeError, "Unsafe legacy"):
                    system.skills_directory(path, 1234, create=True, gid=1234)
                chown.assert_not_called()
                skill.chmod(0o644)
                link = directory / "link"
                link.symlink_to(skill)
                with self.assertRaisesRegex(RuntimeError, "Unsafe legacy"):
                    system.skills_directory(path, 1234, create=True, gid=1234)
                chown.assert_not_called()
                link.unlink()
                system.skills_directory(path, 1234, create=True, gid=1234)
                self.assertEqual(chown.call_count, 3)
                chown.assert_called_with(path, 1234, 1234, follow_symlinks=False)
                self.assertEqual(skill.read_bytes(), b"unchanged skill")

    def test_existing_private_data_is_never_reowned_or_erased(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "data"
            path.mkdir(mode=0o700)
            secret = path / "credential"
            secret.write_bytes(b"fixture credential")
            with patch.object(os, "chown") as chown:
                system.private_directory(
                    path, os.getuid(), create=True, gid=os.getgid()
                )
                with self.assertRaisesRegex(RuntimeError, "Unsafe"):
                    system.private_directory(
                        path, os.getuid() + 1, create=True, gid=os.getgid()
                    )
                path.chmod(0o755)
                with self.assertRaisesRegex(RuntimeError, "Unsafe"):
                    system.private_directory(
                        path, os.getuid(), create=True, gid=os.getgid()
                    )
                link = Path(temporary) / "link"
                link.symlink_to(path)
                with self.assertRaisesRegex(RuntimeError, "Unsafe"):
                    system.private_directory(
                        link, os.getuid(), create=True, gid=os.getgid()
                    )
                chown.assert_not_called()
            self.assertEqual(secret.read_bytes(), b"fixture credential")

    def test_account_rejects_shared_uid_group_or_supplementary_authority(self):
        identity = user("agent-work", 1235, 2235)
        group = SimpleNamespace(gr_name="agent-work", gr_gid=2235, gr_mem=[])
        with (
            patch.object(system.pwd, "getpwnam", return_value=identity),
            patch.object(system.grp, "getgrnam", return_value=group),
            patch.object(system.grp, "getgrall", return_value=[group]) as all_groups,
            patch.object(system.pwd, "getpwall", return_value=[identity]) as users,
            patch.object(os, "getgrouplist", return_value=[2235]) as groups,
        ):
            self.assertEqual(system.account("agent-work"), identity)
            all_groups.return_value = [
                group,
                SimpleNamespace(gr_name="other", gr_gid=2235),
            ]
            with self.assertRaisesRegex(RuntimeError, "Duplicate service GID"):
                system.account("agent-work")
            all_groups.return_value = [group]
            users.return_value = [identity, user("other", 1235, 3333)]
            with self.assertRaisesRegex(RuntimeError, "Duplicate UID"):
                system.account("agent-work")
            users.return_value = [identity, user("other", 9999, 2235)]
            with self.assertRaisesRegex(RuntimeError, "shared"):
                system.account("agent-work")
            users.return_value = [identity]
            groups.return_value = [2235, 27]
            with self.assertRaisesRegex(RuntimeError, "supplementary"):
                system.account("agent-work")

    def test_dns_uses_system_resolvers_and_only_dns_ports(self):
        rules = system.dns_rules(
            "search example.test\nnameserver 127.0.0.53\nnameserver 192.168.64.1 # router\nnameserver fe80::1%eth0\nnameserver 127.0.0.53\n"
        )
        self.assertEqual(rules.count("127.0.0.53"), 1)
        self.assertIn(
            "ip daddr 192.168.64.1 meta l4proto { tcp, udp } th dport 53 accept", rules
        )
        self.assertIn('oifname "eth0" ip6 daddr fe80::1', rules)
        self.assertEqual(len(rules.splitlines()), 3)
        for value in [
            "",
            "nameserver 0.0.0.0",
            "nameserver 224.0.0.1",
            "nameserver ::",
            "nameserver fe80::1%bad;rule",
            "nameserver 192.168.1.1 extra",
        ]:
            with (
                self.subTest(value=value),
                self.assertRaises((RuntimeError, ValueError)),
            ):
                system.dns_rules(value)

    def test_paths_do_not_adopt_symlinks_or_ambiguous_locations(self):
        for path in ["/", "/srv/../etc", "relative", "/srv//agent", "/srv/agent data"]:
            with self.assertRaises(RuntimeError):
                system.data_path(path)
        with tempfile.TemporaryDirectory() as temporary:
            link = Path(temporary) / "link"
            link.symlink_to("/srv")
            with self.assertRaisesRegex(RuntimeError, "symlinks"):
                system.data_path(str(link / "agent"))

    def test_failed_firewall_never_publishes_readiness(self):
        create_temp = tempfile.mkstemp
        with (
            tempfile.TemporaryDirectory() as temporary,
            patch.object(system, "READY", Path(temporary) / "ready"),
            patch.object(os, "geteuid", return_value=0),
            patch.object(system, "trusted"),
            patch.object(Path, "read_text", return_value="nameserver 127.0.0.53"),
            patch.object(
                system.subprocess, "run", return_value=SimpleNamespace(returncode=1)
            ),
            patch.object(system, "run", side_effect=RuntimeError("nft unavailable")),
            patch.object(
                system.tempfile,
                "mkstemp",
                side_effect=lambda **kwargs: create_temp(dir=temporary),
            ),
        ):
            system.READY.write_text("old readiness")
            with self.assertRaisesRegex(RuntimeError, "nft unavailable"):
                system.egress({"workUid": 1235})
            self.assertFalse(system.READY.exists())
            self.assertEqual(list(Path(temporary).iterdir()), [])

    def test_existing_account_with_unexpected_home_is_not_rewritten(self):
        identity = user("agent-work", 1235, 2235, "/somewhere-else")
        with (
            patch.object(installer.pwd, "getpwnam", return_value=identity),
            patch.object(installer, "account", return_value=identity),
            patch.object(installer, "run") as run,
        ):
            with self.assertRaisesRegex(RuntimeError, "unexpected home"):
                installer.ensure_account("agent-work", "/srv/agent-data/work/home")
            run.assert_not_called()


class Installation(unittest.TestCase):
    def test_origins_match_exact_browser_origins(self):
        for value in [
            "http://localhost:8081",
            "https://127.0.0.1",
            "http://[::1]:8080",
        ]:
            self.assertEqual(installer.origin(value), value)
        for value in [
            "http://localhost:80",
            "http://localhost/",
            "http://localhost:",
            "http://LOCALHOST",
            "http://192.168.1.1",
            "http://localhost:0",
        ]:
            with self.assertRaises(argparse.ArgumentTypeError):
                installer.origin(value)

    def test_shell_entrypoints_parse_and_help_needs_no_privileges(self):
        for name in ["install.sh", "runtimes.sh"]:
            subprocess.run(["/bin/bash", "-n", str(INSTALL / name)], check=True)
        for name in ["agent-work", "agent-preflight"]:
            subprocess.run(["/bin/sh", "-n", str(INSTALL / name)], check=True)
        result = subprocess.run(
            ["/bin/bash", str(INSTALL / "install.sh"), "--help"],
            capture_output=True,
            text=True,
            check=True,
        )
        self.assertIn("--update", result.stdout)
        self.assertIn("--listen", result.stdout)
        self.assertIn("--build-only", result.stdout)

    def test_invalid_setup_arguments_do_not_download_or_request_sudo(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ["curl", "sudo"]:
                command = root / name
                command.write_text(
                    '#!/bin/sh\ntouch "' + str(root / "called") + '"\nexit 99\n'
                )
                command.chmod(0o755)
            for args in [
                ["--unknown"],
                ["--data-dir"],
                ["--data-dir", "--update"],
                ["--build-only", "--update"],
                ["--update", "--data-dir", "/srv/other"],
            ]:
                result = subprocess.run(
                    ["/bin/bash", str(INSTALL / "install.sh"), *args],
                    env={"PATH": str(root) + ":/usr/bin:/bin"},
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(result.returncode, 64, result.stderr)
                self.assertFalse((root / "called").exists())

    def test_runtime_checksum_failure_stops_before_extraction(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            script = '''set -e
source "$1"
curl() {
  while [[ "$1" != --output ]]; do shift; done
  printf 'damaged download' > "$2"
}
tar() { touch "$CHECK_EXTRACTED"; }
prepare_runtimes "$2"
'''
            result = subprocess.run(
                [
                    "/bin/bash", "-c", script, "test",
                    str(INSTALL / "runtimes.sh"), str(root),
                ],
                env={**os.environ, "CHECK_EXTRACTED": str(root / "extracted")},
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((root / "extracted").exists())
            self.assertFalse((root / "node").exists())

    def test_runtime_download_accepts_only_matching_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "download"
            digest = hashlib.sha256(b"fixture runtime").hexdigest()
            script = '''set -e
source "$1"
curl() {
  while [[ "$1" != --output ]]; do shift; done
  printf 'fixture runtime' > "$2"
}
download_runtime https://example.test/runtime "$2" "$3"
'''
            subprocess.run(
                [
                    "/bin/bash", "-c", script, "test",
                    str(INSTALL / "runtimes.sh"), digest, str(destination),
                ],
                check=True,
            )
            self.assertEqual(destination.read_bytes(), b"fixture runtime")

    def test_copy_rejects_external_links_and_nonregular_input(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            source.mkdir()
            (source / "file").write_text("app")
            (source / "link").symlink_to("file")
            installer.copy_tree(source, root / "good")
            self.assertEqual((root / "good/link").read_text(), "app")
            (source / "bad").symlink_to("/etc/passwd")
            with self.assertRaisesRegex(RuntimeError, "External"):
                installer.copy_tree(source, root / "bad")
            (source / "bad").unlink()
            os.mkfifo(source / "fifo")
            with self.assertRaisesRegex(RuntimeError, "Nonregular"):
                installer.copy_tree(source, root / "fifo")

    def test_active_service_is_not_stopped_by_installer(self):
        with patch.object(
            installer.subprocess, "run", return_value=SimpleNamespace(stdout="active\n")
        ) as run:
            with self.assertRaisesRegex(RuntimeError, "Stop agent.service"):
                installer.inactive()
            self.assertEqual(run.call_count, 1)

    def test_install_and_update_preserve_settings_data_and_previous_app(self):
        with tempfile.TemporaryDirectory() as temporary, ExitStack() as stack:
            root = Path(temporary)
            source, node, python = root / "source", root / "node", root / "python"
            source.mkdir()
            for name in ["dist/src", "dist/web", "node_modules", "examples", "scripts"]:
                (source / name).mkdir(parents=True)
            for name in [
                "dist/src/main.js",
                "dist/web/app.js",
                "package.json",
                "package-lock.json",
                "README.md",
            ]:
                (source / name).write_text("first version")
            shutil.copytree(
                INSTALL,
                source / "install",
                ignore=shutil.ignore_patterns("__pycache__"),
            )
            (node / "bin").mkdir(parents=True)
            (node / "bin/node").write_text("node fixture")
            (python / "bin").mkdir(parents=True)
            (python / "bin/python3").write_text("python fixture")
            paths = {
                "APP": root / "opt/agent",
                "NODE": root / "opt/agent-node",
                "PYTHON": root / "opt/agent-python",
                "ETC": root / "etc/agent",
                "UNITS": root / "etc/systemd/system",
                "LIBEXEC": root / "usr/local/libexec",
                "SUDOERS": root / "etc/sudoers.d/agent-work",
            }
            for name, path in paths.items():
                path.parent.mkdir(parents=True, exist_ok=True)
                stack.enter_context(patch.object(installer, name, path))
            paths["UNITS"].mkdir()
            stack.enter_context(
                patch.object(installer, "RECORD", paths["ETC"] / "installation.json")
            )
            stack.enter_context(patch.object(system, "trusted"))
            for name in ["require_host", "inactive", "trusted"]:
                stack.enter_context(patch.object(installer, name))
            stack.enter_context(patch.object(installer, "storage", return_value=MOUNT))
            stack.enter_context(
                patch.object(installer, "check", side_effect=lambda record: record)
            )
            stack.enter_context(
                patch.object(
                    installer,
                    "run",
                    side_effect=lambda *args: "3.14.10"
                    if args[0] == str(python / "bin/python3")
                    else "v26.13.0",
                )
            )
            process_probe = stack.enter_context(
                patch.object(
                    installer.subprocess,
                    "run",
                    return_value=SimpleNamespace(returncode=1),
                )
            )
            stack.enter_context(patch.object(os, "chown"))
            firewall = stack.enter_context(patch.object(system, "egress"))
            data = root / "data"
            control, work = (
                user("agent-control", os.getuid(), 2234),
                user("agent-work", os.getuid() + 1, 2235, str(data / "work/home")),
            )
            identities = lambda name, *args: (
                control if name == "agent-control" else work
            )
            stack.enter_context(
                patch.object(installer, "account", side_effect=identities)
            )
            stack.enter_context(
                patch.object(installer, "ensure_account", side_effect=identities)
            )

            # Actual filesystem operations, with ownership represented by the fixture UID.
            def private(path, uid, create=False, gid=None):
                system.private_directory(path, os.getuid(), create, os.getgid())

            stack.enter_context(
                patch.object(installer, "private_directory", side_effect=private)
            )
            args = argparse.Namespace(
                source=str(source),
                node=str(node),
                python=str(python),
                update=False,
                data_dir=str(data),
                listen=None,
                origin=None,
            )
            for path in [
                paths["APP"], paths["NODE"] / "data",
                paths["PYTHON"] / "data", paths["ETC"],
            ]:
                args.data_dir = str(path)
                with self.assertRaisesRegex(RuntimeError, "Data must be outside"):
                    installer.install(args)
                self.assertFalse(path.exists())
            args.data_dir = str(data)
            installer.install(args)
            record_path = paths["ETC"] / "installation.json"
            record = json.loads(record_path.read_text())
            self.assertEqual(record["storage"], MOUNT)
            self.assertEqual(record["workUid"], work.pw_uid)
            self.assertEqual((data / "control").stat().st_mode & 0o777, 0o700)
            config_path = paths["ETC"] / "config.yaml"
            config = config_path.read_bytes()
            self.assertEqual(json.loads(config)["server"]["host"], "0.0.0.0")
            retained = {
                data / "control/settings-v1.json": b"fixture private settings",
                data / "control/conversations-v1.sqlite": b"fixture database",
                data / "work/conversations/output.txt": b"user file",
                data / "skills/SKILL.md": b"administrator skill bytes",
                paths["ETC"] / "protected-cidrs.nft": b"custom policy",
            }
            for path, content in retained.items():
                path.write_bytes(content)
            (source / "dist/src/main.js").write_text("updated version")
            with self.assertRaisesRegex(RuntimeError, "Existing installation"):
                installer.install(args)
            args.update, args.data_dir = True, None
            stack.enter_context(
                patch.object(installer, "load_record", return_value=record)
            )
            process_probe.return_value = SimpleNamespace(returncode=0)
            with self.assertRaisesRegex(
                RuntimeError, "Stop all service-user processes"
            ):
                installer.install(args)
            self.assertEqual(
                (paths["APP"] / "dist/src/main.js").read_text(), "first version"
            )
            process_probe.return_value = SimpleNamespace(returncode=1)
            installer.install(args)
            self.assertEqual(
                (paths["APP"] / "dist/src/main.js").read_text(), "updated version"
            )
            previous = list(paths["APP"].parent.glob("agent.previous-*"))
            self.assertEqual(len(previous), 1)
            self.assertEqual(
                (previous[0] / "dist/src/main.js").read_text(), "first version"
            )
            self.assertEqual(config_path.read_bytes(), config)
            self.assertEqual(json.loads(record_path.read_text()), record)
            for path, content in retained.items():
                self.assertEqual(path.read_bytes(), content)
            self.assertEqual(firewall.call_count, 2)
            self.assertEqual(
                (paths["PYTHON"] / "bin/python3").read_text(), "python fixture"
            )
            self.assertEqual(
                len(list(paths["PYTHON"].parent.glob("agent-python.previous-*"))), 1
            )
            self.assertIn(str(data), (paths["LIBEXEC"] / "agent-work").read_text())
            self.assertNotIn(
                "@DATA_ROOT@", (paths["UNITS"] / "agent.service").read_text()
            )
            # An existing installation can add the dedicated Python without adopting data.
            paths["PYTHON"].rename(root / "old-python")
            installer.install(args)
            self.assertTrue((paths["PYTHON"] / "bin/python3").is_file())
            self.assertEqual(config_path.read_bytes(), config)
            self.assertEqual(json.loads(record_path.read_text()), record)
            for path, content in retained.items():
                self.assertEqual(path.read_bytes(), content)


if __name__ == "__main__":
    unittest.main()
