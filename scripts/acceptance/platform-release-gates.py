#!/usr/bin/env python3
"""Report platform release prerequisites without contacting external services."""
from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
from pathlib import Path


def run(*args: str) -> str | None:
    try:
        return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT, timeout=10).strip()
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--local-only", action="store_true")
    parser.add_argument("--require-release", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    targets = run("rustup", "target", "list", "--installed") or ""
    windows_target = "x86_64-pc-windows-msvc" in targets.splitlines()
    gates = [
        {"name": "host", "status": "PASS", "detail": platform.platform()},
        {"name": "cargo", "status": "PASS" if run("cargo", "--version") else "UNVERIFIED", "detail": run("cargo", "--version")},
        {"name": "windows-target", "status": "PASS" if windows_target else "UNVERIFIED", "detail": targets or "target unavailable"},
        {"name": "container-runtime", "status": "PASS" if (shutil.which("docker") or shutil.which("podman")) else "UNVERIFIED", "detail": "docker/podman"},
    ]
    if platform.system() == "Darwin":
        gates.append({"name": "codesign-tool", "status": "PASS" if shutil.which("codesign") else "UNVERIFIED", "detail": "codesign"})
        gates.append({"name": "apple-signing-input", "status": "PASS" if os.getenv("DBTERM_SIGN_IDENTITY") and os.getenv("DBTERM_NOTARY_PROFILE") else "UNVERIFIED", "detail": "explicit env only"})
    else:
        gates.append({"name": "apple-signing-input", "status": "DEFERRED", "detail": "non-macOS host"})
    release_allowed = all(g["status"] == "PASS" for g in gates)
    if args.require_release and not release_allowed:
        return_code = 1
    else:
        return_code = 0
    print(json.dumps({"schema": 1, "root": str(root), "local_only": args.local_only, "release_claim_allowed": release_allowed, "gates": gates}, ensure_ascii=False, indent=2))
    return return_code


if __name__ == "__main__":
    raise SystemExit(main())
