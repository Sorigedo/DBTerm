#!/usr/bin/env python3
"""Inspect local signing/bundle prerequisites; never signs or contacts a service."""
from __future__ import annotations
import json, os, platform, shutil, subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def main() -> int:
    bundle = ROOT / "src-tauri" / "target" / "release" / "bundle"
    app = bundle / "macos" / "DBTerm.app"
    binary = app / "Contents" / "MacOS" / "DBTerm"
    metadata_ok = app.is_dir() and binary.is_file() and (app / "Contents" / "Info.plist").is_file()
    gates = [{"name": "release-bundle", "status": "PASS" if metadata_ok else "UNVERIFIED", "detail": str(app)}]
    if metadata_ok and platform.system() == "Darwin":
        try:
            verified = subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], capture_output=True, text=True, timeout=20)
            gates.append({"name": "bundle-signature", "status": "PASS" if verified.returncode == 0 else "UNVERIFIED", "detail": (verified.stdout + verified.stderr).strip() or "codesign verification"})
        except (OSError, subprocess.TimeoutExpired) as exc:
            gates.append({"name": "bundle-signature", "status": "UNVERIFIED", "detail": str(exc)})
    if platform.system() == "Darwin":
        gates.append({"name": "codesign", "status": "PASS" if shutil.which("codesign") else "UNVERIFIED", "detail": "codesign tool"})
        configured = bool(os.getenv("DBTERM_SIGN_IDENTITY") and os.getenv("DBTERM_NOTARY_PROFILE"))
        gates.append({"name": "mac-signing-config", "status": "PASS" if configured else "UNVERIFIED", "detail": "DBTERM_SIGN_IDENTITY + DBTERM_NOTARY_PROFILE"})
    else:
        gates.append({"name": "mac-signing-config", "status": "DEFERRED", "detail": "requires macOS signing host"})
    gates.append({"name": "upgrade-fixture", "status": "UNVERIFIED", "detail": "requires two signed installers and isolated OS account"})
    allowed = all(g["status"] == "PASS" for g in gates)
    print(json.dumps({"schema": 1, "gates": gates, "release_allowed": allowed, "side_effects": "none"}, ensure_ascii=False, indent=2))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
