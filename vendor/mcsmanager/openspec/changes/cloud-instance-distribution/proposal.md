# Proposal

## Why

KAMUCL NC can select a cloud instance, resolve its local client directory, and enforce instance MOD permissions, but local edits do not publish an authoritative release or synchronize its managed files. Separate NomadCraft services have no authenticated way to push an instance release to one another; copying catalog metadata or an archive alone cannot establish a complete destination instance.

## What Changes

- Add manifest-based immutable releases with file hashes, explicit file ownership, upload drafts, resumable transfers, verification, and atomic publication.
- Synchronize an authorized cloud release into a bound local client, retaining personal resources, runtime data, untracked files, and a recoverable previous release.
- Add administrator-configured peer services and delegated, scoped cloud-to-cloud release push/import. Imports create destination-owned instances or update an explicitly linked destination using an expected base release; source user grants and compute routing never become destination authority.
- Qualify bindings and transfer lineage by stable service identity, instance ID, save ID, and release digest. Switching services must not reuse a same-ID binding accidentally.
- Separate immutable environment distribution from stopped-server world checkpoints. Optional save transfer uses a committed checkpoint and never announces a live handover or uninterrupted migration.
- Show publication, download, verification, conflicts, destination acceptance, and failure explicitly, without interpreting a catalog revision match as verified file synchronization.

## Capabilities

### New Capabilities

- instance-distribution: Authoritative release publication, managed-file reconciliation, directory binding, truthful synchronization state, and recovery.
- cloud-federation: Scoped peer configuration, cloud-to-cloud instance push/import, repeatable transfers, lineage, and optional stopped-save copies.

### Modified Capabilities

- instance-center: Specify publication authorization and distinguish instance editing, publication, and save-transfer rights while preserving existing scoped membership.

## Impact

- Panel: extend existing NomadPackages, NomadCatalog.publish, release download routes, upload-policy limits, and Storage-backed catalog metadata with draft/transfer services and typed APIs.
- Shared: add versioned manifests, stable service identity, transfer/job views, and release lineage; preserve readers of existing ZIP releases.
- Desktop: extend nomadCloud, IPC, service-qualified bindings, instance selectors, local staging, publication controls, and sync status. The launcher remains the local account and file owner.
- Existing bundled cloud UI: expose publication, peer destinations, progress, and conflicts in the instance center; reuse task presentation rather than introducing another navigation section.
- Compute/agent: consume the same immutable environment release; retain existing exclusive stopped-save checkpoint semantics.
- No new Minecraft server process is required on the control plane. Peer transfer runs over authenticated HTTP services and bounded file storage.

## Delivery Boundary

This change is a preparation proposal. Runtime code is not implemented by this planning change. Existing local MOD management remains usable, and unsupported publishing or transfer controls must remain visibly unavailable until their acceptance tests pass.
