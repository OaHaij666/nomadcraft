# Design

## Context

See proposal.md for motivation. The observed implementation already has:

- Panel NomadPackages.store: hashes and atomically stores inspected Modrinth, CurseForge, and PCL archives; NomadCatalog.publish requires mods.manage plus instance.update. Saves bind to a release and require stopped hosting and a closed room before rebinding.
- Catalog revision is an event counter, not an environment file digest. Editing the MOD list changes metadata without transferring actual artifacts. A release archive can also refer to external provider files.
- KAMUCL NC resolves cloud selections to local clients, including clients outside the active folder. MOD writes are checked in the main process, including local aliases of bound cloud directories. There is no upload/apply transaction or verified local file baseline.
- Local bindings are currently keyed by instance/save without service identity. Existing SnapshotSync exchanges world chunks with the coordinator, but this does not implement an independent panel-to-panel release import.
- Current source files: panel/src/app/service/nomad_packages.ts, nomad_catalog.ts, routers/nomad_catalog_router.ts; shared/nomad-catalog.ts; ../kamucl/src/main/core/nomadCloud.ts, cloudResourceGuard.ts, and renderer/src/store.ts. Existing tests cover packages, catalog authorization, hosting, and local MOD behavior.
- The friends-first scope keeps management authorization and single-writer save leases, without anti-cheat claims. A clean stop and committed save checkpoint are the baseline for persistence transfer.

## Goals / Non-Goals

**Goals:** Reuse one release format and verification path for local publication, client download, compute preparation, and cross-cloud import. Provide an independently accepted destination copy with resumable transfer and explicit conflicts.

**Non-Goals:** Automatic multi-master merging, automatic cross-cloud following, live memory migration, uninterrupted player sessions, arbitrary filesystem replication, or transfer of Microsoft/AI account credentials. These are not implied by successful release transfer.

## Decisions

### 1. Separate identities and revision counters

Persist a stable service UUID through the existing Storage subsystem. Qualify bindings as serviceId/instanceId/saveId and store baseReleaseId, baseManifestDigest, and verifiedLocalInventory separately from catalogRevision. Requests still use the configured origin; identity discovery binds that origin to a UUID and switching origins revalidates it.

This avoids accidental reuse across independent services. URL-only identity breaks on legitimate address changes; bare instance UUIDs break on cloned or restored service data. Unexpected identity changes require an explicit rebind. Catalog revisions remain useful optimistic-concurrency tokens, but never certify local bytes.

### 2. Versioned managed-file manifests

A release manifest v1 contains normalized relative paths, byte sizes, SHA-256 digests, side (client/server/both), and ownership (managed/seed/personal/runtime), plus a typed environment profile and source provenance. Canonical ordering and serialization produce a manifest digest. Environment blobs contain only managed artifacts and selected seed files; personal/runtime entries describe retention boundaries rather than uploaded bytes.

Minecraft libraries/assets/Java remain obtained through existing install resolvers; do not upload an entire .minecraft tree. Required MODs and declared overrides become managed artifacts. Provider URLs and expected hashes remain recorded where existing pack formats reference external dependencies; provider-only files must be resolved and verified through existing integrations before declaring a materialized managed artifact available. Original archive hashes stay intact.

There is no giant per-MOD rule registry. The publisher previews the explicit owned inventory and can include known seed/config files deliberately. Unknown paths are retained. A database under config is not treated as managed merely because its parent folder was selected, and a file extension is not a database classification rule. Registered persistent server files belong to the save checkpoint instead.

### 3. One transactional publication path

Create a draft against expected catalogRevision and baseReleaseId. Compute missing artifact hashes, stream/resume uploads into draft staging, verify bytes, then commit the immutable manifest and release through catalog mutation with a final permission and base check. Existing archive imports use an adapter into this path after inspection. Use existing uploadPolicy limits (currently default 5 GiB, administrator configurable), path validation, expanded-size limits, and Storage for metadata; bounded filesystem blob storage is content addressed.

Do not buffer whole multi-gigabyte uploads. A per-artifact partial upload records accepted offset and declared size; only a verified complete hash is reusable. Metadata commit occurs after verified blob installation. A crash between those steps creates unreferenced blobs, not a visible incomplete release; a retention-aware sweep can collect expired drafts and unreferenced blobs later. Quotas count actual required bytes and expanded content, not just compressed input.

The alternative of updating the MOD list then uploading files leaves readers with inconsistent metadata. The alternative of publishing a ZIP directly cannot express managed deletion, conflicts, and personal-file retention reliably.

### 4. Local reconciliation and safe activation

The main process resolves the exact bound local client, acquires its file-operation lock, and compares previous verified inventory, current local hashes, and the target manifest. It generates a three-way diff. Deletion is restricted to previous owned paths. Changed local owned files become conflicts; seed updates require explicit acceptance. Personal and runtime files are never inferred into publication.

Download into a sibling staging directory, verify each managed artifact, and check the game is idle immediately before activation. Use a durable activation journal and recoverable previous files. Since a local instance mixes managed and personal content, one directory rename is not a complete transaction: journal file replacements/deletions and recover before permitting launch after a crash. Advance the successful baseline only when all operations complete. Retain a rollback release until policy removes it. Do not promise cross-filesystem atomic rename.

