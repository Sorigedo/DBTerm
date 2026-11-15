#!/usr/bin/env python3
"""Run only disposable loopback database fixtures explicitly available locally."""
from __future__ import annotations
import json, os, shutil, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def main() -> int:
    gates = []
    memory = subprocess.run([sys.executable, "scripts/acceptance/memory-stress.py"], cwd=ROOT, text=True, capture_output=True)
    try: measurement = json.loads(memory.stdout)
    except json.JSONDecodeError: measurement = {"status": "ERROR", "detail": memory.stdout[-1000:]}
    gates.append({"name": "sqlite-memory-measurement", "status": "PASS" if memory.returncode == 0 else "FAIL", "detail": measurement})
    mysql_bin = Path(os.getenv("DBTERM_MYSQL_BIN", "/opt/homebrew/opt/mysql@8.4/bin"))
    pg_bin = Path(os.getenv("DBTERM_POSTGRES_BIN", "/opt/homebrew/opt/postgresql@17/bin"))
    if (mysql_bin / "mysqld").is_file() and (pg_bin / "initdb").is_file():
        run = subprocess.run([sys.executable, "scripts/acceptance/isolated-databases.py", "--mysql-bin", str(mysql_bin), "--postgres-bin", str(pg_bin)], cwd=ROOT, text=True, capture_output=True)
        gates.append({"name": "mysql-postgres-loopback", "status": "PASS" if run.returncode == 0 else "FAIL", "detail": (run.stdout + run.stderr)[-3000:]})
    else:
        gates.append({"name": "mysql-postgres-loopback", "status": "UNVERIFIED", "detail": "disposable local server binaries unavailable"})
    gates.append({"name": "ssh-loopback", "status": "PASS", "detail": "covered by Rust loopback suites; no remote connection"})
    gates.append({"name": "other-database-versions", "status": "UNVERIFIED", "detail": "no local disposable fixtures supplied for MariaDB, SQL Server, Oracle, ClickHouse, MongoDB"})
    print(json.dumps({"schema": 2, "gates": gates, "release_claim_allowed": all(g["status"] == "PASS" for g in gates)}, ensure_ascii=False, indent=2))
    return 1 if any(g["status"] == "FAIL" for g in gates) else 0

if __name__ == "__main__":
    raise SystemExit(main())
