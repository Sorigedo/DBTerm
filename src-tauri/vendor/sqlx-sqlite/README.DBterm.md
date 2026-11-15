# DBterm SQLx SQLite compatibility patch

This is the unmodified `sqlx-sqlite` 0.8.6 crate source distributed under its
upstream MIT OR Apache-2.0 licenses. The only source manifest change is to
allow `libsqlite3-sys` 0.39.1, so SQLx 0.8.6 can use SQLite 3.54.1 while the
application avoids the unrelated SQLx 0.9 API and MSRV migration.

The version change was validated with `cargo check --locked`, the full Rust
test suite, and a runtime test that checks the linked SQLite library version.
Revisit this patch when upgrading SQLx; remove it once upstream accepts a
compatible `libsqlite3-sys` range.
