# Design

The existing Rust agent gains an authenticated panel-host command rather than extending the unauthenticated legacy coordinator API. The existing coordinator/snapshot primitives remain available. Catalog mutations serialize hosting grants, leases, epoch fences, checkpoint references and room status. Private executor tokens are hashed and excluded from user views. User hosting scope is checked at ticket issuance and every heartbeat.

Only vanilla jar deployments are executable in this delivery. The center supplies approved jar, EULA, server.properties and cloud player policy. World archives contain only world/ paths; receipts are SHA256-verified, validated before commit and immutable. A new host always restores the canonical snapshot in an isolated directory. Expired or revoked hosts stop and may finish a final upload only while their epoch is still current. Stopping renewals are capped at ten minutes; clean release requires an explicit final checkpoint. Native range streams avoid the ZIP reader backpressure stall on large region entries. Uncertain process loss blocks automatic takeover until a fence grace window elapses; stale epochs never commit.

Outbound WebSocket tunnels use the panel's HTTP/TLS endpoint with a bearer ticket and epoch. Each room gets a center TCP endpoint, advertised only after the actual game process is ready. The server performs native online authentication and whitelist checks. The first default relay bind/advertisement is loopback for local review; administrators explicitly configure public access.

The center is currently a single panel process; shared Redis alone does not provide distributed lease or relay coordination.

The executor's own process control can always be modified by the machine owner; this design enforces center-side authorization/commit fencing and makes no claim of proving honest execution on a malicious host.
