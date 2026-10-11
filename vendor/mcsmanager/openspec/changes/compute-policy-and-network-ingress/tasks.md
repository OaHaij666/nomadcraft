- [x] Inspect existing executor, legacy scheduling and relay capability; verify ingress primary sources
- [x] Record server-only/mixed/fallback requirements and update prior player-only architecture assumptions
- [x] Add server node identity, participation, priority and resource budgets — panel/agent tests
- [x] Add fixed/automatic/fallback room placement with authorization and fencing — panel/agent tests
- [x] Add independent gateway bind and advertised ingress profiles — panel/frontend tests
- [x] Integrate generic TCP mapping and dual-stack validation — real local TCP, Minecraft status/login and HTTP checks
- [x] Add manual provider profiles, frpc configuration export and explicit client prerequisites — panel/frontend/browser checks
- [x] Verify fixed server execution, candidate constraints and fallback, external/local port separation, and reuse of a stable address — isolated native-client integration plus placement tests
- [x] Add bounded administrator-only center/room network self-check with explicit external-verification limits — protocol/HTTP/frontend/browser tests
- [ ] Automate external provider installation, credentials and process management
- [ ] Validate physical server/player nodes, Linux service deployment, public IPv4/IPv6 and real external tunnel providers
- [ ] Implement persistent Minecraft protocol gateway and verify connection-preserving compute handover

Verification on 2026-10-10: panel 100 tests; frontend 77 tests; agent 15 unit + 3 HTTP tests; common 9 tests; daemon 144 passed / 1 skipped. Common integration: all 9 groups passed (Docker not run on Windows). Panel/frontend/agent/KAMUCL builds passed. Real game and browser records are in docs/proofs/compute-network-2026-10-10.json and compute-network-ui-2026-10-10.json. Integration uses isolated local nodes and an offline allowlisted probe; it does not prove public reachability, Microsoft authentication or uninterrupted handover.
