# Design

The central panel owns logical instances. A profile identifies an MC version, loader and loader version, pack revision, Java requirement and memory budget. Saves refer to a profile, own seed/world rules, and may own one stable room. Runtime host selection is not part of profile creation. Version identity is immutable once saves exist; cloning copies only configuration, never saves or ACLs.

Use authenticated panel sessions/API keys, existing Storage adapter, and a serialized write queue with copy-on-write commits. Authorize every mutation server-side. Creator permissions default to platform administrators; administrators may explicitly authorize named users. Instance owner controls access, while each grant has an instance-wide or single-save scope and independent hosting approval. Hosting approval never grants management or Minecraft OP.

The catalog records desired policy; Agent execution, signed deployment, game OP enforcement and snapshot actions are not yet provided by this catalog. UI distinguishes stored policy from applied runtime state and does not invent telemetry. Existing runtime tools use the existing permissions and remain administrator-only entry points in the new center.

Research: Crafty official user/role guide, Pterodactyl official permissions API, CubeCoders AMP product and backup release documentation, PaperMC server.properties reference. See docs/实例中心-调研与实现.md for source links and feature mapping.
