# DBterm SQLx PostgreSQL patch

Base: crates.io sqlx-postgres 0.8.6, copied from the installed Cargo registry.
Upstream MIT and Apache-2.0 licenses are retained in this directory.

Changed upstream files: connection/mod.rs, connection/establish.rs,
connection/stream.rs, connection/tls.rs, lib.rs, message/mod.rs;
added message/cancel_request.rs.

- Retain original endpoint/TLS options after authentication; clear password.
- Expose an opaque backend PID + secret cancellation capability with redacted Debug.
- Send CancelRequest using the existing transport/TLS implementation.
- Record actual TLS negotiation; encrypted Prefer sessions require TLS for
  cancellation. Certificate verification modes remain unchanged.
- No unsafe access, PID-only SQL termination or user SQL rewrite.

The application never polls arbitrary query work again after cancellation.
It discards the original connection and reports an unconfirmed server stop/write
outcome. Packet transmission is not acknowledgement and cannot undo a commit.
Private PostgreSQL 17 loopback tests cover a running long query and release of
earlier transaction locks. Proxies, DNS changes, TLS configurations and other
server versions require separate verification.

Upgrades must rebase this patch against the exact new upstream source and rerun
wire encoding, cancellation race, real-server and transport tests. The path patch
exposes three upstream dead-code warnings suppressed for registry dependencies.
