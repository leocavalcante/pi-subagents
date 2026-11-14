# AGENTS.md

pi-subagents: delegate tasks to isolated Pi subagents: single, parallel, chained, or in the background.

## Layout

- `index.ts` registers `subagent_agents`, `subagent_jobs`, and `subagent`.
- Root runtime modules implement agent discovery and listing, job/process management, output capture and paging, JSON protocol validation, usage accounting, chain substitution, Unicode handling, progress throttling, abort handling, and temporary-file cleanup: `agents.ts`, `agent-listing.ts`, `jobs.ts`, `capture.ts`, `protocol.ts`, `paging.ts`, `usage.ts`, `chain.ts`, `unicode.ts`, `progress.ts`, `abort.ts`, `temporary-files.ts`, and `windows-supervisor-invocation.ts`.
- `windows-supervisor.cs` contains Windows child-process supervision.
- `tests/*.test.ts` is the Bun lane. `tests/*.node-test.{ts,mjs}` is the Node.js lane; subprocess and file-system behavior belongs there.
- `.github/scripts/` contains CI and package-check scripts. `docs/` contains maintainer documentation and the extension standard.

## Commands

- `bun install --frozen-lockfile` installs dependencies.
- `bun run verify` runs lint, type checks, both test lanes, package checks, and the dependency audit.
- `bun run lint`, `bun run format`, and `bun run check` lint, format, and type-check the project.
- `bun run test:bun` and `bun run test:node` run one test lane; `bun run test` runs both.
- `bun run check:package` checks the packed npm package and its imported modules.
- `pi -e ./index.ts` loads this checkout in Pi.

## Rules

- Follow `docs/pi-extension-standard.md` and keep user documentation in its §10 voice.
- Write Conventional Commits. PR titles are imperative, lowercase, user-facing, at most 72 characters, and have no final period.
- Sign off every commit with `git commit -s`. Never add a `Co-Authored-By` trailer.
- Never bump the version, edit generated `CHANGELOG.md`, create tags or releases, or publish. The CD workflow does that.
- Keep Pi host packages in `peerDependencies` with version `"*"`, never in `dependencies`.
- Root runtime modules run on Node.js inside Pi. Use `node:*` APIs, never Bun APIs.
- Tests must not make network or paid model calls. Use fake child processes, synthetic Pi messages, and temporary directories.
- Update `README.md` and `CONTRIBUTING.md` when runtime behavior changes.

## Security boundaries

- Preserve POSIX process-group supervision and SIGTERM-to-SIGKILL escalation, and Windows Job Object containment through `windows-supervisor.cs`. Fail closed if setup or cleanup cannot establish containment.
- Preserve child JSON-record, stdout, stderr, message-history, model-response, and background-output limits. Drain and discard excess output without parsing it or leaving child processes running.
- Keep per-child deadlines, process-slot queue limits, abort handling, and cleanup behavior. A canceled wait must not cancel its background job; session shutdown must clean up active jobs.
- Preserve inherited-environment filtering, case-insensitive on Windows, and keep `PI_SUBAGENTS_NESTING_DEPTH` reserved so delegation cannot exceed two child-process levels.
- Preserve bounded agent discovery and project-agent file checks: reject project paths outside the project root and hard-linked project definitions; do not silently fall back when a nearer project-agent directory cannot be inspected.
- Keep project-agent approval mandatory for untrusted projects. Approval must summarize effective settings and must fail before launch if the complete prompt exceeds its limit.
- Context isolation is not an OS sandbox. Do not describe working-directory or tool-selection settings as access controls.
