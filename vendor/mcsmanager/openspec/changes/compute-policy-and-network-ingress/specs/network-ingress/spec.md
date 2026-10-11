# Network ingress

## ADDED Requirements

### Requirement: Independent endpoint configuration
The system SHALL distinguish the public player endpoint, gateway bind endpoint, tunnel control endpoint and internal backend route.

#### Scenario: External port differs from local port
- WHEN an ingress maps public TCP port 30065 to gateway port 25565
- THEN clients receive the public endpoint and the gateway remains on its configured local port

### Requirement: Address families and client dependencies
The system SHALL record IPv4/IPv6 capability and whether ingress requires client-side helper software.

#### Scenario: HTTP-only exposure
- WHEN an adapter provides only website access
- THEN it is not marked as a validated native Minecraft ingress

### Requirement: Stable gateway layout
Ingress profiles intended for connection-preserving compute handover SHALL target the persistent protocol gateway rather than a changing compute endpoint.

#### Scenario: Compute node changes
- WHEN the room migrates from a server to a player node
- THEN its configured public gateway endpoint remains unchanged

### Requirement: Bounded network self-check
Administrators SHALL inspect only saved endpoints with bounded DNS/TCP/protocol probes. Reports SHALL distinguish center-side success from externally verified public reachability.

#### Scenario: Local status response
- WHEN the center obtains a valid Minecraft status from an advertised endpoint
- THEN that check succeeds but public reachability remains unverified without an external vantage point
