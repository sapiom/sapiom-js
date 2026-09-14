import hashlib
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from pack import HERE, MANIFEST, archive, pack
from inputs import digest, member_bytes


class PackagingTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.manifest = json.loads(MANIFEST.read_text())
        self.dist = self.root / "source/packages/opencode/dist"
        outputs = {}
        for name in self.manifest["platforms"]:
            directory = self.dist / name
            (directory / "bin").mkdir(parents=True)
            data = name.encode()  # Deliberately non-executable fixture bytes.
            metadata = {"name": name, "version": self.manifest["runtimeVersion"]}
            (directory / "package.json").write_text(json.dumps(metadata))
            (directory / "bin" / ("opencode.exe" if "windows" in name else "opencode")).write_bytes(data)
            outputs[name] = {"package": metadata, "bytes": len(data),
                             "binarySha256": hashlib.sha256(data).hexdigest()}
        self.proof = {"schemaVersion": 1, "single": False, "releaseEnvironment": "unset",
                      "manifestSha256": digest(MANIFEST).hex(), "recipeSha256": digest(HERE / "build.py").hex(),
                      "inputsHelperSha256": digest(HERE / "inputs.py").hex(),
                      "node": self.manifest["nodeVersion"], "bun": self.manifest["bunRevision"], "outputs": outputs}
        self.save_proof()
        original = {"name": "opencode-ai", "version": self.manifest["upstreamVersion"],
                    "bin": {"opencode": "./bin/opencode.exe"},
                    "scripts": {"postinstall": "node ./postinstall.mjs"},
                    "optionalDependencies": dict.fromkeys(self.manifest["platforms"], self.manifest["upstreamVersion"])}
        self.files = {"package.json": (json.dumps(original).encode(), 0o644), "LICENSE": (b"license", 0o644),
                      "bin/opencode.exe": (b"installer required", 0o755), "postinstall.mjs": (b"fixture", 0o755)}

    def save_proof(self):
        (self.root / "build-proof.json").write_text(json.dumps(self.proof))

    def package(self, name="release"):
        with patch("pack.root_files", return_value=self.files.copy()):
            return pack(self.root, self.root / name, self.root / "cache")

    def test_complete_archives_preserve_bytes_license_and_provenance(self):
        result = self.package()
        self.assertEqual(len(result["artifacts"]), 13)
        for name, item in result["artifacts"].items():
            path = self.root / "release" / item["artifact"]
            self.assertEqual(digest(path).hex(), item["sha256"])
            with tarfile.open(path) as tar:
                self.assertTrue(all(entry.isfile() and entry.uid == 0 and entry.mtime == 0 for entry in tar))
                self.assertEqual(member_bytes(tar, "package/LICENSE"), b"license")
                provenance = json.loads(member_bytes(tar, "package/native-provenance.json"))
                self.assertEqual(provenance["build"], self.proof)
                metadata = json.loads(member_bytes(tar, "package/package.json"))
                if name == "opencode-ai":
                    self.assertNotIn("optionalDependencies", metadata)
                    self.assertNotIn("dependencies", metadata)
                    self.assertEqual(len(metadata["sapiomRuntimeArtifacts"]), 12)
                else:
                    binary = "package/bin/" + ("opencode.exe" if "windows" in name else "opencode")
                    self.assertEqual(member_bytes(tar, binary), name.encode())
                    self.assertEqual(tar.getmember(binary).mode, 0o755)
        repeated = self.package("repeated")
        self.assertEqual(result, repeated)

    def test_rejects_stale_recipe_partial_build_or_changed_binary(self):
        for field, changed in [("single", True), ("releaseEnvironment", "0"),
                               ("recipeSha256", "0" * 64), ("outputs", {})]:
            with self.subTest(field=field):
                original = self.proof[field]
                self.proof[field] = changed
                self.save_proof()
                with self.assertRaises(RuntimeError):
                    self.package(field)
                self.assertFalse((self.root / field / "release-proof.json").exists())
                self.proof[field] = original
        self.save_proof()
        (self.dist / "opencode-linux-x64/bin/opencode").write_bytes(b"changed")
        with self.assertRaises(RuntimeError):
            self.package("changed")
        self.assertFalse((self.root / "changed/release-proof.json").exists())

    def test_archive_refuses_to_overwrite_an_existing_candidate(self):
        path = self.root / "candidate.tgz"
        archive(path, {"file": (b"original", 0o644)})
        original = digest(path)
        with self.assertRaises(FileExistsError):
            archive(path, {"file": (b"replacement", 0o644)})
        self.assertEqual(digest(path), original)


if __name__ == "__main__":
    unittest.main()
