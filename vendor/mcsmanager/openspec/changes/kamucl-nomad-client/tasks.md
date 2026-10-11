- [x] Research KAMUCL feature set, network boundaries, architecture, and license scope
- [x] Import a sparse KAMUCL source checkout under vendor/kamucl
- [x] Add the first NomadCraft main-process API client and typed IPC bridge
- [x] Add a bundled NomadCraft renderer view for service connection, login, and catalog read
- [x] Merge NomadCraft into the existing multiplayer section with local-hosting and cloud entry points
- [x] Preserve the panel session cookie in memory and verify test-account catalog access
- [x] Add instance-source projections for local/cloud selection and carry instance/save-scoped permissions into the client
- [x] Guard local instance selectors and resource actions against accidental cloud fallback
- [x] Add a settings switch for the startup animation, defaulting to off
- [x] Build and run the KAMUCL unit/type checks for the integration slice
- [x] Remove the legacy launcher base, patch, tests, and superseded launcher change artifacts
- [ ] Replace local catalog display with cloud instance sync and room actions
- [ ] Supervise nomad-agent and connect local node registration/claim lifecycle
- [ ] Add cloud package/config revision download while preserving local resources and runtime data
- [ ] Verify real Windows packaged client with Microsoft login and a real Nomad panel

Validation on 2026-10-11: KAMUCL NC 0.1.0 TypeScript check passed; npm run build passed; the multiplayer/navigation regression set passed 9/9 after adding the local/cloud entry layer. The earlier full KAMUCL suite passed 1588 with 1 platform skip and 0 failures. No release artifact was published. The NomadCraft release repository and official update channel are not configured yet. Real Microsoft login, room actions, node-agent supervision, and a real remote deployment remain pending.

Validation on 2026-10-11: cloud instance projections and instance/save-scoped permission guards were added. TypeScript check passed and the multiplayer/navigation regression set passed 9/9. The development client remained running for visual review, so the production build was not rerun after this slice because Windows locked out/main/WindowMaterial.exe. No release artifact was published.
