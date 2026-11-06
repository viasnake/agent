import importlib.util
import io
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("agent_guest_disk", Path(__file__).parents[1] / "vm" / "guest-disk.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class EmptyDiskTest(unittest.TestCase):
    def test_zero_filled_disk(self):
        module.assert_empty(io.BytesIO(bytes(1024)), 1024)

    def test_middle_data_is_never_mistaken_for_blank_edges(self):
        data = bytearray(20 * 1024 * 1024)
        data[10 * 1024 * 1024] = 1
        with self.assertRaises(RuntimeError):
            module.assert_empty(io.BytesIO(data), len(data))

    def test_short_read_or_unknown_size_fails_closed(self):
        for data, size in [(bytes(1), 1024), (b"", 0)]:
            with self.assertRaises(RuntimeError):
                module.assert_empty(io.BytesIO(data), size)
