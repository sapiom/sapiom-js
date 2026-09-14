"""Verify build inputs before extracting data or executing a compiler."""
import base64
import hashlib
import json
import os
import shutil
import stat
import tarfile
import tempfile
import urllib.request
from pathlib import Path, PurePosixPath


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(path, algorithm="sha256"):
    result = hashlib.new(algorithm)
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.digest()


def verified(path, expected):
    require(stat.S_ISREG(path.lstat().st_mode), "Input must be a regular file")
    if "bytes" in expected:
        require(path.stat().st_size == expected["bytes"], "Input size mismatch")
    if "sha256" in expected:
        require(digest(path).hex() == expected["sha256"], "Input hash mismatch")
    if "integrity" in expected:
        actual = "sha512-" + base64.b64encode(digest(path, "sha512")).decode()
        require(actual == expected["integrity"], "Input integrity mismatch")
    return path


def download(item, cache):
    # The manifest supplies immutable HTTPS coordinates and independent digests.
    require(item["url"].startswith("https://"), "Build inputs require HTTPS")
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / hashlib.sha256(item["url"].encode()).hexdigest()
    if not target.exists() and not target.is_symlink():
        descriptor, name = tempfile.mkstemp(prefix=target.name + ".pending-", dir=cache)
        temporary = Path(name)
        try:
            with os.fdopen(descriptor, "wb") as output, urllib.request.urlopen(item["url"], timeout=90) as response:
                require(response.url.startswith("https://"), "Insecure redirect")
                total = 0
                for chunk in iter(lambda: response.read(1024 * 1024), b""):
                    total += len(chunk)
                    require(total <= 512 * 1024 * 1024, "Oversized archive")
                    output.write(chunk)
            verified(temporary, item)
            try:
                os.link(temporary, target)
            except FileExistsError:
                pass  # Verify the winner below; never replace another cached input.
        finally:
            temporary.unlink(missing_ok=True)
    return verified(target, item)


def member_bytes(tar, name):
    matches = [entry for entry in tar.getmembers() if entry.name == name]
    require(len(matches) == 1 and matches[0].isfile(), "Invalid archive member")
    with tar.extractfile(matches[0]) as stream:
        return stream.read()


def package_member(archive, item):
    with tarfile.open(archive, "r:gz") as tar:
        metadata = json.loads(member_bytes(tar, "package/package.json"))
        require(metadata["name"] == item["name"] and
                metadata["version"] == item["version"], "Wrong input package")
        return member_bytes(tar, item["member"])


def compiler(item, target, cache):
    if not target.exists() and not target.is_symlink():
        archive = download({k: item[k] for k in ("url", "integrity")}, cache)
        raw = package_member(archive, item)
        require(len(raw) == item["bytes"] and hashlib.sha256(raw).hexdigest() ==
                item["sha256"], "Compiler executable mismatch")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
        target.chmod(0o755)
    return verified(target, {k: item[k] for k in ("bytes", "sha256")})


def extract_source(archive, destination, prefix):
    # Write regular files ourselves; never let tar links redirect later writes.
    links = []
    with tarfile.open(archive, "r:gz") as tar:
        for entry in tar.getmembers():
            path = PurePosixPath(entry.name)
            require(not path.is_absolute() and path.parts[0] == prefix and
                    ".." not in path.parts, "Unsafe source member")
            target = destination.joinpath(*path.parts[1:])
            if entry.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif entry.isfile():
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open("xb") as output, tar.extractfile(entry) as source:
                    shutil.copyfileobj(source, output)
                target.chmod(0o755 if entry.mode & 0o111 else 0o644)
            elif entry.issym():
                links.append((target, entry.linkname))
            else:
                require(False, "Unsupported source link or special file")
    for target, link in links:
        resolved = (target.parent / link).resolve()
        require(not Path(link).is_absolute() and destination.resolve() in resolved.parents
                and resolved.exists(), "Unsafe source symlink")
        target.symlink_to(link)


def catalog(item, cache, target):
    archive = download({k: item[k] for k in ("url", "integrity")}, cache)
    raw = package_member(archive, item)
    require(hashlib.sha256(raw).hexdigest() == item["snapshotSha256"], "Catalog snapshot mismatch")
    script = raw.decode("utf8")
    prefix = "// Generated by script/generate.ts. Do not edit; run `bun run generate` in packages/sdk.\nconst data = /* @__PURE__ */ JSON.parse("
    suffix = ')\nexport const providers = data.providers\nexport const models = data.models\nexport const generatedAt = "2026-09-13T05:27:48.522Z"\nexport default data\n'
    require(script.startswith(prefix) and script.endswith(suffix), "Unexpected catalog wrapper")
    # Parse the string literal and payload as JSON; never evaluate JavaScript.
    data = json.loads(json.loads(script[len(prefix):-len(suffix)]))
    target.write_bytes(json.dumps(data["providers"], ensure_ascii=False, separators=(",", ":")).encode())
    return verified(target, {"sha256": item["providersSha256"]})
