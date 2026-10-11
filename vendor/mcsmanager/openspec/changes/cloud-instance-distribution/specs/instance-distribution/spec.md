## Purpose

Publish complete immutable Minecraft environments and reconcile authorized local copies while preserving personal resources and mutable runtime state.

## ADDED Requirements

### Requirement: Service-qualified bindings
The system SHALL identify a binding by stable service identity, logical instance ID, and optional save ID. A usable cloud client SHALL have a valid local storage root and an explicitly bound local client directory. The system SHALL NOT infer ownership from a same-ID instance on another service.

#### Scenario: Switch between services with identical instance IDs
- **WHEN** a player connects to service B after binding instance X on service A
- **THEN** B's instance X has no binding until a B-specific binding is selected

#### Scenario: Client resides outside the active game folder
- **WHEN** an authorized player binds a client in another registered local game folder
- **THEN** synchronization resolves that exact folder and never falls back to the active folder

### Requirement: Complete immutable publication
The system SHALL expose a release only after its versioned manifest, declared managed artifacts, sizes, and hashes have been verified. Published releases SHALL be immutable. A partial upload SHALL NOT change any active release or report publication success.

#### Scenario: Upload stops before the final artifact
- **WHEN** a publisher disconnects with one declared artifact incomplete
- **THEN** the draft remains resumable or expires, and the prior published release remains available

#### Scenario: Corrupt artifact
- **WHEN** a staged artifact has a different hash or size from its manifest
- **THEN** commit is rejected and the corrupt artifact does not enter a published release

### Requirement: Publication conflict detection
The system SHALL require an expected base release and catalog revision when committing an update to an existing instance. It SHALL recheck publication permissions at commit and reject a stale base without overwriting another publisher's work.

#### Scenario: Two publishers start from the same release
- **WHEN** publisher A commits and publisher B then commits its old draft
- **THEN** B receives a conflict containing the current release reference and no update is lost

### Requirement: Explicit synchronization ownership
Every distributed path SHALL declare whether it is managed, an initial seed, personal, or runtime data. Sync SHALL update only declared managed paths and deliberately accepted seed updates. Unknown files, personal resources, credentials, and mutable runtime data SHALL NOT be automatically uploaded or deleted. File extensions alone SHALL NOT determine database ownership.

#### Scenario: Additional shaders and a MOD-created database
- **WHEN** the local copy contains personal shaders and an undeclared database with companion WAL files
- **THEN** ordinary environment sync preserves them and excludes them from publication

#### Scenario: Required resource changes
- **WHEN** a release updates an explicitly managed required resource
- **THEN** the managed copy can be updated without deleting additional personal resources

### Requirement: Preview and managed deletion
Before publishing or applying a release, the system SHALL show added, changed, removed, and conflicting owned files. A removal SHALL apply only to a path owned by the previous verified manifest. A locally changed owned file SHALL require an explicit conflict decision and a recoverable backup before replacement.

#### Scenario: Release removes a MOD but another local MOD is untracked
- **WHEN** the player applies the new release
- **THEN** only the previously owned removed MOD is eligible for deletion and the untracked MOD is retained

### Requirement: Resumable bounded transfers
Transfers SHALL resume from verified progress, transfer only missing artifacts, and honor the administrator's upload, expanded-size, file-count, and storage limits. Paths, duplicate normalized names, and link escapes SHALL be validated before activation.

#### Scenario: Interrupted large instance upload
- **WHEN** an allowed multi-gigabyte transfer resumes after a connection loss
- **THEN** completed verified artifacts are reused and partially uploaded artifacts are resumed or safely restarted

### Requirement: Transactional local activation
The system SHALL stage and verify changes before activation, require the affected game directory to be idle, and record a recoverable activation journal. If activation fails or the launcher crashes, it SHALL preserve or recover a coherent previous release and SHALL NOT advance the successful-sync baseline.

#### Scenario: Failure during replacement
- **WHEN** a file lock prevents activation after some files have changed
- **THEN** recovery restores the previous owned files or reports a recovery-required state before allowing launch

### Requirement: Verified synchronization status
Synced status SHALL require a verified owned-file inventory for the selected release and successful activation. Catalog revisions alone SHALL NOT establish file synchronization. Local edits, remote changes, concurrent changes, offline access, and unavailable bindings SHALL have distinguishable states.

#### Scenario: Metadata agrees but local bytes differ
- **WHEN** catalog revisions match and one managed local file has changed
- **THEN** the client reports a local change or conflict instead of synced

### Requirement: Existing archive compatibility
Previously published ZIP-based releases SHALL remain downloadable. Migration SHALL preserve their original hashes and metadata and SHALL NOT invent a verified file inventory from the current local directory.

#### Scenario: Bind an older uploaded pack
- **WHEN** a player selects an archive-only release
- **THEN** the client can use the existing import path and reports inventory pending until a verified migration completes
