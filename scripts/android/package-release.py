"""Verify an Android release candidate and produce a source-bound download inventory."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import zipfile
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[2]
PROJECT = ROOT / "third_party/moonlight-android"
APK = PROJECT / "app/build/outputs/apk/nonRoot/release/app-nonRoot-release.apk"
OUTPUT = ROOT / "artifacts/android-release"


def run(*args):
    return subprocess.check_output([str(arg) for arg in args], cwd=ROOT, text=True, encoding="utf-8")


def sha(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def verify_dependency_inventory(root, archive, runtime):
    """Fail closed on an unreviewed runtime, native archive or changed/missing notice."""
    manifest = json.loads((root / "third_party-manifests/android-notices.json").read_text(encoding="utf-8"))
    pinned = {item["coordinate"]: item for item in manifest["runtime_dependencies"]}
    resolved = {item["coordinate"]: item for item in runtime["dependencies"]}
    if len(pinned) != len(manifest["runtime_dependencies"]) or len(resolved) != len(runtime["dependencies"]) or pinned.keys() != resolved.keys():
        raise RuntimeError("Release dependency set differs from reviewed inventory")
    notices = {item["name"]: item for item in manifest["notices"]}
    for coordinate, item in pinned.items():
        if item["sha256"] != resolved[coordinate]["sha256"] or item["notice"] not in notices:
            raise RuntimeError(f"Unreviewed dependency bytes/notice: {coordinate}")
    for item in manifest["notices"]:
        if sha(root / item["path"]) != item["sha256"] or hashlib.sha256(archive.read("assets/licenses/" + item["name"])).hexdigest() != item["sha256"]:
            raise RuntimeError(f"Missing or changed distribution notice: {item['name']}")
    for item in manifest["native_archives"]:
        if sha(root / item["path"]) != item["sha256"] or item["notice"] not in notices:
            raise RuntimeError(f"Unreviewed native archive: {item['path']}")
    return manifest


def write_sbom(output, manifest, version, source_commit, apk_hash):
    """Conservative build-input inventory; does not invent the transitive dependency graph."""
    components = []
    for item in manifest["runtime_dependencies"]:
        group, name, dependency_version = item["coordinate"].split(":")
        purl = f"pkg:maven/{quote(group, safe='.')}/{quote(name, safe='')}@{quote(dependency_version, safe='')}"
        components.append({"type": "library", "bom-ref": purl, "group": group, "name": name,
                           "version": dependency_version, "purl": purl,
                           "hashes": [{"alg": "SHA-256", "content": item["sha256"]}],
                           "licenses": [{"license": {"name": "See licenses/" + item["notice"]}}]})
    for item in manifest["native_archives"]:
        components.append({"type": "file", "bom-ref": "source:" + item["path"], "name": item["path"],
                           "hashes": [{"alg": "SHA-256", "content": item["sha256"]}],
                           "licenses": [{"license": {"name": "See licenses/" + item["notice"]}}],
                           "properties": [{"name": "stream-kit:abi", "value": item["abi"]},
                                          {"name": "stream-kit:embedded-version-observation", "value": item["version_observation"]}]})
    source_manifest = json.loads((ROOT / "third_party-manifests/moonlight-android.json").read_text(encoding="utf-8"))
    for item in source_manifest["components"]:
        components.append({"type": "library", "bom-ref": "upstream:" + item["name"], "name": item["name"],
                           "version": item["commit"], "externalReferences": [{"type": "vcs", "url": item["repository"]}],
                           "properties": [{"name": "stream-kit:source-path", "value": item["path"]},
                                          {"name": "stream-kit:upstream-archive-sha256", "value": item["archive_sha256"]}]})
    root_ref = "stream-kit-android:" + version
    report = {"bomFormat": "CycloneDX", "specVersion": "1.5", "version": 1,
              "metadata": {"component": {"type": "application", "bom-ref": root_ref,
                           "name": "Stream Kit Android", "version": version,
                           "hashes": [{"alg": "SHA-256", "content": apk_hash}]},
                           "properties": [{"name": "stream-kit:source-commit", "value": source_commit},
                                          {"name": "stream-kit:inventory-scope", "value": "Resolved JVM build inputs, imported static archives and upstream source snapshots. R8 may remove code; no claim of reconstructed transitive graph or local native archive rebuild."}]},
              "components": components,
              "dependencies": [{"ref": root_ref, "dependsOn": [item["bom-ref"] for item in components]}]}
    (output / "sbom.cdx.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


def write_distribution(output, artifact):
    """Produce portable download assets from the already verified candidate files."""
    files = sorted(file for file in output.rglob("*") if file.is_file())
    archive_path = output / "distribution.zip"
    with zipfile.ZipFile(archive_path, "x", compression=zipfile.ZIP_DEFLATED) as archive:
        for file in files:
            archive.write(file, arcname=file.relative_to(output).as_posix())
    downloads = [archive_path, artifact, output / "provenance.json", output / "sbom.cdx.json"]
    (output / "DOWNLOAD-SHA256SUMS.txt").write_text("".join(
        f"{sha(file)}  {file.name}\n" for file in downloads), encoding="utf-8")


def main():
    version = os.environ["RELEASE_VERSION"]
    code = os.environ["RELEASE_CODE"]
    identity = json.loads((ROOT / "third_party-manifests/android-signing.json").read_text(encoding="utf-8"))
    expected = re.sub(r"[\s:]", "", identity["certificate_sha256"]).lower()
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?", version):
        raise ValueError("Invalid release version")
    if not re.fullmatch(r"[1-9][0-9]{0,8}", code) or not re.fullmatch(r"[0-9a-f]{64}", expected):
        raise ValueError("Invalid release code or signing fingerprint")
    if run("git", "status", "--porcelain").strip():
        raise RuntimeError("Release inventory requires committed, clean source")
    source_commit = run("git", "rev-parse", "HEAD").strip()
    sdk = Path(os.environ["ANDROID_HOME"])
    java = Path(os.environ["JAVA_HOME"]) / "bin" / ("java.exe" if os.name == "nt" else "java")
    build_tools = sdk / "build-tools/37.0.0"
    signature = run(java, "-jar", build_tools / "lib/apksigner.jar", "verify", "--verbose", "--print-certs", APK)
    signers = re.findall(r"(?:Signer #\d+|V[0-9.]+ Signer):? certificate SHA-256 digest: ([0-9a-f]+)", signature, re.I)
    if set(value.lower() for value in signers) != {expected} or "Number of signers: 1" not in signature or "Verified using v2 scheme (APK Signature Scheme v2): true" not in signature:
        raise RuntimeError("APK does not match the persistent project signing identity")
    aapt = build_tools / ("aapt2.exe" if os.name == "nt" else "aapt2")
    manifest = run(aapt, "dump", "badging", APK)
    required = f"package: name='io.github.bei612.streamkit' versionCode='{code}' versionName='{version}'"
    if required not in manifest or "application-debuggable" in manifest:
        raise RuntimeError("Wrong application identity/version or debuggable production APK")
    with zipfile.ZipFile(APK) as archive:
        names = archive.namelist()
        build = json.loads(archive.read('assets/stream-kit-build.json'))
        if build != {"version": version, "version_code": int(code), "source_commit": source_commit, "source_dirty": False}:
            raise RuntimeError("APK source identity does not match this clean checkout")
        if any(name.startswith(("assets/test/", "assets/example/", "assets/debug/")) or name.endswith((".p12", ".jks", ".dpapi")) for name in names):
            raise RuntimeError("Development content or signing material found in APK")
        media = json.loads((ROOT / "third_party-manifests/android-media.json").read_text(encoding="utf-8"))
        if hashlib.sha256(archive.read("assets/licenses/WEBRTC.md")).hexdigest() != media["notice_sha256"]:
            raise RuntimeError("Native WebRTC notices do not match the pinned dependency")
        native = [{"path": name, "sha256": hashlib.sha256(archive.read(name)).hexdigest()}
                  for name in sorted(names) if name.startswith("lib/") and name.endswith(".so")]
    inventory = PROJECT / "app/build/reports/stream-kit-runtime-dependencies.json"
    runtime = json.loads(inventory.read_text(encoding="utf-8"))
    if any(re.search(r"mockwebserver|(^|:)junit:|androidx\.test", item["coordinate"]) for item in runtime["dependencies"]):
        raise RuntimeError("Test dependency present in release runtime configuration")
    with zipfile.ZipFile(APK) as archive:
        dependencies = verify_dependency_inventory(ROOT, archive, runtime)
    if OUTPUT.exists() and any(OUTPUT.iterdir()):
        raise RuntimeError("Release output must be empty; refusing to mix artifacts from different builds")
    OUTPUT.mkdir(parents=True, exist_ok=True)
    artifact = OUTPUT / f"stream-kit-android-{version}.apk"
    shutil.copy2(APK, artifact)
    shutil.copy2(inventory, OUTPUT / "runtime-dependencies.json")
    shutil.copy2(ROOT / "third_party-manifests/android-notices.json", OUTPUT / "dependency-notices.json")
    write_sbom(OUTPUT, dependencies, version, source_commit, sha(artifact))
    source_url = f"https://github.com/bei612/stream-kit/tree/{source_commit}/third_party/moonlight-android"
    report = {"schema_version": 1, "kind": "signed-release-candidate", "version": version,
              "version_code": int(code), "application_id": "io.github.bei612.streamkit",
              "source_commit": source_commit, "source_url": source_url, "apk_sha256": sha(artifact),
              "signing_certificate_sha256": expected, "native_libraries": native,
              "runtime_dependencies": runtime["dependencies"],
              "acceptance": "Signature and packaging checks only; not media or production acceptance"}
    (OUTPUT / "provenance.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    notices = OUTPUT / "licenses"
    notices.mkdir(exist_ok=True)
    for item in dependencies["notices"]:
        shutil.copy2(ROOT / item["path"], notices / item["name"])
    (OUTPUT / "README.txt").write_text(
        f"Stream Kit Android {version}\n\n"
        "Signed candidate; this artifact is not a completed production acceptance claim.\n"
        "Install the APK, import the administrator's HTTPS /watch#key=... link and connect.\n"
        "For private LAN TLS, install the administrator's CA certificate through Android settings.\n"
        "HTTP and certificate-error bypasses are unavailable in the release application.\n"
        "Viewer input and microphone remain disabled until an administrator grants control.\n"
        "Recording requires an explicit gesture and Android permission; backgrounding releases it.\n"
        "Preserve the release signing identity and increase versionCode for subsequent upgrades.\n"
        f"Corresponding source: {source_url}\n"
        "Native upstream archive provenance and other dependencies are recorded in third_party-manifests.\n",
        encoding="utf-8")
    (OUTPUT / "SHA256SUMS.txt").write_text("".join(
        f"{sha(file)}  {file.relative_to(OUTPUT).as_posix()}\n"
        for file in sorted(OUTPUT.rglob("*")) if file.is_file() and file.name != "SHA256SUMS.txt"), encoding="utf-8")
    write_distribution(OUTPUT, artifact)
    print(json.dumps({"artifact": artifact.name, "sha256": report["apk_sha256"], "source_commit": source_commit}))


if __name__ == "__main__":
    main()
