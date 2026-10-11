# Design

Keep willingness on User with a shared string enum. Expose self-only GET/PUT /auth/hosting-preference, validate exact request shape, resolve identity from authenticated session, and persist with Storage. Do not accept target UUID or permission fields. Legacy accounts default to medium. Surface the preference in the authenticated account response and in a personal settings page accessible to every user, plus the account dialog. None excludes future automatic election; manual hosting authorization remains unchanged and running tasks are not forcibly terminated. The selector remains unimplemented.

Research Velocity as center-owned protocol gateway, outbound agent tunnels, identity forwarding and a lightweight limbo during backend replacement. Distinguish persistent client connection from uninterrupted world simulation; document permissions versus untrusted simulation limits and mod compatibility.
