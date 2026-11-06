"""Negative release-inventory checks; fixtures never enter the application APK."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import sys
import zipfile

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location("android_release", Path(__file__).with_name("package-release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class DistributionTest(unittest.TestCase):
    def test_nested_notices_use_portable_paths_and_downloads_match(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "licenses").mkdir()
            (root / "licenses/LICENSE.txt").write_bytes(b"notice")
            artifact = root / "client.apk"
            artifact.write_bytes(b"unchanged signed artifact")
            for name in ("provenance.json", "sbom.cdx.json", "SHA256SUMS.txt"):
                (root / name).write_bytes(b"fixture")
            release.write_distribution(root, artifact)
            with zipfile.ZipFile(root / "distribution.zip") as archive:
                self.assertIn("licenses/LICENSE.txt", archive.namelist())
                self.assertTrue(all("\\" not in name for name in archive.namelist()))
                self.assertEqual(archive.read("client.apk"), artifact.read_bytes())
                self.assertNotIn("distribution.zip", archive.namelist())
            lines = (root / "DOWNLOAD-SHA256SUMS.txt").read_text().splitlines()
            self.assertEqual(len(lines), 4)
            for line in lines:
                digest, name = line.split("  ", 1)
                self.assertEqual(digest, release.sha(root / name))


class Archive:
    def __init__(self, notice=b"original notice"):
        self.notice = notice

    def read(self, name):
        if name != "assets/licenses/LICENSE.txt":
            raise KeyError(name)
        return self.notice


class InventoryTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / "third_party-manifests").mkdir()
        (self.root / "LICENSE.txt").write_bytes(b"original notice")
        (self.root / "native.a").write_bytes(b"original static library")
        digest = lambda value: hashlib.sha256(value).hexdigest()
        self.runtime = {"dependencies": [{"coordinate": "example:library:1", "sha256": digest(b"runtime library")}]}
        self.manifest = {
            "notices": [{"name": "LICENSE.txt", "path": "LICENSE.txt", "sha256": digest(b"original notice")}],
            "runtime_dependencies": [{**self.runtime["dependencies"][0], "notice": "LICENSE.txt"}],
            "native_archives": [{"path": "native.a", "sha256": digest(b"original static library"), "notice": "LICENSE.txt"}],
        }

    def verify(self, archive=None):
        (self.root / "third_party-manifests/android-notices.json").write_text(json.dumps(self.manifest), encoding="utf-8")
        return release.verify_dependency_inventory(self.root, archive or Archive(), self.runtime)

    def test_reviewed_inventory_matches(self):
        self.assertEqual(self.verify(), self.manifest)

    def test_new_runtime_dependency_is_not_silently_released(self):
        self.runtime["dependencies"].append({"coordinate": "example:unreviewed:1", "sha256": "0" * 64})
        with self.assertRaisesRegex(RuntimeError, "dependency set"):
            self.verify()

    def test_same_version_with_changed_bytes_fails(self):
        self.runtime["dependencies"][0]["sha256"] = "0" * 64
        with self.assertRaisesRegex(RuntimeError, "Unreviewed dependency"):
            self.verify()

    def test_apk_notice_differs_from_source(self):
        with self.assertRaisesRegex(RuntimeError, "distribution notice"):
            self.verify(Archive(b"different notice"))

    def test_native_archive_replaced_without_review(self):
        (self.root / "native.a").write_bytes(b"replacement library")
        with self.assertRaisesRegex(RuntimeError, "Unreviewed native archive"):
            self.verify()

    def test_duplicate_runtime_coordinate_fails(self):
        self.runtime["dependencies"].append(dict(self.runtime["dependencies"][0]))
        with self.assertRaisesRegex(RuntimeError, "dependency set"):
            self.verify()


if __name__ == "__main__":
    unittest.main()
