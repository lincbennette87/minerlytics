import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "sync_website_mine_details.py"
SPEC = importlib.util.spec_from_file_location("sync_website_mine_details", SCRIPT_PATH)
module = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = module
SPEC.loader.exec_module(module)


class MineResourceExtractionTests(unittest.TestCase):
    def test_resource_value_keeps_decimal_and_stops_at_next_classification(self):
        text = (
            "Mineral Reserves & Mineral Resources "
            "Measured & Indicated Gold Mineral Resources 4.3 Moz gold "
            "Inferred Gold Mineral Resources 1.2 Moz gold "
            "Technical Reports Annual report"
        )

        self.assertEqual(
            module.resource_value(text, "measured_indicated"),
            "Measured & Indicated Gold Mineral Resources 4.3 Moz gold",
        )
        self.assertEqual(
            module.resource_value(text, "inferred"),
            "Inferred Gold Mineral Resources 1.2 Moz gold",
        )

    def test_resource_value_keeps_grade_tonnage_and_contained_metal(self):
        text = (
            "Resources Indicated Mineral Resource Estimate of 594 kt at 4.51 g/t Au, "
            "209.7 g/t Ag, 4.34% Pb, and 6.77% Zn containing 86 koz Au, "
            "4.0 Moz Ag, 57 Mlb Pb, and 89 Mlb Zn. "
            "Inferred Mineral Resource Estimate of 2,736 kt at 5.07 g/t Au, "
            "188.6 g/t Ag, 3.69% Pb, and 4.42% Zn containing 446 koz Au, "
            "16.6 Moz Ag, 223 Mlb Pb, and 267 Mlb Zn. HIGHLIGHTS"
        )

        indicated = module.resource_value(text, "measured_indicated")
        inferred = module.resource_value(text, "inferred")

        self.assertIn("4.51 g/t Au", indicated)
        self.assertIn("86 koz Au", indicated)
        self.assertIn("2,736 kt", inferred)
        self.assertIn("16.6 Moz Ag", inferred)
        self.assertNotIn("HIGHLIGHTS", inferred)

    def test_resource_value_accepts_numeric_table_rows(self):
        text = (
            "Gold and Silver Mineral Resource Estimates - Exclusive of Mineral Reserves "
            "Measured Mineral Resources 30,572 0.50 490 2.10 2,065 "
            "Indicated Mineral Resources 19,856 0.72 462 2.78 1,777 "
            "Measured + Indicated Mineral Resources 50,428 0.59 952 2.37 3,842 "
            "Inferred Mineral Resources 3,428 0.65 73 1.92 210 NOTE"
        )

        self.assertEqual(
            module.resource_value(text, "measured_indicated"),
            "Measured + Indicated Mineral Resources 50,428 0.59 952 2.37 3,842",
        )
        self.assertEqual(
            module.resource_value(text, "inferred"),
            "Inferred Mineral Resources 3,428 0.65 73 1.92 210",
        )

    def test_clean_resource_field_stops_before_initial_assessment(self):
        value = (
            "Inferred Mineral Resources of 2.30 million ounces of gold "
            "Initial Assessment The Initial Assessment contemplates a conventional open-pit mine."
        )

        self.assertEqual(
            module.clean_resource_field(value),
            "Inferred Mineral Resources of 2.30 million ounces of gold",
        )


if __name__ == "__main__":
    unittest.main()
