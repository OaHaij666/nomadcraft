# Design

Use fixed page declarations owned by the frontend. Never merge saved dashboard cards into product pages. Retain the backend instance model as the world/save boundary and existing route IDs for console compatibility. Admins create worlds using uploaded Minecraft server jars, imported server archives, or an existing directory; regular users see only assigned worlds. The game selector exposes Minecraft Java only. Remove template actions from instance configuration and shortcut menus. Preserve account creation because an uninitialized panel needs an administrator; remove its welcome/language/completion steps.

Continue the user's authorized implementation without another planning approval turn. The OpenSpec CLI is unavailable locally; author artifacts directly and validate changes through type checking, lint, frontend tests and browser checks.
