# World interface

## ADDED Requirements

### Requirement: Authentication and world selection
The interface SHALL show authentication before world selection. After login administrators SHALL see real worlds and regular users SHALL see only their assigned worlds.

#### Scenario: Login
- **WHEN** an unauthenticated user opens the application
- **THEN** the user sees login fields without example worlds or a room picker

### Requirement: Fixed product pages
Pages SHALL use fixed layouts. The application SHALL NOT expose card insertion, dragging, resizing, dashboard editing, template markets or quick-start guides. Saved custom dashboards SHALL NOT override product pages.

#### Scenario: Existing layout
- **WHEN** a user opens the application with previously customized layouts
- **THEN** the application renders the fixed world interface

### Requirement: Minecraft world creation
Administrators SHALL be able to select Minecraft Java and create a world through existing instance APIs. Unsupported games SHALL NOT be selectable. Files, mods and terminal operations SHALL remain available for existing worlds.

#### Scenario: Create world
- **WHEN** an administrator supplies a Minecraft server jar, server archive or existing server directory
- **THEN** the created instance is accessible from the world list and its console

### Requirement: Initial administrator
An uninitialized panel SHALL offer a single administrator creation form with the existing password rules and no tutorial steps.

#### Scenario: Fresh installation
- **WHEN** there are no administrator accounts
- **THEN** account creation remains possible and leads to login
