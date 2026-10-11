# NomadCraft

**A Minecraft world that lives between friends.**

Fixed address. Always-on saves. Whoever is online shares the load. Nobody rents a
server, nobody port-forwards, nobody keeps their PC awake so others can play.

> 一个"跑在朋友之间"的 Minecraft 世界：地址不变、存档不断、机器轮着用、没人时自己睡觉。

## Friends-first product scope

NomadCraft is for a trusted group of friends. It does not attempt anti-cheat or adversarial verification of the computer running Minecraft. The center manages access, placement and committed room state; the selected node runs the actual game server. Normal handover saves and stops the old server, commits its complete persistent state, then restores it on the next node. Session-preserving migration is a later enhancement.

Package checks protect download integrity and repair missing/corrupt components; local resources and normal configuration/runtime changes are not cheating. Management authentication and single-writer leases remain necessary for ordinary administration and preventing conflicting saves. See [current product scope](docs/产品愿景.md) and [local data design](docs/本地扩展与运行数据-同步设计.md). This scope is confirmed; relaxed launcher checks and full mod-data migration are still pending implementation.

## KAMUCL NomadCraft desktop client

KAMUCL NC is now the official desktop client for NomadCraft. Its Electron/Vue/TypeScript renderer is the user-facing client; its main process keeps Microsoft accounts, Java, Minecraft files, local networking tools and the local agent on the player machine. NomadCraft servers provide the authenticated control plane, catalog, permissions, compute scheduling, ingress and committed room state. The first Nomad view already connects to a configured backend, logs in with an in-memory session and reads authorized instances.

## The idea

Normally a Minecraft server is tied to one machine: either someone rents a box and
pays for it to idle most of the day, or one friend hosts and the session dies the
moment they close their laptop.

NomadCraft inverts that. The world belongs to the group, not to whichever PC
happens to be running it:

- **The public node can coordinate without running the game.** It knows who is
  hosting, hands out short-lived leases, and forwards bytes. A capable server can
  also run Minecraft as a fixed, scheduled or fallback compute node.
- **The world runs on a player's machine.** Whichever friend is online and best
  suited runs the real server, so big modpacks use the players' hardware.
- **Leaving hands over, it does not end.** When the host quits, the control plane
  elects someone else, moves the latest save across, and players reconnect to the
  same address.
- **Nobody playing means nothing running.** The world sleeps until the next player
  wakes it.

## Status: original Rust MVP is end-to-end

The section below describes the original Rust prototype. The panel-backed agent
now also launches real vanilla Minecraft and supports persistent compute nodes;
see [current implementation](docs/计算节点与网络自检-实现.md).

All three components exist and are wired together. The full path works today:
register a machine, elect a host, upload a world as a checkpoint, and let another
machine pull it back and reconstruct the world byte-for-byte.

| Component | Status | What it does |
| --- | --- | --- |
| `nomad-proto` | done | shared types: ids, epochs, leases, manifests, control messages |
| `nomad-snapshot` | done | content-addressed snapshots, incremental replication, retention |
| `nomad-control-plane` | done | lease engine, scheduler, durable state, HTTP API, world store |
| `nomad-relay` | done | fixed front door: pairs players with a host's outbound tunnel |
| `nomad-agent` | MVP | registers, claims/releases leases, supervises the server, guards the world |

**86 tests pass**, clippy is clean with `-D warnings`, and an end-to-end smoke
test drives the real binaries. What is deliberately **not** wired yet: launching an
actual `server.jar` process (the agent's supervisor models the lifecycle but does
not spawn Java), and multiplexing many rooms through one relay address.

## Design pillars

1. **One host at a time, enforced by leases.** Every handover bumps a monotonic
   *epoch*. Reports stamped with an older epoch are rejected and a host that learns
   a newer epoch exists must stop immediately. Serving a stale world is always worse
   than briefly serving none.
2. **The public node can be tiny.** It coordinates and forwards; it never parses
   Minecraft and never stores world logic.
3. **Worlds are content-addressed.** A snapshot's identity is the BLAKE3 digest of
   its manifest, so manifests are immutable and every chunk is verified on read.
   Splitting is content-defined, so a small edit only uploads the chunks around it.
4. **Durable by default.** A running host periodically pushes the latest save and
   only the changed chunks cross the wire. Retention keeps a recent good version, a
   nightly history, and every manual checkpoint, so a crash costs minutes, not a
   world.
5. **Peers connect outbound.** Machines dial out and hold a connection open, so NAT
   and the absence of a public IP are non-issues.

## Try it

Requires a recent stable Rust toolchain.

```sh
cargo build
cargo test                      # the full suite

# start a control plane
cargo run -p nomad-control-plane -- serve --bind 127.0.0.1:8787 \
    --data-dir .nomad/control-plane

# in another shell, register this machine and ask to host
cargo run -p nomad-agent -- register --control-plane http://127.0.0.1:8787 --name my-pc
cargo run -p nomad-agent -- host --control-plane http://127.0.0.1:8787 --server srv_...
```

On Windows, `pwsh scripts/smoke.ps1` runs the whole flow against the built binaries.

## Repository layout

```text
crates/
  nomad-proto/        shared wire types (no I/O)
  nomad-snapshot/     content-addressed world snapshots, replication, retention
apps/
  control-plane/      leases, scheduling, HTTP API, world store
  agent/              local server supervision + world sync
  relay/              stateless byte forwarding for game traffic
docs/                 product vision and technical research
scripts/              end-to-end smoke test
```

## API at a glance

```text
POST /v1/nodes/register               register a machine
GET  /v1/nodes                        list machines
POST /v1/servers                      create a server in a room
GET  /v1/servers/{id}                 current host, epoch, committed save
POST /v1/servers/{id}/claim           elect a host
POST /v1/servers/{id}/release         hand hosting over
POST /v1/servers/{id}/renew           keep a lease alive
POST /v1/servers/{id}/checkpoint      commit a save
PUT  /v1/snapshots/{id}/manifest      upload a manifest
PUT  /v1/snapshots/{id}/chunks/{hash} upload a chunk
GET  /v1/snapshots/{id}/chunks/{hash} download a chunk
```

## Documentation

- [docs/产品愿景.md](docs/产品愿景.md) — what this is, in plain language
- [docs/技术研究-v1.0.md](docs/技术研究-v1.0.md) — how the pieces fit together
- [docs/现有轮子调研-v1.0.md](docs/现有轮子调研-v1.0.md) — build-on vs. build-new
- [docs/需求分析-v0.1.md](docs/需求分析-v0.1.md) — the original requirements

## License

MIT. See [LICENSE](LICENSE).
