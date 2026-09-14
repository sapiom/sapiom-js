import hashlib
import io
import tarfile
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch
from inputs import catalog, compiler, download, extract_source, member_bytes


class InputBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def archive(self, entries):
        path = self.root / "fixture.tgz"
        with tarfile.open(path, "w:gz") as tar:
            for name, data, link in entries:
                entry = tarfile.TarInfo(name)
                if link:
                    entry.type, entry.linkname = tarfile.SYMTYPE, link
                else:
                    entry.size = len(data)
                tar.addfile(entry, None if link else io.BytesIO(data))
        return path

    def test_rejects_source_escape_links_and_duplicate_members(self):
        for name, link in [("source/../../escape", None), ("source/link", "../../escape")]:
            with self.subTest(name=name):
                archive = self.archive([(name, b"payload", link)])
                with self.assertRaises(RuntimeError):
                    extract_source(archive, self.root / "out", "source")
                self.assertFalse((self.root / "escape").exists())
        archive = self.archive([("package/bin/bun", b"one", None), ("package/bin/bun", b"two", None)])
        with tarfile.open(archive) as tar, self.assertRaises(RuntimeError):
            member_bytes(tar, "package/bin/bun")

    def test_corrupt_cache_fails_without_repair_or_execution(self):
        item = {"url": "https://example.invalid/pinned", "sha256": hashlib.sha256(b"trusted").hexdigest()}
        cached = self.root / hashlib.sha256(item["url"].encode()).hexdigest()
        cached.write_bytes(b"changed")
        with patch("urllib.request.urlopen") as network, self.assertRaises(RuntimeError):
            download(item, self.root)
        network.assert_not_called()
        item["bytes"] = 7
        with self.assertRaises(RuntimeError):
            compiler(item, cached, self.root)
        self.assertEqual(cached.read_bytes(), b"changed")

    def test_compiler_symlink_is_not_trusted(self):
        real = self.root / "real"
        real.write_bytes(b"trusted")
        target = self.root / "bun"
        target.symlink_to(real)
        with self.assertRaises(RuntimeError):
            compiler({"bytes": 7, "sha256": hashlib.sha256(b"trusted").hexdigest()}, target, self.root)

    def test_concurrent_downloads_publish_one_verified_artifact(self):
        item = {"url": "https://example.invalid/pinned", "sha256": hashlib.sha256(b"trusted").hexdigest()}
        barrier = threading.Barrier(2, timeout=2)

        class Response(io.BytesIO):
            url = item["url"]

            def read(self, size=-1):
                if self.tell() == 0:
                    barrier.wait()
                return super().read(size)

        with patch("urllib.request.urlopen", side_effect=lambda *a, **kw: Response(b"trusted")):
            with ThreadPoolExecutor(max_workers=2) as pool:
                futures = [pool.submit(download, item, self.root) for _ in range(2)]
                results = [future.result() for future in futures]
        self.assertEqual(results[0], results[1])
        self.assertEqual(results[0].read_bytes(), b"trusted")
        self.assertEqual(list(self.root.iterdir()), [results[0]])

    def test_preserves_internal_source_links_after_regular_files(self):
        archive = self.archive([("source/icon", b"", "assets/icon"),
                                ("source/assets/icon", b"icon bytes", None)])
        extract_source(archive, self.root / "out", "source")
        self.assertEqual((self.root / "out/icon").read_bytes(), b"icon bytes")
        self.assertTrue((self.root / "out/icon").is_symlink())

    def test_catalog_is_data_and_never_evaluated_as_javascript(self):
        script = b'globalThis.process.exit(0)'
        item = {"url": "https://example.invalid/catalog", "integrity": "unused",
                "snapshotSha256": hashlib.sha256(script).hexdigest()}
        with patch("inputs.download"), patch("inputs.package_member", return_value=script):
            with self.assertRaises(RuntimeError):
                catalog(item, self.root, self.root / "providers.json")
        self.assertFalse((self.root / "providers.json").exists())


if __name__ == "__main__":
    unittest.main()
