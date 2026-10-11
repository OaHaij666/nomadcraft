# Instance center

## ADDED Requirements

### Requirement: Logical instances and saves
The center SHALL persist versioned MC profiles independently of compute hosts. One profile SHALL support multiple saves. Every save SHALL have at most one room; repeated room creation SHALL return a conflict. Identity updates SHALL be rejected once saves exist.

#### Scenario: Two saves
- **WHEN** an authorized owner creates two saves under one profile
- **THEN** they have independent IDs, rules and unique rooms

### Requirement: Central authorization
The backend SHALL require authenticated identity and creation capability. Resource grants SHALL apply to an instance or a single save. Hosting eligibility SHALL NOT grant console, configuration, ACL or OP authority. Removing membership SHALL remove read and mutation access. Ownership SHALL not be editable through profile payloads.

#### Scenario: Scoped member
- **WHEN** a user is granted access to one save
- **THEN** other saves and their metadata are absent from the user's response and actions on them are denied

### Requirement: Operational honesty
Room intent SHALL not imply a running game server. Unsupported execution, snapshot, import and transfer actions SHALL be clearly unavailable. Existing authenticated runtime tools SHALL remain accessible separately.

#### Scenario: Open room
- **WHEN** an owner opens an unbound room
- **THEN** the center persists an open request and reports awaiting executor, not running
