# Standardization plan: pi-subagents

Status: draft, 2026-11-10. Target: [Pi extension standard v1](pi-extension-standard.md). Delete this file once every step is done.

pi-subagents goes last because it has the largest test migration. It runs real Pi child processes, so most of its tests depend on Node.js runtime behavior.

## Target identity

| Field                   | Value                                                                                                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Description             | Delegate tasks to isolated Pi subagents: single, parallel, chained, or in the background.                                                                            |
| Topics and npm keywords | `pi-extension` `pi-package` `pi-coding-agent` `subagents` `multi-agent` `agent-orchestration` `background-jobs` `parallel-execution` `context-isolation` `ai-agents` |
| Website                 | https://pi.dev/packages/@leocavalcante/pi-subagents                                                                                                                  |
| Kind                    | Extension                                                                                                                                                            |
| Pi versions             | Minimum 1.0.4, paired with Pi Codemode 1.1.0; tested with 1.5.2                                                                                                      |

## Where it stands

- **CI and publishing are mature.**
  - CI tests 4 operating systems × 3 Node.js versions plus the 22.19.0 floor.
  - Separate jobs test Pi 1.0.4, 1.1.0, and 1.3.0, with actionlint and npm audit.
  - Publishing is triggered by GitHub releases and runs a preflight script.
  - CodeQL covers JavaScript and C#. Dependabot already uses Conventional Commit prefixes.
- **Classic branch protection** requires 5 matrix check names.
- **npm and tags.** npm 0.2.0 has provenance. Tags cover v0.1.1–v0.2.0. 0.1.0 has no tag; npm recorded commit `eea309a`.
- **An unreleased feature is waiting.** `feat: add per-subagent display names (#393)` landed after v0.2.0, so the first `cd.yaml` run publishes **0.3.0**.
- **GitHub settings.** The About text differs from npm. There are 12 topics and no website.
- **Layout.** 15 modules and `windows-supervisor.cs` sit at the repository root. `files` lists each one and also ships CONTRIBUTING and SECURITY.
- **Toolchain.** npm, TypeScript 7.0.2 (typescript-eslint needs 6.0.x or earlier), tabs, and no formatter or linter.
- **Tests.**
  - 15 `.test.mjs` files use `node:test`, load TypeScript through jiti, and call `t.mock` 17 times.
  - `tests/documentation.test.mjs` (37 tests) and `tests/release-preflight.test.mjs` (9 tests) check today's CI, release flow, and docs, so they change along with them.
- **README.** It installs `@0.2.0`. Pi never updates a pinned install, so users who follow it never get updates.
- **LICENSE.** It carries only Mario Zechner's notice, because the code started as Pi's subagent example.
- **Measured:**
  - Node.js: 343 pass, 2 fail, 3 skip on this machine.
  - Bun, with a 30-second timeout: 332 pass, 13 fail, 3 skip. All 13 failures involve child processes, pipes, or file-system races.
  - TypeScript 6.0.3 reports no errors; `noUncheckedIndexedAccess` adds 70.

## Steps

Each step is one pull request unless marked otherwise. "Release" is what `cd.yaml` publishes after the merge.

