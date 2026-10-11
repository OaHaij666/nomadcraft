# Desktop client

## Requirement: NomadCraft client shell
The desktop client SHALL expose a NomadCraft view inside the KAMUCL renderer and SHALL keep existing local launcher views available.

### Scenario: connect to a service
- WHEN a user enters a loopback HTTP or HTTPS NomadCraft origin
- THEN the main process validates and stores the origin and reports the connection target without exposing credentials.

### Scenario: sign in and list catalog
- WHEN a user submits NomadCraft credentials
- THEN the main process calls the panel login endpoint, retains the session only in memory, and returns the authorized catalog to the renderer.

### Scenario: launcher remains local
- WHEN the NomadCraft server is unreachable
- THEN local account, instance, and Minecraft launch features remain available and the Nomad view shows the connection error.

## Requirement: backend-only control plane
The client SHALL treat the NomadCraft server as an API/control plane; local Minecraft and filesystem operations SHALL remain in the desktop main process or local agent.


## Requirement: instance source and instance-bound permissions
The desktop client SHALL distinguish local instances from NomadCraft cloud instances in every shared instance selector. Cloud selections SHALL retain their logical instance id, optional save id, and server-provided permissions.

### Scenario: select a cloud instance
- WHEN an authorized cloud instance is returned by the NomadCraft catalog
- THEN the launcher may show it alongside local instances with a visible cloud marker and SHALL NOT substitute a local instance when the cloud instance is selected

### Scenario: protect local-only actions
- WHEN a cloud instance is selected
- THEN local Java, memory, filesystem, install, and delete actions are disabled or routed to the NomadCraft cloud entry, and no local IPC operation is invoked for that cloud instance

### Scenario: display instance-bound authorization
- WHEN a cloud instance or save is selected
- THEN the launcher displays the effective permission summary derived from the instance and save-scoped permission lists, while NomadCraft remains the final authority for every mutation


## Requirement: optional startup animation
The desktop client SHALL expose a persisted startup animation switch in settings, defaulting to off.

### Scenario: startup animation disabled
- WHEN the client starts with the setting disabled or absent
- THEN it SHALL skip creating the splash window and show the main window through the normal ready-to-show path

### Scenario: startup animation enabled
- WHEN the client starts with the setting enabled
- THEN it SHALL use the existing startup animation and readiness gate
