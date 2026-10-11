# Compute placement

## ADDED Requirements

### Requirement: Server execution
The system SHALL permit an authorized server node to execute the same Minecraft lifecycle as a player node without running a game client.

#### Scenario: Fixed traditional server
- WHEN a room is fixed to a server node
- THEN only that node receives the active execution lease unless an explicit fallback policy permits another node

### Requirement: Mixed scheduling
The system SHALL support server participation and administrator priority independently of player hosting willingness.

#### Scenario: Priority cannot bypass eligibility
- WHEN a preferred server is unauthorized, offline or below resource limits
- THEN its priority does not make it eligible

### Requirement: Single writer
All placement modes SHALL retain epoch fencing and canonical world checkpoint authority.

#### Scenario: Server and player compete
- WHEN both request execution for one world
- THEN only the current lease holder can commit that world's checkpoint
