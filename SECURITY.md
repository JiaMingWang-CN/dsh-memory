# Security Policy

## Reporting a vulnerability

Please do **not** open a public issue for a security problem. Report it privately to the maintainers through the repository's security advisory feature or the contact in the repository profile.

Include:

- affected version and DSH/Node versions;
- a minimal reproduction;
- impact, especially any cross-workspace leakage or secret exposure;
- whether you are willing to provide a fix.

We will acknowledge receipt, investigate, and coordinate disclosure after a fix is available.

## Security model

- Memory data stays on the local machine under `$DSH_HOME`; the plugin does not upload data.
- Captured fields and imported text are redacted before persistence.
- Workspace scope filtering is exact; global scope is limited to preferences.
- Permanent delete, `Purge all`, `rebuild` and import `replace` are destructive operations and must be performed only through explicit user management actions.
- Session logs remain the source of truth; plugin state is a derived knowledge store.
