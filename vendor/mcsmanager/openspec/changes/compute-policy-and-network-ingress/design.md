# Design

Keep computation placement orthogonal to public ingress. Roles (control plane, protocol gateway, executor, public edge) may be colocated or separate. Fixed server execution can use conventional direct ingress; retaining sessions across future backend changes requires the persistent gateway layout.

Server nodes use administrator-managed participation and priority, independent of a human user's hosting willingness. Player nodes require current hosting/save authorization and their account willingness. Eligibility and resource limits precede scoring. Same-host executor resource budgets reserve capacity for the panel and gateway. A fixed room does not silently migrate to player hardware when unavailable; fallback is explicit.

Ingress stores structured bindHost/bindPort and advertisedHost/advertisedPort, address family, protocol and client dependencies. Tunnel control addresses are not player endpoints. Internal backend routes remain restricted to authenticated node bindings; publicly advertising a backend must not bypass a gateway's authentication contract. Generic external TCP mappings are the first integration surface; installing and managing provider agents is optional follow-up work.

Health checks include native Minecraft handshake/login and sustained connections. A successful HTTP response or tunnel controller connection is insufficient. IPv4 and IPv6 receive independent reachability checks. Endpoint failover does not imply preservation of existing TCP sessions. See docs/计算节点与网络接入-扩展需求.md for primary-source research and acceptance scope.
