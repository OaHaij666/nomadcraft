# Adopt KAMUCL as the NomadCraft desktop client

NomadCraft previously had a legacy launcher prototype while KAMUCL provides a maintained Electron/Vue/TypeScript desktop launcher with local instance, account, resource, diagnostics, and networking capabilities. The product decision is to make a KAMUCL derivative the official NomadCraft desktop client. NomadCraft servers remain the cloud control plane and storage backend.

The client SHALL keep local Minecraft execution and credentials local while consuming authenticated NomadCraft APIs for catalog, room, compute-node, configuration, ingress, and committed-state operations. The migration SHALL preserve existing backend contracts and avoid exposing local filesystem or process IPC to remote web content.

This change starts with a vertical integration slice: a bundled NomadCraft view, a main-process API client with in-memory session credentials, and a buildable KAMUCL base. Legacy launcher artifacts are retired from the workspace after this base is verified.
