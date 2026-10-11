# YSMViewer integration patches

Pinned revision: a30baf27425a9cc206af095600e3d98e4eb7f472. Original browser files are retained in source/. Core C# and ThreeJsPayloadBuilder are copied under ysm-engine/.

Renderer changes only:
- Update scene world matrices before computing the camera bounding box.
- Ignore invisible meshes/components during framing.
- Bind animation tracks by Object3D UUID instead of nested .children[] paths, which Three PropertyBinding cannot resolve.
- Skip vector keyframes containing unevaluated expressions instead of sending NaN to Three.js. Molang/controller execution remains unsupported by this browser renderer.
- Expose available animation names and pause/resume using its existing animation loop, without resetting the pose.
- Default front camera looks from negative Z, matching Minecraft model faces. Fit distance uses viewport aspect and FOV, so models use card space without clipping.

Adapter only loads default-visible geometry components for player preview, picks the selected texture, and communicates with Vue through an isolated local iframe. Three.js and OrbitControls are the exact upstream copies. No custom mesh, UV or material implementation.

ImageSharp dependency pinned to 3.1.12 (upstream 3.1.11). NuGet audit still reports existing advisories; version 3.2/4.x requires a Six Labors license and is not silently substituted. This local development change is not a published distribution.

Windows x64 .NET self-contained parser runtime is built from source by scripts/build-ysm-viewer.cjs. End users do not need .NET or network downloads. Other OS/architecture runtimes remain to be packaged.
