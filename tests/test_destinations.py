"""Validate privileged input and persistent/kernel update ordering without root."""

import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "install"))
import system

A = {"name": "自宅", "ip": "10.10.20.62", "port": 22}
B = {"name": "", "ip": "10.10.20.63", "port": 443}


class DestinationChecks(unittest.TestCase):
    def test_only_literal_endpoint_pairs_and_printable_labels(self):
        self.assertEqual(system.destination_entries([A, B]), [A, B])
        for entry in (
            {**A, "ip": "10.10.20.62/32"},
            {**A, "ip": "10.010.20.62"},
            {**A, "ip": "::ffff:10.10.20.62"},
            {**A, "ip": "127.0.0.1"},
            {**A, "ip": "169.254.169.254"},
            {**A, "ip": "100.100.100.200"},
            {**A, "port": True},
            {**A, "port": 65536},
            {**A, "name": "two\nlines"},
            {**A, "protocol": "udp"},
        ):
            with self.subTest(entry=entry), self.assertRaises(ValueError):
                system.destination_entries([entry])
        with self.assertRaises(ValueError):
            system.destination_entries([A, {**A, "name": "duplicate"}])

    def test_apply_failure_restores_previous_file_and_active_pairs(self):
        old, new = system.endpoint_pairs([A]), system.endpoint_pairs([B])
        active = old
        order = []
        with tempfile.TemporaryDirectory() as directory:
            dest = Path(directory) / "destinations.json"
            with patch.object(system, "DESTINATIONS", dest):
                system.persist_destinations([A])

                def replace(pairs):
                    nonlocal active
                    order.append(pairs)
                    self.assertLessEqual(pairs, system.endpoint_pairs(json.loads(dest.read_text())))
                    active = pairs
                    if pairs == new:
                        raise subprocess.TimeoutExpired("nft", 10)

                with patch.object(system, "replace_endpoints", side_effect=replace):
                    with self.assertRaises(subprocess.TimeoutExpired):
                        system.save_destinations([A], [B], old)
                self.assertEqual(json.loads(dest.read_text()), [A])
                self.assertEqual(active, old)
                self.assertEqual(order, [set(), new, set(), old])

    def test_request_checks_revision_and_protected_prefix_even_for_control(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            template = base / "egress.nft"
            template.write_text(system.DESTINATION_MARKER)
            protected = base / "protected.nft"
            protected.write_text("# deny this range\ndefine protected_cidrs = { 10.10.20.63/32 }\n")
            pairs = system.endpoint_pairs([A])
            with (
                patch.object(system, "egress_lock", side_effect=nullcontext),
                patch.object(system, "trusted"),
                patch.object(system, "EGRESS_TEMPLATE", template),
                patch.object(system, "PROTECTED", protected),
                patch.object(system, "DESTINATIONS", base / "destinations.json"),
                patch.object(system, "active_endpoints", return_value=pairs),
                patch.object(system, "save_destinations") as save,
            ):
                system.persist_destinations([A])
                current = system.destination_request({"operation": "read"})
                self.assertTrue(current["applied"])
                update = {"operation": "write", "revision": current["revision"], "entries": [A, B]}
                self.assertEqual(system.destination_request(update), {"status": "invalid"})
                self.assertEqual(system.destination_request({**update, "revision": "stale", "entries": []}), {"status": "conflict"})
                save.assert_not_called()
