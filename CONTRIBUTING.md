# Contributing

Thanks for helping build NomadCraft.

## Ground rules

- **Never let two machines host the same world.** The lease and epoch rules in
  `apps/control-plane/src/engine.rs` are the safety core. Any change there needs
  tests that would fail if the invariant broke.
- **Keep the public node game-free.** The control plane and relay must never parse
  Minecraft or depend on a game version.
- **Reuse before writing.** Prefer a well-maintained crate over bespoke code. See
  `docs/现有轮子调研-v1.0.md` for what we deliberately build on.

## Before opening a pull request

```sh
cargo fmt --all
cargo clippy --all-targets -- -D warnings
cargo test
```

## Commit style

Short imperative subjects, e.g. `engine: refuse a second live lease`.
