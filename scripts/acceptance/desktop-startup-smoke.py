#!/usr/bin/env python3
"""Start the locally built Tauri binary with an isolated HOME and stop it cleanly."""
from __future__ import annotations
import json, os, signal, subprocess, tempfile, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BINARY = ROOT / "src-tauri" / "target" / "debug" / "DBTerm"

def main() -> int:
    if not BINARY.is_file():
        print(json.dumps({"status": "UNVERIFIED", "detail": "debug Tauri binary is not built"}, ensure_ascii=False))
        return 0
    home = Path(tempfile.mkdtemp(prefix="dbterm-desktop-home-"))
    env = {k: v for k, v in os.environ.items() if k not in {"HOME", "DBTERM_HOME"}}
    env["HOME"] = str(home)
    proc = subprocess.Popen([str(BINARY)], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    time.sleep(8)
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
    output = proc.stdout.read()[-4000:] if proc.stdout else ""
    clean_exit = proc.returncode in (0, -signal.SIGTERM)
    print(json.dumps({"status": "PASS" if clean_exit else "FAIL", "returncode": proc.returncode, "temporary_home": str(home), "scope": "local debug binary; isolated HOME; no saved credentials", "output_tail": output}, ensure_ascii=False, indent=2))
    return 0 if clean_exit else 1

if __name__ == "__main__":
    raise SystemExit(main())
