"""Package verified native build outputs. No publishing or execution occurs here."""
import argparse
import base64
import gzip
import hashlib
import io
import json
import subprocess
import tarfile
import tempfile
from pathlib import Path
from build import MANIFEST, REPO
from inputs import digest, download, member_bytes, require, verified

HERE = Path(__file__).resolve().parent
PACKAGING = HERE / "packaging.json"


def encoded(value):
    return (json.dumps(value, indent=2) + "\n").encode()


def archive(path, files):
    # Stable member ordering, modes, ownership and timestamps; never copy links.
    with path.open("xb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as zipped:
        with tarfile.open(mode="w|", fileobj=zipped) as tar:
            for name, (content, mode) in sorted(files.items()):
                entry = tarfile.TarInfo("package/" + name)
                entry.mode = mode
                if isinstance(content, Path):
                    entry.size = content.stat().st_size
                    with content.open("rb") as stream:
                        tar.addfile(entry, stream)
                else:
                    entry.size = len(content)
                    tar.addfile(entry, io.BytesIO(content))
    return {"artifact": path.name, "bytes": path.stat().st_size, "sha256": digest(path).hex(),
            "integrity": "sha512-" + base64.b64encode(digest(path, "sha512")).decode()}


def root_files(spec, cache):
    template = download(spec["rootTemplate"], cache)
    names = ["package.json", "LICENSE", "bin/opencode.exe", "postinstall.mjs"]
    with tarfile.open(template, "r:gz") as tar:
        require(sorted(entry.name for entry in tar.getmembers()) ==
                sorted("package/" + name for name in names), "Unexpected root template members")
        files = {name: (member_bytes(tar, "package/" + name),
                        0o755 if name in ("bin/opencode.exe", "postinstall.mjs") else 0o644) for name in names}
    require(hashlib.sha256(files["bin/opencode.exe"][0]).hexdigest() == spec["launcherStubSha256"],
            "Unexpected launcher stub")
    patch = verified(REPO / "patches/opencode/selected-platform-installer.patch",
                     {"sha256": spec["installerPatchSha256"]})
    with tempfile.TemporaryDirectory(prefix="opencode-installer-") as temporary:
        target = Path(temporary) / "packages/opencode/script/postinstall.mjs"
        target.parent.mkdir(parents=True)
        target.write_bytes(files["postinstall.mjs"][0])
        subprocess.run(["git", "apply", "--check", str(patch)], cwd=temporary, check=True)
        subprocess.run(["git", "apply", str(patch)], cwd=temporary, check=True)
        verified(target, {"sha256": spec["postinstallSha256"]})
        files["postinstall.mjs"] = (target.read_bytes(), 0o755)
    return files


def pack(work, output, cache):
    manifest = json.loads(MANIFEST.read_text())
    spec = json.loads(PACKAGING.read_text())
    proof = json.loads((work / "build-proof.json").read_text())
    require(proof["schemaVersion"] == 1 and proof["single"] is False and
            proof["releaseEnvironment"] == "unset", "A complete, unpublished build is required")
    for name, path in [("manifestSha256", MANIFEST), ("recipeSha256", HERE / "build.py"),
                       ("inputsHelperSha256", HERE / "inputs.py")]:
        require(proof[name] == digest(path).hex(), "Build recipe changed; rebuild before packaging")
    require(proof["node"] == manifest["nodeVersion"] and proof["bun"] == manifest["bunRevision"],
            "Build tool identity mismatch")
    require(sorted(proof["outputs"]) == sorted(manifest["platforms"]), "Incomplete build proof")
    dist = work / "source/packages/opencode/dist"
    require(sorted(path.name for path in dist.iterdir()) == sorted(manifest["platforms"]),
            "Unexpected build outputs")
    files = root_files(spec, cache)
    original = json.loads(files["package.json"][0])
    require(original["name"] == "opencode-ai" and original["version"] == manifest["upstreamVersion"] and
            sorted(original["optionalDependencies"]) == sorted(manifest["platforms"]), "Wrong root template")
    version = manifest["runtimeVersion"]
    base = f"https://github.com/sapiom/sapiom-js/releases/download/opencode-runtime-v{version}/"
    provenance = {"schemaVersion": 1, "kind": "unpublished-native-runtime-candidate",
                  "build": proof, "nativeInputs": manifest, "packaging": spec,
                  "packRecipeSha256": digest(Path(__file__)).hex()}
    output.mkdir(parents=True)  # Refuse mixed or previously generated artifacts.
    artifacts, selected = {}, {}
    for name in manifest["platforms"]:
        item = proof["outputs"][name]
        metadata = json.loads((dist / name / "package.json").read_text())
        require(metadata == item["package"] and metadata["name"] == name and metadata["version"] == version,
                "Platform metadata mismatch")
        binary_name = "opencode.exe" if "windows" in name else "opencode"
        binary = verified(dist / name / "bin" / binary_name,
                          {"sha256": item["binarySha256"], "bytes": item["bytes"]})
        result = archive(output / f"{name}-{version}.tgz", {
            "package.json": (encoded(metadata), 0o644), "bin/" + binary_name: (binary, 0o755),
            "LICENSE": files["LICENSE"], "native-provenance.json": (encoded(provenance), 0o644)})
        artifacts[name] = {**result, "binarySha256": item["binarySha256"]}
        selected[name] = {"url": base + result["artifact"], "binarySha256": item["binarySha256"]}
    metadata = {**original, "version": version, "sapiomRuntimeArtifacts": selected}
    del metadata["optionalDependencies"]
    require("dependencies" not in metadata, "The root must install only its selected platform")
    files["package.json"] = (encoded(metadata), 0o644)
    files["native-provenance.json"] = (encoded({**provenance, "platformArtifacts": artifacts}), 0o644)
    artifacts["opencode-ai"] = archive(output / f"opencode-ai-{version}.tgz", files)
    result = {**provenance, "baseURL": base, "artifacts": artifacts}
    (output / "release-proof.json").write_bytes(encoded(result))
    print(json.dumps({"proof": str(output / "release-proof.json"), "artifacts": len(artifacts)}))
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True, help="New artifact directory")
    parser.add_argument("--download-cache", type=Path, required=True)
    args = parser.parse_args()
    pack(args.work_dir.absolute(), args.output_dir.absolute(), args.download_cache.absolute())
