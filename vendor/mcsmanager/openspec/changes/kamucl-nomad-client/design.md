# Design

## Runtime boundary

- KAMUCL Renderer owns the desktop UI and calls typed IPC.
- KAMUCL main process owns HTTPS requests to the NomadCraft panel, local game files, Java, and child processes.
- NomadCraft panel remains the authority for user sessions, catalog permissions, room state, compute placement, network ingress, and committed saves.
- nomad-agent remains a local execution worker. The client may later supervise it; this slice only establishes the control-plane connection.

## Session boundary

The main process stores the selected service origin on disk and keeps the Nomad session token in memory only. Renderer responses never contain the token. Remote requests use the existing panel envelope and token query convention until the backend protocol is deliberately versioned.

## Migration boundary

KAMUCL local instance and Microsoft account features remain available. Nomad catalog instances are displayed separately first; destructive replacement of local instance storage waits for a later sync adapter. The previous launcher implementation is removed as an active base.

## Security

Only HTTPS remote origins are accepted, except loopback HTTP for development. No arbitrary remote URL is loaded as a privileged renderer page. API errors are sanitized before UI display and credentials are not logged or persisted.


## Instance source and authorization

- The launcher keeps local and cloud instances as separate sources. A cloud selector item is a projection of a NomadCraft logical instance and, when available, one authorized save.
- Cloud projections carry the control-plane instance id, save id, instance permissions, save-scoped permissions, owner label, and revision. The launcher never infers permission from the display name or from local account state.
- Local filesystem, Java, memory, install, and delete actions are local-only. Selecting a cloud instance must not fall back to the first local instance. Cloud mutations will call NomadCraft endpoints and rely on the server as the final authorization authority.
- The client may hide or disable a cloud action from the permission projection for usability, but server-side permission checks remain authoritative.


## Startup animation preference

- The startup animation is controlled by the persisted `startupAnimation` setting and defaults to `false`.
- When disabled, the main window follows the ordinary ready-to-show path and no splash window is created. When enabled, the existing compositor and renderer readiness gate remains unchanged.
