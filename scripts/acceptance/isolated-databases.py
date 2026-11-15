#!/usr/bin/env python3
"""Run explicit ignored DB regressions against self-created loopback instances.

No installed desktop app, saved connection or user database is accessed.
Requires local MySQL 8.4, PostgreSQL 17 and openssl executables. Creates
ephemeral TLS certificates; DuckDB native fixtures remain excluded.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time


def unused_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mysql-bin", type=Path, default=Path("/opt/homebrew/opt/mysql@8.4/bin"))
    parser.add_argument("--postgres-bin", type=Path, default=Path("/opt/homebrew/opt/postgresql@17/bin"))
    parser.add_argument("--grid-payload", type=Path, help="captured isolated TableBrowser fixture JSON")
    args = parser.parse_args()
    for executable in [args.mysql_bin / "mysqld", args.mysql_bin / "mysqladmin", args.postgres_bin / "initdb", args.postgres_bin / "pg_ctl"]:
        if not executable.is_file():
            raise RuntimeError(f"required local executable missing: {executable}")
    repository = Path(__file__).resolve().parents[2]
    fixture = Path(tempfile.mkdtemp(prefix="dbterm-isolated-databases-"))
    mysql_port, pg_port = unused_port(), unused_port()
    while mysql_port == pg_port:
        pg_port = unused_port()
    environment = {key: value for key, value in os.environ.items() if not key.startswith("DBTERM_")}
    if args.grid_payload is not None:
        payload = args.grid_payload.resolve(strict=True)
        if not payload.parent.name.startswith("dbterm-grid-contract-"):
            raise RuntimeError("grid payload must belong to the isolated component fixture")
        environment["DBTERM_GRID_COMPONENT_PAYLOAD"] = str(payload)
    environment.update({
        "DBTERM_TEST_MYSQL_PORT": str(mysql_port),
        "DBTERM_TEST_MYSQL_URL": f"mysql://root@127.0.0.1:{mysql_port}/mysql",
        "DBTERM_DRAFT_MYSQL_URL": f"mysql://root@127.0.0.1:{mysql_port}/mysql",
        "DBTERM_EXPORT_TEST_URL": f"mysql://root@127.0.0.1:{mysql_port}/mysql",
        "DBTERM_TEST_PG_PORT": str(pg_port),
        "DBTERM_TEST_PG_DATA_DIR": str(fixture / "postgres"),
        "DBTERM_TEST_PG_TLS_ROOT": str(fixture / "ca.crt"),
        "DBTERM_DRAFT_PG_URL": f"postgres://postgres@127.0.0.1:{pg_port}/postgres",
    })
    mysql = None
    pg_started = False
    pg_stopped = True
    result = {"fixture": str(fixture), "mysql_port": mysql_port, "postgres_port": pg_port,
              "scope": "new temporary data directories; loopback only; no desktop app",
              "excluded": ["DuckDB native library (6)"],
              "exit_code": None, "stopped": False}
    print(json.dumps(result), flush=True)
    with (fixture / "services.log").open("w") as services:
        try:
            subprocess.run([str(args.mysql_bin / "mysqld"), "--no-defaults", "--initialize-insecure",
                            f"--datadir={fixture / 'mysql'}"], stdout=services, stderr=subprocess.STDOUT, check=True, timeout=60)
            mysql = subprocess.Popen([str(args.mysql_bin / "mysqld"), "--no-defaults",
                f"--datadir={fixture / 'mysql'}", "--bind-address=127.0.0.1", f"--port={mysql_port}",
                f"--socket={fixture / 'mysql.sock'}", f"--pid-file={fixture / 'mysql.pid'}", "--mysqlx=0"],
                stdout=services, stderr=subprocess.STDOUT)
            for _ in range(150):
                if mysql.poll() is not None:
                    raise RuntimeError("temporary MySQL exited during startup")
                try:
                    with socket.create_connection(("127.0.0.1", mysql_port), timeout=0.2):
                        break
                except OSError:
                    time.sleep(0.1)
            else:
                raise RuntimeError("temporary MySQL startup timed out")
            subprocess.run([str(args.postgres_bin / "initdb"), "-D", str(fixture / "postgres"),
                "-U", "postgres", "--auth=trust", "--no-locale", "--encoding=UTF8"],
                stdout=services, stderr=subprocess.STDOUT, check=True, timeout=60)
            certificate_config = fixture / "certificate.cnf"
            certificate_config.write_text("[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n")
            for name in ["ca", "unrelated"]:
                subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                    "-config", str(certificate_config), "-keyout", str(fixture / f"{name}.key"),
                    "-out", str(fixture / f"{name}.crt")], stdout=services, stderr=subprocess.STDOUT, check=True, timeout=30)
                (fixture / f"{name}.key").chmod(0o600)
            leaf_extensions = fixture / "leaf.cnf"
            leaf_extensions.write_text("""basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:127.0.0.1,DNS:localhost
