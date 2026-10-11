# Server computation and pluggable network ingress

## Why
The user requires a traditional dedicated-server option and a mixed compute pool where servers participate with administrator-defined priority. Public IPv4/IPv6, port mappings, external tunnels and other ingress choices must be supported independently of compute location.

## What Changes
- Model server and player compute nodes, independent participation and resource budgets.
- Add per-room fixed-node, automatic-pool and server-fallback policies. Fixed placement is a hard constraint with explicit failure behavior.
- Separate gateway binding, advertised player address, external ingress mapping and internal backend transport.
- Accept manually managed generic TCP mappings first; provider automation is a separate adapter capability.
- Classify native-client, private-overlay and client-assisted ingress, and expose IPv4/IPv6 and protocol capabilities.

## Impact
Future shared types, panel persistence/API, executor registration, scheduler, proxy control and frontend configuration. Current runtime remains unchanged. Prior work already supplies the independent panel-host executor, authenticated outbound transport and user hosting preference. No provider deployment or seamless handover is claimed here.
