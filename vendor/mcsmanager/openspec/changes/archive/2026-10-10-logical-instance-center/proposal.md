# Logical Minecraft instance center

## Why
The user requires versioned logical Minecraft instances, multiple independent saves per instance, and at most one room per save. The panel currently equates remote processes with worlds.

## What Changes
- Central persistent instance catalog, save records and unique room records.
- Instance creation authorization, per-instance and per-save capability grants, separate hosting eligibility and Minecraft OP policy.
- Instance center and detail pages for saves, distribution/runtime profile, mod manifest, access and activity.
- Existing process tools remain under operational management; room desired state is not reported as running without an executor.

## Impact
Panel API and Vue frontend. Existing daemon instances and files are not moved or deleted.
