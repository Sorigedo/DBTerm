#!/usr/bin/env python3
"""Bounded SQLite result-buffer measurement; this is not a whole-app RSS claim."""
from __future__ import annotations
import gc, json, os, resource, sqlite3, tempfile

def rss() -> int:
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(value * (1024 if os.uname().sysname != "Darwin" else 1))

def main() -> int:
    start = rss(); peak = start; last = start
    with tempfile.NamedTemporaryFile(suffix=".db") as f:
        db = sqlite3.connect(f.name)
        db.execute("create table t (id integer primary key, payload blob)")
        for round_no in range(32):
            db.executemany("insert into t(payload) values (?)", [(os.urandom(64 * 1024),) for _ in range(64)])
            db.commit()
            rows = db.execute("select payload from t order by id desc limit 256").fetchall()
            del rows
            gc.collect()
            last = rss(); peak = max(peak, last)
        db.close()
    result = {"schema": 1, "rss_start": start, "rss_peak": peak, "rss_last": last, "rss_growth": peak - start, "status": "MEASURED", "workload": {"rounds": 32, "blob_bytes_per_round": 64 * 64 * 1024, "maximum_rows_per_query": 256}, "interpretation": "measurement only; no threshold, long-running or whole-app RSS claim"}
    print(json.dumps(result, indent=2))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
