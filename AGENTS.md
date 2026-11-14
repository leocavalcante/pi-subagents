# AGENTS.md

pi-subagents: delegate tasks to isolated Pi subagents: single, parallel, chained, or in the background.

## Commands

- `bun install --frozen-lockfile` installs dependencies.
- `bun run verify` runs every check CI runs.
- `bun run test:bun` and `bun run test:node` run one test lane.
- `bun run format` applies Prettier and ESLint fixes.
- `pi -e ./src/extension.ts` tries the checkout in Pi.

## Rules

- Follow docs/pi-extension-standard.md.
- Write Conventional Commits. The PR title becomes the release note (standard §10, rule 11).
- Sign off every commit (`git commit -s`). Never add Co-Authored-By.
- Never bump the version, edit CHANGELOG.md, create tags or releases, or publish. cd.yaml does that.
- Code in src/ runs on Node.js inside Pi: use `node:*` APIs, never Bun APIs.
- Keep Pi host packages, such as `@earendil-works/pi-coding-agent` and `typebox`, as `"*"` peer dependencies, never dependencies.
- Tests make no network or paid model calls.
- Update README.md and CONTRIBUTING.md with every behavior change, in the voice from standard §10.

## Project notes

### Layout

- `src/extension.ts` registers `subagent_agents`, `subagent_jobs`, and `subagent`; Pi loads it through `package.json` `pi.extensions`.
- The other `src/` modules implement agent discovery and listing, job/process management, output capture and paging, JSON protocol validation, usage accounting, chain substitution, Unicode handling, progress throttling, abort handling, and temporary-file cleanup: `agents.ts`, `agent-listing.ts`, `jobs.ts`, `capture.ts`, `protocol.ts`, `paging.ts`, `usage.ts`, `chain.ts`, `unicode.ts`, `progress.ts`, `abort.ts`, `temporary-files.ts`, and `windows-supervisor-invocation.ts`.
- `src/windows-supervisor.cs` contains Windows child-process supervision.
- `tests/*.test.ts` is the Bun lane. `tests/*.node-test.{ts,mjs}` is the Node.js lane; subprocess and file-system behavior belongs there.
- `.github/scripts/` contains CI and package-check scripts. `docs/` contains maintainer documentation and the extension standard.

### Boundaries to preserve

- Preserve POSIX process-group supervision and SIGTERM-to-SIGKILL escalation, and Windows Job Object containment through `windows-supervisor.cs`. Fail closed if setup or cleanup cannot establish containment.
- Preserve child JSON-record, stdout, stderr, message-history, model-response, and background-output limits. Drain and discard excess output without parsing it or leaving child processes running.
- Keep per-child deadlines, process-slot queue limits, abort handling, and cleanup behavior. A canceled wait must not cancel its background job; session shutdown must clean up active jobs.
- Preserve inherited-environment filtering, case-insensitive on Windows, and keep `PI_SUBAGENTS_NESTING_DEPTH` reserved so delegation cannot exceed two child-process levels.
- Preserve bounded agent discovery and project-agent file checks: reject project paths outside the project root and hard-linked project definitions; do not silently fall back when a nearer project-agent directory cannot be inspected.
- Keep project-agent approval mandatory for untrusted projects. Approval must summarize effective settings and must fail before launch if the complete prompt exceeds its limit.
- Context isolation is not an OS sandbox. Do not describe working-directory or tool-selection settings as access controls.
