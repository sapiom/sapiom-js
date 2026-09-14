"""Produce explicitly local installer fixtures from a verified release candidate."""
import argparse
import json
import tarfile
from pathlib import Path
from urllib.parse import urlparse
from inputs import member_bytes, require, verified
from pack import archive, encoded


def fixture(artifacts, output, base, override=None):
    url = urlparse(base)
    require(url.scheme == "http" and url.hostname == "127.0.0.1" and url.path == "/" and
            not url.username and not url.password and not url.query and not url.fragment,
            "Installer fixtures require a loopback server")
    proof = json.loads((artifacts / "release-proof.json").read_text())
    root = proof["artifacts"]["opencode-ai"]
    source = verified(artifacts / root["artifact"], root)
    with tarfile.open(source) as tar:
        files = {entry.name.removeprefix("package/"):
                 (member_bytes(tar, entry.name), entry.mode) for entry in tar.getmembers()}
    metadata = json.loads(files["package.json"][0])
    for name, item in metadata["sapiomRuntimeArtifacts"].items():
        item["url"] = base + proof["artifacts"][name]["artifact"]
    metadata["private"] = True
    metadata["sapiomRuntimeFixtureOf"] = root["sha256"]
    if override:
        metadata["sapiomRuntimeArtifacts"].update(override)
    files["package.json"] = (encoded(metadata), 0o644)
    archive(output, files)


def poison(output, name, version):
    # A platform install script would leave a marker if --ignore-scripts were lost.
    marker = b'require("node:fs").writeFileSync(process.env.OPENCODE_POISON_MARKER, "executed");\n'
    metadata = {"name": name, "version": version, "scripts": {"postinstall": "node mark.cjs"}}
    archive(output, {"package.json": (encoded(metadata), 0o644), "mark.cjs": (marker, 0o644),
                     "bin/" + ("opencode.exe" if "windows" in name else "opencode"):
                     (b"#!/usr/bin/env node\n" + marker, 0o755)})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--override", type=Path)
    parser.add_argument("--poison-platform")
    args = parser.parse_args()
    if args.poison_platform:
        version = json.loads((args.artifacts / "release-proof.json").read_text())["nativeInputs"]["runtimeVersion"]
        poison(args.output, args.poison_platform, version)
    else:
        fixture(args.artifacts, args.output, args.base_url,
                json.loads(args.override.read_text()) if args.override else None)
