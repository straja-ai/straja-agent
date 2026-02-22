# Attribution Notice

**Straja Agent** is derived from [OpenClaw](https://github.com/openclaw/openclaw),
originally created by Peter Steinberger and contributors.

This project has been modified substantially for Straja Vault-first execution and
filesystem isolation. All execution is sandboxed through `straja-vault` with no
direct host filesystem or native process access.

## License

The original OpenClaw code is licensed under the MIT License.
See the [LICENSE](./LICENSE) file for the full text.

Modifications copyright (c) 2025-2026 Straja contributors.
All modifications are also released under the MIT License.

## Key Architectural Differences from Upstream

- Native `exec` and `process` tools have been removed unconditionally.
- All execution runs through `vault_exec` / `vault_process` via the Straja Vault.
- All filesystem access is mediated by the vault (SQLite-backed workspace materialization).
- Network access is always blocked inside the execution sandbox (`--net-block`).
- The agent runtime is designed to operate with `straja-vault` and `straja-gateway`
  as separate, independent components.
