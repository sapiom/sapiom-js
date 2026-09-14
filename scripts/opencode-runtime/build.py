"""Build the patched native runtime. This entry point cannot publish artifacts."""
import argparse
import json
import os
import platform
import subprocess
from pathlib import Path
from inputs import catalog, compiler, digest, download, extract_source, require, verified

REPO = Path(__file__).resolve().parents[2]
MANIFEST = REPO / "packages/opencode/native-runtime.json"


def build(work, single=False, download_cache=None):
    require(platform.system() == "Linux" and platform.machine() == "x86_64", "Build on Linux x64")
    manifest = json.loads(MANIFEST.read_text())
    require(subprocess.check_output(["node", "--version"], text=True).strip() ==
            manifest["nodeVersion"], "Use the pinned Node version")
    # A fresh private directory prevents ambient source/cache files from entering the build.
    work.mkdir(parents=True, mode=0o700)
    cache = download_cache or work / "downloads"
    source = work / "source"
    bun = compiler(manifest["hostCompiler"], work / "toolchain/bun", cache)
    require(subprocess.check_output([str(bun), "--revision"], text=True).strip() ==
            manifest["bunRevision"], "Unexpected Bun revision")
    spec = manifest["source"]
    archive = download({k: spec[k] for k in ("url", "sha256")}, cache)
    extract_source(archive, source, "opencode-" + spec["commit"])
    for name, sha in manifest["patches"].items():
        patch = verified(REPO / "patches/opencode" / name, {"sha256": sha})
        subprocess.run(["git", "apply", "--check", str(patch)], cwd=source, check=True)
        subprocess.run(["git", "apply", str(patch)], cwd=source, check=True)
    for name, sha in manifest["patchedFiles"].items():
        verified(source / name, {"sha256": sha})
    verified(source / "packages/opencode/script/build.ts", {"sha256": spec["buildSha256"]})
    providers = catalog(manifest["catalog"], cache, work / "providers.json")
    compilers = work / "compiler-cache"
    for name, item in manifest["crossCompilers"].items():
        compiler(item, compilers / name, cache)
    env = {
        "PATH": str(bun.parent) + os.pathsep + os.environ["PATH"],
        "HOME": str(work / "home"), "TMPDIR": str(work / "tmp"),
        "CI": "1", "LANG": "C.UTF-8",
        "BUN_INSTALL_CACHE_DIR": str(compilers),
        "BUN_COMPILE_TARGET_TARBALL_URL": "http://127.0.0.1:9/unexpected-compiler-download",
        "OPENCODE_VERSION": manifest["runtimeVersion"], "OPENCODE_CHANNEL": "latest",
        "MODELS_DEV_API_JSON": str(providers),
    }
    for name in ("HOME", "TMPDIR"):
        Path(env[name]).mkdir()
    for name in ("HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"):
        if name in os.environ:
            env[name] = os.environ[name]
    # OPENCODE_RELEASE publishes even when its value is "0". Never inherit it.
    require("OPENCODE_RELEASE" not in env, "Publishing environment forbidden")

    def run(*args, cwd=source, overrides=None):
        subprocess.run([str(bun), *args], cwd=cwd, env={**env, **(overrides or {})}, check=True)

    lock = source / "bun.lock"
    verified(lock, {"sha256": spec["lockSha256"]})
    run("install", "--filter", "./packages/opencode", "--frozen-lockfile",
        "--os=*", "--cpu=*", "--ignore-scripts", "--backend", "hardlink",
        overrides={"BUN_INSTALL_CACHE_DIR": str(work / "dependency-cache")})
    verified(lock, {"sha256": spec["lockSha256"]})
    run("test", "test/session/instruction.test.ts", "test/tool/read.test.ts",
        "test/session/llm-request-identity.test.ts", cwd=source / "packages/opencode",
        overrides={"OPENCODE_DISABLE_MODELS_FETCH": "1"})
    # Bun prefers same-named cwd files over its compiler cache. Reject both shadow locations.
    for name, item in manifest["crossCompilers"].items():
        for cwd in (source, source / "packages/opencode"):
            require(not os.path.lexists(cwd / name), "Shadow compiler forbidden")
        verified(compilers / name, {k: item[k] for k in ("sha256", "bytes")})
    run("run", "packages/opencode/script/build.ts", "--skip-install", "--skip-embed-web-ui",
        *(["--single"] if single else []))
    dist = source / "packages/opencode/dist"
    expected = ["opencode-linux-x64"] if single else manifest["platforms"]
    require(sorted(path.name for path in dist.iterdir()) == sorted(expected), "Incomplete platform matrix")
    outputs = {}
    for name in expected:
        package = json.loads((dist / name / "package.json").read_text())
        require(package["name"] == name and package["version"] == manifest["runtimeVersion"], "Wrong platform package")
        binary = dist / name / "bin" / ("opencode.exe" if "windows" in name else "opencode")
        outputs[name] = {"package": package, "binarySha256": digest(binary).hex(), "bytes": binary.stat().st_size}
    proof = {"schemaVersion": 1, "manifestSha256": digest(MANIFEST).hex(),
             "recipeSha256": digest(Path(__file__)).hex(),
             "inputsHelperSha256": digest(Path(__file__).with_name("inputs.py")).hex(), "single": single,
             "node": manifest["nodeVersion"], "bun": manifest["bunRevision"],
             "python": platform.python_version(), "releaseEnvironment": "unset", "outputs": outputs}
    (work / "build-proof.json").write_text(json.dumps(proof, indent=2) + "\n")
    print(json.dumps({"proof": str(work / "build-proof.json"), "platforms": len(outputs)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work-dir", type=Path, required=True, help="New, disposable build directory")
    parser.add_argument("--single", action="store_true", help="Local Linux smoke; not a release matrix")
    parser.add_argument("--download-cache", type=Path, help="Optional archive cache; every reuse is verified")
    args = parser.parse_args()
    build(args.work_dir.absolute(), args.single,
          args.download_cache.absolute() if args.download_cache else None)
