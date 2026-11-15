#!/usr/bin/env python3
"""Run host checks and report whether a Windows target is actually available."""
from __future__ import annotations
import json, shutil, subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def command(*args: str) -> tuple[int, str]:
    try:
        p = subprocess.run(args, cwd=ROOT, text=True, capture_output=True, timeout=900)
        return p.returncode, (p.stdout + p.stderr).strip()
    except (OSError, subprocess.TimeoutExpired) as e:
        return 127, str(e)

def main() -> int:
    code, output = command("cargo", "check", "--offline", "--locked", "--manifest-path", "src-tauri/Cargo.toml")
    gates = [{"name": "host-cargo-check", "status": "PASS" if code == 0 else "FAIL", "detail": output[-2000:]}]
    targets = command("rustup", "target", "list", "--installed")[1].splitlines()
    if "x86_64-pc-windows-msvc" in targets:
        wcode, wout = command("cargo", "check", "--offline", "--locked", "--target", "x86_64-pc-windows-msvc", "--manifest-path", "src-tauri/Cargo.toml")
        gates.append({"name": "windows-cargo-check", "status": "PASS" if wcode == 0 else "FAIL", "detail": wout[-2000:]})
    else:
        gates.append({"name": "windows-cargo-check", "status": "UNVERIFIED", "detail": "x86_64-pc-windows-msvc target is not installed"})
    print(json.dumps({"schema": 1, "gates": gates, "release_claim_allowed": all(g["status"] == "PASS" for g in gates)}, ensure_ascii=False, indent=2))
    return 1 if any(g["status"] == "FAIL" for g in gates) else 0

if __name__ == "__main__":
    raise SystemExit(main())
