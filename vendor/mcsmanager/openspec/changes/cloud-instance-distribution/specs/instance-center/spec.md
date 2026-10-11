## ADDED Requirements

### Requirement: Release publication authorization
Publishing a complete environment release SHALL require both instance-scoped mods.manage and instance.update, matching the existing archive-publication contract. A local MOD editor with only mods.manage SHALL retain authorized local editing but SHALL NOT acquire publication rights. Permissions SHALL be rechecked before accepting the published release.

#### Scenario: MOD editor lacks instance update permission
- **WHEN** a member with mods.manage and without instance.update requests publication
- **THEN** publication is denied while authorized local MOD editing remains available

#### Scenario: Save grant includes a MOD permission
- **WHEN** a member has mods.manage only within a save-scoped grant
- **THEN** that grant does not authorize instance release publication

### Requirement: Save transfer authorization
A save transfer SHALL require source save.read, an explicit scoped transfer grant, and destination creation or save.create permission as applicable. A save-specific grant SHALL NOT expose other saves or instance management authority. Imported gameplay persistence SHALL NOT import source management or OP authority.

#### Scenario: Transfer one granted save
- **WHEN** a member with a scoped grant copies save A
- **THEN** save B is absent from the transfer and the destination reconstructs authority from its own grants
