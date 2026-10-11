# Tasks

All tasks below are pending implementation. Commands are relative to vendor/mcsmanager unless a different directory is written explicitly. Each task must add its own regression coverage and relevant API/recovery documentation before its checkbox is completed. Archive and publication are separate follow-up actions.

## 1. Release contracts and service identity

- [ ] 1.1 Add manifest v1, ownership, digest, transfer state, and additive release-lineage contracts; test canonical ordering, unknown-version rejection, duplicate normalized paths, and legacy archive readers. Verify with cd panel && npm test, and cd daemon && npm test.
- [ ] 1.2 Persist a stable service UUID and expose authenticated capability discovery; test restart persistence, missing identity migration, and consistent origin-to-service binding. Verify with cd panel && npm test.
- [ ] 1.3 Add a service-qualified desktop binding migration that preserves old local files and leaves ambiguous service ownership unbound; test identical instance IDs on two services and a client outside the active game folder. Verify with cd ../kamucl && npm test.

## 2. Publication drafts and verified artifact storage

- [ ] 2.1 Add Storage-backed publication drafts, expected catalog/base release references, expiration, and permission checks; test read-only members, MOD-only editors, and save-scoped grants. Document the draft API. Verify with cd panel && npm test.
- [ ] 2.2 Implement a bounded missing-artifact query and verified content-addressed storage; test wrong hashes/sizes, manifest limits, duplicate names, link escapes, and already-present artifacts. Verify with cd panel && npm test.
- [ ] 2.3 Implement streamed per-artifact partial upload/status with offset validation and resume; test disconnection, restart, administrator quota changes, cancellation, and malformed ranges with bounded-size fixtures. Document quota and cleanup semantics. Verify with cd panel && npm test.
- [ ] 2.4 Commit a complete release through a final permission and expected-base check; test concurrent publishers, revoked permissions, missing artifacts, crash-before-metadata commit, and idempotent repeated commits. Verify with cd panel && npm test.
- [ ] 2.5 Adapt existing inspected archive imports and authorized provider resolution into manifest publication while preserving original archive hashes; test archive-only compatibility and incomplete referenced dependencies. Document the migration. Verify with cd panel && npm test.

## 3. Desktop publishing and local reconciliation

- [ ] 3.1 Implement an idle-directory inventory and explicit ownership/diff preview in the main process; test managed MOD changes, unknown files, personal shaders, seed config changes, and MOD-created SQLite/WAL retention. Verify with cd ../kamucl && npm test.
- [ ] 3.2 Add authenticated publication IPC and bounded streaming to the draft API; test session loss, cancellation, resume, publish permission failure, and base conflict without leaking credentials. Verify with cd ../kamucl && npm test.
- [ ] 3.3 Add authorized manifest/artifact reads for instance-scoped and save-scoped members; test that a member can download the release required by their granted save without receiving other saves. Document the retrieval API. Verify with cd panel && npm test.
- [ ] 3.4 Implement three-way local reconciliation and staged downloads; test managed deletion, untracked MOD preservation, divergent local/cloud files, and required-versus-personal resources. Verify with cd ../kamucl && npm test.
- [ ] 3.5 Implement idle activation, an on-disk recovery journal, and recoverable previous files; test locks, crash injection after each replacement, cancellation before activation, cross-volume destinations, and rollback before launch. Document recovery steps. Verify with cd ../kamucl && npm test.
- [ ] 3.6 Replace catalog-only synchronized status with verified inventory evidence; test local-ahead, cloud-ahead, conflict, offline, unbound, and recovery-required without promoting failed activation to synced. Verify with cd ../kamucl && npm test.
- [ ] 3.7 Add publish, pull, diff, conflict decisions, and rollback controls to the existing cloud instance center and desktop task UI; verify permission-disabled actions and the exact local target. Record real-client screenshots. Verify with cd frontend && npm run type-check && npm run lint && npm test, and cd ../kamucl && npm test.

## 4. Scoped cross-cloud transport

- [ ] 4.1 Add administrator-only peer configuration, identity pinning, protocol negotiation, and allowed-origin network validation; test private peers explicitly approved by an admin, rejected arbitrary URLs, redirects, and rebinding. Document deployment configuration. Verify with cd panel && npm test.
- [ ] 4.2 Add expiring scoped export/import grants and header-only credential use; test separate source/destination authorization, wrong peer/instance/destination, revocation, and secret-free audit records. Verify with cd panel && npm test.
- [ ] 4.3 Add durable source push and destination staging jobs that negotiate missing artifacts and reuse the publication path; test interruption/restart, quota rejection, cancellation, and corrupt peer artifacts. Verify with cd panel && npm test.
- [ ] 4.4 Add destination identity/ownership assignment, lineage, transfer idempotency, and explicit target-base updates; test lost commit responses, duplicate requests, source/target divergence, and exclusion of source grants, OP policy, routes, and leases. Verify with cd panel && npm test.
- [ ] 4.5 Add peer destination, copy/update choice, transfer acceptance, and progress to the instance center; test unauthorized destinations, unavailable capabilities, retries, and explicit errors without another sidebar section. Verify with cd frontend && npm run type-check && npm run lint && npm test, and cd ../kamucl && npm test.
- [ ] 4.6 Run an environment-only push between two independent real HTTP panel fixtures, then use the destination's release to synchronize an independent desktop directory; verify artifact hashes, destination ownership, personal-file retention, retry idempotency, and rollback. Document the reproducible fixture. Verify with cd panel && npm test, and cd ../kamucl && npm test.

## 5. Compute preparation and optional stopped-save copy

- [ ] 5.1 Adapt compute preparation to the same environment manifest with truthful unsupported-version reporting; test old ZIP releases and a verified manifested release without changing lease ownership. Verify with cd panel && npm test, cd daemon && npm test, and from the NomadCraft root cargo test -p nomad-agent.
- [ ] 5.2 Add optional save export from a stopped, closed-room committed checkpoint and explicit source save-read delegation; test active host refusal, incomplete checkpoints, unauthorized saves, and coherent registered world/MOD persistence. Document supported persistence adapters. Verify with cd panel && npm test, cd daemon && npm test, and from the NomadCraft root cargo test -p nomad-agent.
- [ ] 5.3 Import a compatible checkpoint as a new destination save with a closed room and no lease/OP/ingress inheritance; test environment mismatch, unavailable external databases, repeated transfers, and a subsequent single-host restore. Verify with cd panel && npm test, cd daemon && npm test, and from the NomadCraft root cargo test -p nomad-agent.

## 6. Deployment and combined acceptance

- [ ] 6.1 Exercise upgrades and rollback with existing release archives and legacy bindings, preserving original local directories and successful baselines; document feature negotiation and disabled-state rollback. Verify with cd panel && npm test, and cd ../kamucl && npm test.
- [ ] 6.2 Run real-client visual acceptance for publication, read-only pulling, conflict review, peer push, failed/revoked transfer, and stopped-save copy; confirm each status matches actual verified files and no active game is modified. Verify with cd frontend && npm run type-check && npm run lint && npm test, cd ../kamucl && npm test, and cd panel && npm test.

## Workflow follow-up

- Review this proposal and its behavior contracts before applying runtime changes.
- Deliver the environment publication/local-pull foundation first, then the explicit cloud-to-cloud push, then optional stopped-save copy.
- Archive only after all applicable acceptance tests and recovery documentation pass. Do not increment desktop versions or publish a release solely because this plan exists.