| #   | Change                                                    | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Release          |
| --- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 0a  | _Baseline_                                                | Find out why 2 tests fail under Node.js on this machine. Compare with the last CI run; the most recent pull request run failed on 2026-11-02. Fix them or document them before migrating, so step 1 starts from a green suite.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | —                |
| 0b  | _Settings_                                                | Standard A.11 except rulesets. Replace the 12 topics. Optionally tag `v0.1.0` at `eea309a`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | —                |
| 1   | `build: adopt the Bun and TypeScript 6 toolchain with CI` | <ul><li>`bun.lock` replaces `package-lock.json`, and TypeScript 7.0.2 becomes 6.0.3 with the shared tsconfig.</li><li>**Every existing test stays on Node.js for now.** Rename `*.test.mjs` to `*.node-test.mjs`; until step 7, the Node.js lane's pattern also accepts `.mjs`.</li><li>Add `tests/load.node-test.ts`.</li><li>`ci.yaml` gets the shared jobs, with Windows and macOS running the full Node.js lane for Job Object and process-group tests. `pi-min` covers Pi 1.0.4 with Codemode 1.1.0, plus a local job for Pi 1.1.0 with Codemode 1.1.0.</li><li>Add `pr-title.yaml`, and switch Dependabot to the `bun` ecosystem.</li><li>Delete `test.yml` and `codeql.yml`; CodeQL default setup also detects C#.</li><li>Update the documentation tests that check the old CI.</li><li>Merge using the cutover checklist.</li></ul> | none             |
| 2   | `ci: release to npm automatically from main`              | <ul><li>Add `cd.yaml`, `.releaserc.json`, and `cliff.toml`.</li><li>Set the version to `0.0.0-development`, and add `CHANGELOG.md` to `files` and `.gitignore`.</li><li>Delete `publish.yml`, `.github/scripts/check-release-package.mjs`, and `tests/release-preflight.test.mjs`; semantic-release checks the tag and version itself.</li><li>Move the trusted publisher from `publish.yml` to `cd.yaml`.</li></ul>                                                                                                                                                                                                                                                                                                                                                                                                                         | **0.3.0** (#393) |
| 3   | `style: format with Prettier`                             | Tabs become 2 spaces. Formatting changes only. CI starts running `prettier --check`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | none             |
| 4   | `chore: ignore the formatting commit in git blame`        | `.git-blame-ignore-revs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | none             |
| 5   | `chore: lint with typescript-eslint`                      | Add `eslint.config.mjs` and apply the fixes that don't change behavior. Each real bug ESLint finds gets its own `fix:` PR.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | none             |
| 6   | `docs(readme): adopt the shared structure and voice`      | <ul><li>README:<ul><li>Use an unpinned install command.</li><li>Tell users with a pinned install to run `pi remove npm:@leocavalcante/pi-subagents`, then `pi install npm:@leocavalcante/pi-subagents`.</li><li>Use the new tagline and the Compatibility template.</li><li>Move the origin story to License.</li></ul></li><li>CONTRIBUTING keeps the Windows containment notes.</li><li>Add AGENTS.md, the issue forms, the PR template, CODEOWNERS, and the standard.</li><li>LICENSE adds `Copyright (c) 2026 Leo Cavalcante` and keeps Mario Zechner's notice.</li><li>`files` adds `CHANGELOG.md` and drops CONTRIBUTING and SECURITY.</li><li>Update the documentation tests to match.</li></ul>                                                                                                                                      | patch            |
| 7   | `test: run logic tests on Bun`                            | <ul><li>Convert the suites that don't start processes to TypeScript on `bun:test`: paging, protocol, Unicode, progress, abort, usage, and chain.</li><li>Convert the process and file-system suites to TypeScript `*.node-test.ts`.</li><li>Replace `t.mock` with `bun:test` mocks where suites move.</li><li>Drop the `.mjs` exception.</li></ul>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | none             |
| 8   | `refactor: check indexed access`                          | Turn on `noUncheckedIndexedAccess` and fix the 70 sites.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | none             |
| 9   | `refactor: move modules into src/`                        | `pi.extensions` points to `./src/extension.ts`, with `windows-supervisor.cs` alongside it. A root `index.ts` re-export stays for one release, for anyone loading the file directly. Update the README's junction-based checkout instructions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | none             |
| 10  | _After the releases_                                      | Deprecate `0.0.0-stage`. Add `pi.image`, showing a parallel run with display names, and the social preview. Turn on `sha_pinning_required`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | —                |

## Cutover checklist

**Branch protection (step 1).** Classic protection requires 5 matrix check names that the new CI no longer reports, and the rule applies to admins.

- [ ] Open step 1's PR and wait for `required` and `pr-title` to pass.
- [ ] Create the `main` and `v*` rulesets (standard A.10).
- [ ] Delete classic protection: `gh api -X DELETE repos/leocavalcante/pi-subagents/branches/main/protection`.
- [ ] Merge step 1, then turn on CodeQL default setup. Step 1 deleted `codeql.yml`.

**Publishing (step 2).** Merging step 2 publishes 0.3.0 immediately.

- [ ] Run `npm login`, then `npm trust list @leocavalcante/pi-subagents`. It currently points to `publish.yml`.
- [ ] Run `npm trust github @leocavalcante/pi-subagents --file cd.yaml --repo leocavalcante/pi-subagents --env npm --allow-publish`, and revoke the `publish.yml` entry.
- [ ] Create the `npm` environment, with `main` as its only deployment branch.
- [ ] Merge step 2, then check:
  - [ ] Tag `v0.3.0` exists.
  - [ ] npm 0.3.0 has provenance.
  - [ ] The GitHub release has notes listing #393.
  - [ ] The tarball contains `CHANGELOG.md` and every module the entry point imports.

## Notes and risks

- **Node.js is the reference runtime here.** The extension supervises Pi child processes: process groups and SIGKILL escalation on POSIX, Job Objects on Windows. Those tests must keep running on Node.js on all three operating systems. Bun's emulation fails 13 of them.
- **Codemode pins.** Pi 1.0.4 and 1.1.x need Codemode 1.1.0 because Codemode 1.2.0 removed an export they import ([upstream report](https://github.com/earendil-works/pi/issues/10865)). Keep the pin in the `pi-min` jobs until the minimum Pi moves past 1.1.
- **Reformatting.** Tabs to spaces touches almost every line. Merge or close the 3 open PRs before step 3.
- **Package contents.** The documentation tests check that the package includes every module the entry point imports. Keep that check through the `src/` move in step 9; it protects the published package.

## Rollout across the extensions

This section is identical in every repository's plan.

**Order:**

1. Retire pi-ttyd.
2. pi-otel, the pilot, which also ships its missing fix.
3. pi-a2a.
4. pi-tmux, which becomes the reference implementation.
5. pi-subagents, which has the largest test migration.

Finish a repository's steps 1–3 before starting the next one, so each migration builds on the last.

**npm account (once, interactive):**

1. Run `npm login`, then `npm trust list <package>` for each package to record today's trusted publishers.
2. At each repository's step 2, run `npm trust github <package> --file cd.yaml --repo leocavalcante/<repo> --env npm --allow-publish`. This replaces any `publish.yml` entry.
3. Set each package's publishing access to "require 2FA and disallow tokens".
4. Run `npm deprecate <package>@0.0.0-stage "Bootstrap placeholder; not a release."`

**Retire pi-ttyd.** It has no open issues or pull requests, and about 17 downloads a week.

1. Merge `docs: mark pi-ttyd as unmaintained`. The README opens with: "**pi-ttyd is no longer maintained.** Published versions stay installable, but they won't get updates or security fixes. Remove it with `pi remove npm:pi-ttyd`."
2. Run `npm deprecate pi-ttyd "pi-ttyd is no longer maintained. Remove it with: pi remove npm:pi-ttyd"`.
3. Run `gh repo edit leocavalcante/pi-ttyd --description "Unmaintained. Set ttyd tab titles, notify you when Pi is ready, and accept dropped images."`.
4. Run `gh repo archive leocavalcante/pi-ttyd --yes`.
