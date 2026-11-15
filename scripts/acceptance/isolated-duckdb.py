#!/usr/bin/env python3
"""Verify the pinned project driver archive, then run native DuckDB regressions locally.

Downloads only to a fresh temporary directory. Never uses installed app data,
saved connections or user database files. SHA256 is read from source registry.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import tempfile
import urllib.request
import zipfile


def main():
    if platform.system() != "Darwin":
        raise RuntimeError("this runner currently verifies the pinned macOS universal driver")
    repository = Path(__file__).resolve().parents[2]
    registry = (repository / "src-tauri/src/commands/driver/mod.rs").read_text()
    match = re.search(r'mac_arm64: Some\(PlatformDownload\s*\{\s*url: "([^"]*libduckdb-osx-universal.zip)".into\(\),\s*sha256: "([0-9a-f]{64})"', registry)
    if match is None:
        raise RuntimeError("no pinned macOS DuckDB archive found in project registry")
    url, expected = match.groups()
    if not url.startswith("https://github.com/duckdb/duckdb/releases/download/"):
        raise RuntimeError("driver source is not the official pinned release")
    fixture = Path(tempfile.mkdtemp(prefix="dbterm-isolated-duckdb-"))
    receipt = {"fixture": str(fixture), "url": url, "expected_archive_sha256": expected,
               "scope": "temporary native library; test-owned memory and UUID database files only",
               "exit_code": None, "library_removed": False}
    print(json.dumps(receipt), flush=True)
    try:
        archive = fixture / "driver.zip"
        with urllib.request.urlopen(url, timeout=60) as response, archive.open("wb") as output:
            shutil.copyfileobj(response, output, 1024 * 1024)
        actual = hashlib.sha256(archive.read_bytes()).hexdigest()
        receipt["archive_sha256"] = actual
        if actual != expected:
            raise RuntimeError("driver archive checksum mismatch; refusing native execution")
        library = fixture / "libduckdb.dylib"
        with zipfile.ZipFile(archive) as package:
            candidates = [name for name in package.namelist() if Path(name).name == library.name]
            if len(candidates) != 1:
                raise RuntimeError("ambiguous native library in archive")
            with package.open(candidates[0]) as source, library.open("wb") as output:
                shutil.copyfileobj(source, output)
        receipt["library_sha256"] = hashlib.sha256(library.read_bytes()).hexdigest()
        environment = {key: value for key, value in os.environ.items() if not key.startswith("DBTERM_")}
        environment["DBTERM_TEST_DUCKDB_LIBRARY"] = str(library)
        filters = [
            ("commands::duckdb::", True),
            ("commands::db_extra::duck_import_native_tests::", True),
            (None, False),  # complete non-ignored Rust library suite after focused native checks
        ]
        results = []
        with (fixture / "tests.log").open("w") as output:
            for test_filter, ignored in filters:
                output.write(f"=== {test_filter or 'complete Rust library suite'} ===\n")
                output.flush()
                command = ["cargo", "test", "--manifest-path", "src-tauri/Cargo.toml", "--offline", "--lib"]
                if test_filter:
                    command.append(test_filter)
                command.extend(["--", "--test-threads=1", "--nocapture"])
                if ignored:
                    command.append("--ignored")
                run = subprocess.run(command, cwd=repository, env=environment,
                    stdout=output, stderr=subprocess.STDOUT, timeout=300)
                results.append({"filter": test_filter or "all", "ignored_only": ignored, "exit_code": run.returncode})
                if run.returncode != 0:
                    break
        receipt["tests"] = results
        receipt["exit_code"] = next((result["exit_code"] for result in results if result["exit_code"] != 0), 0)
    finally:
        for artifact in [fixture / "libduckdb.dylib", fixture / "driver.zip"]:
            artifact.unlink(missing_ok=True)
        receipt["library_removed"] = not (fixture / "libduckdb.dylib").exists()
        (fixture / "result.json").write_text(json.dumps(receipt, indent=2) + "\n")
        print(json.dumps(receipt), flush=True)
    if receipt["exit_code"] != 0:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
