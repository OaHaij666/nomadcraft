# Hosting willingness

## ADDED Requirements

### Requirement: Self-service preference
Authenticated users SHALL read and modify only their own hosting willingness. Allowed values SHALL be high, medium, low and none, with medium for new and legacy users.

#### Scenario: Preference survives restart
- WHEN a user chooses low and the panel restarts
- THEN the same user reads low and another account remains unchanged

#### Scenario: Request cannot grant permissions
- WHEN a request includes another account UUID or a permission field
- THEN the request is rejected and no account authorization changes

### Requirement: Scheduling semantics
The preference SHALL be available to a future selector, without implementing an election algorithm or granting hosting permission. None SHALL represent opting out of automatic host candidacy.
