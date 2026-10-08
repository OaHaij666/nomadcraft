# NomadCraft

**A Minecraft world that lives between friends.**

Fixed address. Always-on saves. Whoever is online shares the load. Nobody rents a
server, nobody port-forwards, nobody keeps their PC awake so others can play.

> 一个"跑在朋友之间"的 Minecraft 世界：地址不变、存档不断、机器轮着用、没人时自己睡觉。

## The idea

Normally a Minecraft server is tied to one machine. Either someone rents a box and
pays for it to idle 22 hours a day, or one friend hosts and the session dies the
moment they close their laptop.

NomadCraft inverts that. The world belongs to the group, not to whichever PC
happens to be running it:

- **The public node never runs the game.** It is a doorbell and a switchboard:
  it knows who is hosting, hands out short-lived leases, and forwards bytes. It
  plays no Minecraft, needs no game version, and runs comfortably on a 1 vCPU /
  512 MB box.
- **The world runs on a player's machine.** Whichever friend is online and best
  suited runs the real server. Their CPU and RAM do the work, so big modpacks do
  not need a big rented host.
- **Leaving hands over, it does not end.** When the host quits, the control plane
  elects someone else, moves the latest save across, and players reconnect to the
  same address.
- **Nobody playing means nothing running.** The world sleeps until the next
  player wakes it.

## What exists today

This repository is being built in the open, bottom-up. What works right now:

| Component | Status | Notes |
| --- | --- | --- |
| `nomad-proto` | ✅ done | shared types: ids, epochs, leases, manifests, control messages |
| `nomad-snapshot` | ✅ done | content-addressed, chunk-deduplicated world snapshots |
| `nomad-control-plane` | 🚧 in progress | lease engine + scheduler done and tested; HTTP API next |
| `nomad-agent` | ⏳ planned | runs the game, syncs the world, heartbeats the control plane |
| `nomad-relay` | ⏳ planned | stateless byte forwarding for game traffic |

The safety-critical logic is finished and covered by tests: **47 tests, all
passing.** That includes the rules that keep two machines from ever writing the
same world at once.

## Design pillars

1. **One host at a time, enforced by leases.** Every handover bumps a monotonic
   *epoch*. Reports stamped with an older epoch are rejected, and a host that
   learns a newer epoch exists must stop immediately. Serving a stale world is
   always worse than briefly serving none.
2. **The public node can be tiny.** It coordinates and forwards; it never parses
   Minecraft and never stores world logic.
3. **Worlds are content-addressed.** A snapshot's identity is the BLAKE3 digest of
   its manifest, so manifests are immutable and every chunk is verified on read.
   Splitting is content-defined, so a small edit only uploads the chunks around it.
4. **Peers connect outbound.** Machines dial out and hold a connection open, so
   NAT and the absence of a public IP are non-issues.

## Repository layout

```text
crates/
  nomad-proto/        shared wire types (no I/O)
  nomad-snapshot/     content-addressed world snapshots
apps/
  control-plane/      leases, scheduling, HTTP API
  agent/              local server supervision + world sync
  relay/              stateless byte forwarding
docs/                 product vision and technical research
```

## Building

Requires a recent stable Rust toolchain.

```sh
cargo build          # build every crate
cargo test           # run the full test suite
cargo run -p nomad-control-plane -- info
```

## Documentation

- [docs/产品愿景.md](docs/产品愿景.md) — what this is, in plain language
- [docs/技术研究-v1.0.md](docs/技术研究-v1.0.md) — how the pieces fit together
- [docs/现有轮子调研-v1.0.md](docs/现有轮子调研-v1.0.md) — build-on vs. build-new
- [docs/需求分析-v0.1.md](docs/需求分析-v0.1.md) — the original requirements

## License

MIT. See [LICENSE](LICENSE).
