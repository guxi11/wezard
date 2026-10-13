# Codex repository instructions

## Shared project guidance

For operational requests to build, reload, or start the daemon/svr, execute the
commands below directly; do not first read CLAUDE.md, convention files,
package.json, or source files. Inspect files only if a command fails and diagnosis
requires it. This exception takes precedence over the reading requirements below.

Read [CLAUDE.md](./CLAUDE.md) before other work in this repository. Its architecture,
project conventions, release rules, and operational invariants also apply to
Codex. Keep shared guidance there rather than copying it into this file. The
corrections below take precedence over outdated statements in `CLAUDE.md`.

If available, read the convention files it references:
`~/develop/Guxi11/aiconfig/rules/chat.md` and
`~/develop/Guxi11/aiconfig/rules/code.md`. If absent, use the conventions recorded
in `CLAUDE.md` and the surrounding code.

## Project map

`wezard` bridges Claude Code, claude-internal, CodeBuddy, and Codex with WeCom.
It is a Node.js >= 20 TypeScript ESM project for macOS and Linux.

- `daemon/`: resident process, approval handling, inbound routing, tmux sessions,
  and transcript mirroring. It owns the WeCom connection.
- `cli/`: initialization, migration, configuration sync, and hook clients.
- `mcp/`: stateless stdio tools calling the daemon over loopback HTTP.
- `shared/`: configuration schemas, backend adapters, storage, and reusable logic.
- `svr/` and `web/`: standalone server and browser views.
- `hooks/`, `scripts/`, `launchd/`, `systemd/`: integration and service lifecycle.
- `tests/`: TypeScript assertion scripts; `dist/` is generated build output.

## Commands and validation

Use `package.json` as the source of truth for scripts:

```bash
npm run typecheck
npm run build
npm run dev:daemon   # tsx daemon/index.ts
npm run dev:cli      # tsx cli/init.ts
npx tsx tests/codex-backend.test.ts  # example: run a relevant assertion script
```

Tests exist despite the older “no tests” statement in `CLAUDE.md`. There is no
`npm test` script. Run relevant `tests/*.test.ts` files individually with `tsx`;
inspect their prerequisites before running integration checks. Typechecking
excludes `tests/`, so it does not replace running those scripts.

For runtime TypeScript changes, run typecheck and relevant tests.
Documentation-only changes need a review of links and commands. All development
task units also require the completion steps below.

When asked to **reload**, run `npm run build && ./cli/wezard.sh reload` from the
repository root. Use `./cli/wezard.sh` for local status/logs/reload operations.
Do not add typechecks or tests to an operational reload request.

When also asked to **reload svr** (`sver` is the same intent), build once, reload
the daemon if requested, then restart the existing svr service directly:
`launchctl kickstart -k "gui/$(id -u)/com.wezard.svr"` on macOS, or
`systemctl --user restart wezard-svr.service` on Linux. `./cli/wezard.sh svr`
starts svr in the foreground; use it when asked to run/start svr, not to restart
an already-running service. Request sandbox escalation if required by a failed
command rather than searching files for alternative commands.

After completing each development task unit, promptly build and reload both
services from the repository root: run `npm run build` once, then
`./cli/wezard.sh reload` for the daemon, then restart svr with
`launchctl kickstart -k "gui/$(id -u)/com.wezard.svr"` on macOS or
`systemctl --user restart wezard-svr.service` on Linux. Proceed only after each
step succeeds. Reuse a successful build of the completed changes if already run
for this unit; do not build again between service restarts. Operational-only
requests retain the requested scope described above.

## Editing conventions

- Preserve existing uncommitted work and keep edits scoped to the task.
- Edit source files; regenerate `dist/` through the build when needed.
- Follow existing ESM imports with `.js` extensions in TypeScript source.
- Keep reusable transformations pure and side effects at module boundaries.
- Use `shared/config-writer.ts` for on-disk JSONC configuration edits and
  `shared/exec-path.ts` for daemon spawn PATH handling.
- Add MCP tools with their daemon route handlers. Preserve compatibility with
  already-running clients and existing session identities.
- Update `CHANGELOG.md` for every version bump as described in `CLAUDE.md`.

## Codex backend invariants

Follow the Codex backend section of `CLAUDE.md` when touching
`shared/codex*.ts`, `cli/codex-*.ts`, or session spawning/sync code. In particular:

- Use native app-server thread start/resume/fork and actual rollout metadata;
  do not invent Claude-style paths or send bootstrap messages to create threads.
- Keep MCP and developer instructions invocation-local.
- Treat native sandbox approval separately from tool approval windows.
- Preserve third-party hooks and trust configuration during sync.
- Apply backend-specific fallback behavior; Claude's `ask` response is not a
  supported Codex PreToolUse response.