""")
            subprocess.run(["openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes",
                "-subj", "/CN=localhost", "-keyout", str(fixture / "server.key"), "-out", str(fixture / "server.csr")],
                stdout=services, stderr=subprocess.STDOUT, check=True, timeout=30)
            (fixture / "server.key").chmod(0o600)
            subprocess.run(["openssl", "x509", "-req", "-in", str(fixture / "server.csr"),
                "-CA", str(fixture / "ca.crt"), "-CAkey", str(fixture / "ca.key"), "-CAcreateserial",
                "-out", str(fixture / "server.crt"), "-days", "1", "-extfile", str(leaf_extensions)],
                stdout=services, stderr=subprocess.STDOUT, check=True, timeout=30)
            with (fixture / "postgres" / "postgresql.conf").open("a") as config:
                config.write(f"\nssl=on\nssl_cert_file='{fixture / 'server.crt'}'\nssl_key_file='{fixture / 'server.key'}'\n")
            subprocess.run([str(args.postgres_bin / "pg_ctl"), "-D", str(fixture / "postgres"),
                "-l", str(fixture / "postgres.log"), "-o", f"-h 127.0.0.1 -p {pg_port} -k {fixture}", "-w", "start"],
                stdout=services, stderr=subprocess.STDOUT, check=True, timeout=30)
            pg_started = True
            pg_stopped = False
            command = ["cargo", "test", "--manifest-path", "src-tauri/Cargo.toml", "--offline", "--lib", "--",
                "--ignored", "--test-threads=1", "--nocapture",
                "--skip", "commands::duckdb::",
                "--skip", "commands::db_extra::duck_import_native_tests::"]
            with (fixture / "tests.log").open("w") as output:
                run = subprocess.run(command, cwd=repository, env=environment,
                    stdout=output, stderr=subprocess.STDOUT, timeout=300)
            result["exit_code"] = run.returncode
        finally:
            if pg_started:
                try:
                    stopped = subprocess.run([str(args.postgres_bin / "pg_ctl"), "-D", str(fixture / "postgres"), "-m", "immediate", "-w", "stop"],
                        stdout=services, stderr=subprocess.STDOUT, timeout=30)
                    pg_stopped = stopped.returncode == 0
                except subprocess.TimeoutExpired:
                    pg_stopped = False
            if mysql is not None and mysql.poll() is None:
                try:
                    subprocess.run([str(args.mysql_bin / "mysqladmin"), "--no-defaults", f"--socket={fixture / 'mysql.sock'}", "-u", "root", "shutdown"],
                        stdout=services, stderr=subprocess.STDOUT, timeout=20)
                except subprocess.TimeoutExpired:
                    pass
                try:
                    mysql.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    mysql.terminate()
                    mysql.wait(timeout=10)
            result["stopped"] = pg_stopped and (mysql is None or mysql.poll() is not None)
            (fixture / "result.json").write_text(json.dumps(result, indent=2) + "\n")
            # Preserve logs/receipt, remove only data directories created here.
            if result["stopped"]:
                for directory in [fixture / "mysql", fixture / "postgres"]:
                    if directory.exists():
                        shutil.rmtree(directory)
                for secret in fixture.glob("*.key"):
                    secret.unlink()
            print(json.dumps(result), flush=True)
    if result["exit_code"] != 0 or not result["stopped"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