Synced means the selected release's owned inventory was verified and activated. Catalog revision-only projections become checking; local-ahead, cloud-ahead, conflict, offline, unbound, and recovery-required reflect actual evidence. Read-only members may download/repair their authorized local copies; mods.manage governs editing/publication, not acquiring the published environment needed to join a room.

### 5. Push semantics between independent clouds

The source service starts a job addressed to an administrator-configured peer. The destination accepts a scoped grant bound to source serviceId, source instanceId/releaseDigest, and a destination owner or explicit existing target. For a new copy it allocates destination IDs and ownership. For an update it compares the agreed target base and preserves destination-specific grants. Store lineage separately from authority; never copy user ACLs, OP rules, compute nodes, ingress addresses, leases, or local directory paths.

Transfer only missing verified artifacts, reuse the publication commit path, and use a durable transferId/idempotency key so a lost commit response returns the original result. The sender checks destination acceptance before showing success. Default import is an independent copy; a later source release is pushed only on an explicit operation. Divergent destination changes produce a conflict rather than an implicit merge.

Credentials are transmitted in headers, scoped and expiring, not in URLs. Peer endpoints are administrator pinned; validate destination resolution and disallow unexpected redirects and DNS rebinding. Explicitly approved private-network peers remain supported. Export requires source instance read plus a delegated transfer grant; destination creation/update requires destination authority. Recheck revoked grants at commit.

### 6. Environment and persistence transfer are separate jobs

Phase one transfers environments only. Optional save copy references a closed-room, stopped-server committed checkpoint containing the complete world and registered persistent MOD data at the same logical point. SQLite main/WAL files cannot be copied independently while writes continue. Reuse the existing snapshot/checkpoint semantics after checking the target environment's compatibility, and preserve file integrity checks.

The destination creates a new stopped save and a closed room. The source copy remains; source ownership/leases/OP/whitelist policy are not inherited. External database services require a separate explicit adapter, so an environment import does not advertise a complete save copy when that data is unavailable. Repeated transfer must not start two authoritative hosts.

### 7. Proposed API surface and UI

| Route family | Purpose |
| --- | --- |
| GET /api/nomad/identity | Stable service identity and supported manifest/transfer versions |
| POST /api/nomad/catalog/instances/:id/publications | Authorized draft with expected base and manifest inventory |
| Publication missing, blob upload/status, commit, cancel routes | Bounded resumable artifact transfer and atomic release creation |
| Existing release download + manifest/artifact routes | Authorized retrieval; preserve instance/save read filtering |
| Administrator peer configuration routes | Pin peer identity, allowed origin, and delegated transfer policy |
| POST /api/nomad/transfers and transfer status/cancel/accept routes | Source push, destination staging, acceptance, idempotent outcomes |

Exact payload names are finalized with shared contract tests before implementation; these are proposed routes, not existing capabilities. Keep short-lived scope grants and header authentication in both directions. Do not treat the current nomadCloud.catalog response as a blob manifest.

KAMUCL's cloud instance center gets publish-local-changes, sync-to-local, rollback, and push-to-another-cloud actions. Publish requires both existing instance grants. Transfer shows destination identity, ownership, expected target, optional stopped-save inclusion, and a diff/acceptance summary. MOD/resource pages keep their current instance context and display actual operation status; the backend remains independent of desktop UI packaging.

## Risks / Trade-offs

- Disk exhaustion with multi-gigabyte drafts -> enforce uploadPolicy and storage quotas before accepting bytes, bound concurrency, expire uncommitted drafts, and retain referenced release blobs.
- Local files mutate during scanning -> scan with stable inventory, recheck before commit/activation, require idle directory, and stop on mutation rather than publish inconsistent bytes.
- Runtime config is mistaken for a managed update -> require explicit ownership and conflict review; preserve unknown paths and seed changes by default.
- Existing archive-only releases lack a materialized inventory -> retain download compatibility and migrate only from validated archive/provider inputs, never a local mutable baseline.
- Peer endpoint becomes an outbound request proxy -> administrator-configured destinations, identity pinning, bounded streaming, redirect restrictions, and connection-time origin validation.
- New catalog/manifest readers break old clients -> capability negotiation and additive persisted fields; old readers continue using the original archive path.

## Migration Plan

1. Add versioned contracts, persistent service identity, and feature discovery while existing release readers keep working.
2. Implement manifest/draft storage and publish/local-pull tests using temporary filesystem fixtures.
3. Upgrade bindings to service-qualified keys only after confirming the owning service; ambiguous old bindings remain unbound and preserve all local files.
4. Enable client reconciliation and UI only when publish/download/rollback integration tests pass.
5. Enable configured cross-cloud peers and test two independent panel instances, disconnections, restart, revocation, and divergent target bases.
6. Add optional stopped-save copy after world/database checkpoint tests pass. Keep it unavailable for unsupported persistence adapters.
7. Rollback disables new feature negotiation and actions, retains old release archives and all local files, and leaves manifests/jobs available for later recovery. Do not silently downgrade a managed inventory to matching catalog numbers.
