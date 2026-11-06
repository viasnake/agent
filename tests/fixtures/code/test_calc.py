import unittest
from calc import total


class TotalTest(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(total([]), 0)

    def test_single(self):
        self.assertEqual(total([5]), 5)

    def test_multiple(self):
        self.assertEqual(total([2, 3, 4]), 9)
