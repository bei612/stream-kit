"""Verify an Android release candidate and produce a source-bound download inventory."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[2]
PROJECT = ROOT / "third_party/moonlight-android"
APK = PROJECT / "app/build/outputs/apk/nonRoot/release/app-nonRoot-release.apk"
OUTPUT = ROOT / "artifacts/android-release"


def run(*args):
    return subprocess.check_output([str(arg) for arg in args], cwd=ROOT, text=True, encoding="utf-8")


def sha(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


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
    OUTPUT.mkdir(parents=True, exist_ok=True)
    artifact = OUTPUT / f"stream-kit-android-{version}.apk"
    shutil.copy2(APK, artifact)
    shutil.copy2(inventory, OUTPUT / "runtime-dependencies.json")
    (OUTPUT / "SHA256SUMS.txt").write_text(f"{sha(artifact)}  {artifact.name}\n", encoding="utf-8")
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
    for name, source in {
        "MOONLIGHT-ANDROID.txt": PROJECT / "LICENSE.txt",
        "MOONLIGHT-COMMON-C.txt": PROJECT / "app/src/main/jni/moonlight-core/moonlight-common-c/LICENSE.txt",
        "ENET.txt": PROJECT / "app/src/main/jni/moonlight-core/moonlight-common-c/enet/LICENSE",
        "NANORS.txt": PROJECT / "app/src/main/jni/moonlight-core/moonlight-common-c/nanors/LICENSE",
        "WEBRTC.md": PROJECT / "app/src/main/assets/licenses/WEBRTC.md",
    }.items():
        shutil.copy2(source, notices / name)
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
    print(json.dumps({"artifact": artifact.name, "sha256": report["apk_sha256"], "source_commit": source_commit}))


if __name__ == "__main__":
    main()
