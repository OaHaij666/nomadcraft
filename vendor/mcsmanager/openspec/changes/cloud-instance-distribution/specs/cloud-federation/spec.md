## Purpose

Allow explicitly authorized NomadCraft services to push complete instance releases to independent destination services without sharing management authority.

## ADDED Requirements

### Requirement: Explicit peer configuration
Only an administrator SHALL configure trusted peer origins and allowed network destinations. The service SHALL pin the peer's stable service identity, validate its protocol capabilities, and reject arbitrary transfer URLs, unexpected identity changes, and redirects outside the configured origin.

#### Scenario: Peer redirect changes authority
- **WHEN** a peer download redirects to another unconfigured origin
- **THEN** transfer stops and no management credential is forwarded

#### Scenario: Deliberate private-network deployment
- **WHEN** an administrator explicitly approves a private-network peer origin
- **THEN** the connection uses that approved origin without granting users general outbound URL access

### Requirement: Delegated scoped transfer authority
Source export and destination import SHALL be separately authorized. Transfer credentials SHALL be limited to the selected peer, source instance, destination, content, operation, and expiry. Revocation SHALL block commit. User login cookies, general API keys, and accounts SHALL NOT be copied to the other service or placed in transfer URLs.

#### Scenario: Hosting permission without export permission
- **WHEN** a compute participant attempts to push an instance without authorized export access
- **THEN** the source denies the operation before releasing instance artifacts

#### Scenario: Destination revokes acceptance during transfer
- **WHEN** the destination revokes the transfer before commit
- **THEN** uploaded staging artifacts remain unpublished and no destination instance becomes active

### Requirement: Independent destination ownership
An accepted copy SHALL have destination-issued instance and release identities, destination ownership, and explicit source lineage. Source membership, OP rules, peer secrets, local paths, compute registrations, network ingress, and active leases SHALL NOT confer destination privileges or runtime configuration.

#### Scenario: Administrator on source becomes a regular destination user
- **WHEN** a source administrator pushes an instance to a destination where they lack creation permission
- **THEN** import is denied regardless of their source role

### Requirement: Complete idempotent cloud push
A push SHALL identify its immutable source release, reuse verified destination artifacts, and publish only a complete verified import. Retrying the same accepted transfer identifier SHALL return the same destination result rather than create duplicate instances or releases.

#### Scenario: Sender loses the commit response
- **WHEN** the source retries a push that the destination already committed
- **THEN** it receives the original destination instance and release references

### Requirement: Explicit update relationship
Cloud-to-cloud copies SHALL NOT follow future source updates automatically. Updating an existing linked destination SHALL require an explicit destination grant, expected target base, and unchanged source identity. A divergent destination SHALL return a conflict rather than merge MOD or configuration changes silently.

#### Scenario: Both clouds edit the copied environment
- **WHEN** the source pushes a new release after the destination published a local change
- **THEN** the destination reports a divergent-base conflict and preserves its active release

### Requirement: Optional committed save copy
Environment push SHALL omit saves by default. An explicitly requested save copy SHALL require a complete committed checkpoint from a stopped source server, including declared persistent MOD data, and a compatible destination release. It SHALL create an independent stopped destination save with no active lease or open room.

#### Scenario: SQLite writes are still active
- **WHEN** a requested save export cannot establish a stopped and coherent world/database checkpoint
- **THEN** save export is refused while an independent environment-only push remains possible

#### Scenario: Copy a stopped save
- **WHEN** an authorized destination accepts a compatible committed save checkpoint
- **THEN** it receives new save identity, complete persistent data, and a closed room without deleting the source copy

### Requirement: Durable transfer outcomes
Both services SHALL expose durable transfer progress and final acceptance or rejection. Cancellation, restart, expiration, quota failure, and source unavailability SHALL NOT be reported as success. Audit records SHALL identify the participating services and instance/release references without exposing credentials.

#### Scenario: Control plane restarts during upload
- **WHEN** the receiver restarts with a partially verified transfer
- **THEN** the job resumes from durable verified progress or fails explicitly without publishing partial state
