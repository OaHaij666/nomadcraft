# World-centered Minecraft interface

## Why
The inherited panel exposes template markets, setup guides and editable dashboard cards. The user requested a world/save-centered interface with authentication separate from world selection, and Minecraft Java as the only selectable game. Continue the interrupted implementation in the existing workspace.

## What Changes
- Use fixed route layouts and remove card customization and its unused frontend code.
- Replace market/setup routes with a Minecraft world creation page using existing instance APIs.
- Present actual instances as worlds, retaining owner/admin authorization, files, mods and console.
- Replace onboarding with a single first-admin form.

## Impact
Frontend and localized product strings. Existing instance IDs and data remain compatible. No new room cardinality or hosting protocol is introduced.
