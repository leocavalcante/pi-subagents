# pi-subagents

A Pi extension that delegates tasks to separate Pi processes with isolated context windows.

Extracted from Leo Cavalcante's dotfiles and based on the subagent example bundled with Pi 1.0.0. Adds session-owned background execution.

## Installation

Requires Pi. Tested with Pi 1.0.4. Pi provides the runtime dependencies, so no build step is needed.

Install from npm:

```sh
pi install npm:@leocavalcante/pi-subagents
```

Or install from GitHub:

```sh
pi install git:github.com/leocavalcante/pi-subagents
```

For a local checkout:

```sh
pi install ./pi-subagents
```

Run `/reload` in Pi after installation. Remove any previous copy or symlink at `~/.pi/agent/extensions/subagent` before installing the package to avoid registering the tool twice.

For development without changing Pi settings, symlink the checkout instead:

```sh
mkdir -p ~/.pi/agent/extensions
ln -s "$PWD" ~/.pi/agent/extensions/subagent
```

Run that command from the checkout, with no existing `subagent` directory. Use either a package install or the symlink, not both.

## Agent definitions

Keep personal agent definitions in `~/.pi/agent/agents/*.md`. They are not bundled with this package.

```markdown
---
name: worker
description: General-purpose worker
---

Complete the delegated task. Report the changes made and checks run.
```

An agent can set `model`, `thinking`, and `tools` in its frontmatter:

```yaml
model: anthropic/claude-sonnet-4-5
thinking: high
tools: [read, bash]
```

Without `model`, it inherits the parent's active model and thinking level. An explicit `thinking` overrides the inherited level or the level in a model suffix. Valid levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; Pi clamps them to the model's capabilities.

Without `tools`, it uses Pi's defaults. Both `tools: read, bash` and `tools: [read, bash]` work. Set `tools: []` to disable the initial tool selection. This is not a sandbox; extensions can still change the selection.

Definitions need non-empty `name` and `description` fields. Invalid YAML or configuration skips that definition instead of breaking discovery for all agents. Duplicate names in the same directory produce a diagnostic naming both files. The last valid definition in filename order still wins. Intentional project-over-personal overrides do not produce a duplicate warning.

Project-local definitions live in `.pi/agents/*.md`. The tool loads only personal agents by default. Set `agentScope: "project"` or `"both"` to include project agents. Project definitions override personal definitions of the same name when using `"both"`.

## Usage

Use `subagent_agents` to list agent descriptions, source paths, model and tool settings, and invalid definitions without running an agent:

```json
{}
```

The default scope is `"user"`. To include project definitions:

```json
{ "agentScope": "both" }
```

The list is sorted by name and excludes system prompt bodies. Project lookup starts at the parent session's working directory and checks ancestors for the nearest `.pi/agents` directory. A task's `cwd` changes where its child runs, not which definitions it loads.

Ask Pi to delegate:

```text
Use worker to review the authentication code without changing files.
Run two workers in parallel: one to inspect authentication, one to inspect tests.
Use a chain: worker reviews the code, then worker evaluates the findings.
```

The `subagent` tool accepts exactly one mode. Empty arrays, blank tasks, partial single-task parameters, and unknown agents are rejected before any child starts:

| Mode | Parameters | Execution |
| --- | --- | --- |
| Single | `{ agent, task }` | One task |
| Parallel | `{ tasks: [{ agent, task }, ...] }` | Up to 8 tasks, up to 4 concurrent |
| Chain | `{ chain: [{ agent, task }, ...] }` | Sequential, with `{previous}` substituted into each task |

At the first chain step, `{previous}` is an empty string. A first task containing only that placeholder is rejected before approval or launch. If a later substitution makes the task blank, the chain stops at that step without starting another child.

Use `cwd` to set a working directory. Relative paths resolve from the parent session's working directory. Parallel and chain entries accept their own `cwd`. Tasks reach children through stdin, so large prompts do not depend on the operating system's command-line argument limit.

Foreground execution is the default. Progress streams into the parent session. Ctrl+O expands tool output. Ctrl+C cancels foreground child processes. Model-facing text is capped at 50 KiB per response, including headers and truncation notices. The same limit applies to progress updates, single tasks, chains, and entire parallel batches. Parallel tasks share the available text budget so every task's status remains visible. Captured results remain in tool details, and chains pass the full captured final text to the next step.

Collapsed tool output shows bounded text previews rather than wrapping an entire long line. Expand with Ctrl+O to see captured final text. All modes show process, protocol, and model failure diagnoses, including stderr when no explicit error message is available. Tool arguments remain compact previews in either view.

## Model and thinking overrides

Set `model` or `thinking` on a call without editing the agent definition:

```json
{
  "agent": "worker",
  "task": "Review the authentication tests without changing files.",
  "model": "anthropic/claude-sonnet-4-5",
  "thinking": "low"
}
```

Parallel and chain entries accept the same fields. Each field resolves independently, with precedence: entry, top-level call, agent frontmatter, then parent session. Parent thinking is inherited only when the model is also inherited from the parent. If neither the call nor the agent sets `thinking`, an explicit model uses Pi's configured default or model suffix instead.

Model selectors support Pi's `provider/id` and `:thinking` syntax. A resolved `thinking` setting overrides a model suffix. These options work in foreground and background modes and leave the agent's tools and project approval unchanged.

## Batch concurrency

Parallel mode accepts `concurrency` from 1 to 4, with a default of 4. Use `concurrency: 1` to run independent tasks serially without chaining their output. All batches still share the same four-process budget; this option never raises it. Single and chain modes reject this option.

## Task deadlines

Set `timeoutMs` to bound a child's runtime:

```json
{
  "agent": "worker",
  "task": "Review authentication without changing files.",
  "timeoutMs": 120000
}
```

There is no deadline by default. Values must be whole milliseconds between 1 and 86400000, up to 24 hours. The timer starts at child spawn; permission prompts, prompt-file preparation, and waiting for a process slot do not count.

For parallel and chain modes, a top-level `timeoutMs` is the default for each child, not a deadline for the entire batch. An entry's `timeoutMs` overrides that default. Deadlines also work with background execution.

A timeout terminates the child using the same process-group cleanup as cancellation and returns a failed result with `timedOut: true` in details. Cleanup can take an additional second for SIGKILL escalation. Background jobs report `failed`, not `canceled`. Chains stop at the timed-out step; other parallel tasks continue. Explicit user cancellation still reports `canceled`.

## Background execution

Add `background: true` to any mode. The tool returns a job ID immediately, allowing the parent to continue working. For example:

```json
{
  "agent": "worker",
  "task": "Review the authentication code without changing files.",
  "background": true
}
```

Or ask Pi:

```text
Run a worker in the background to review authentication while you inspect the tests.
```

A finished job sends its result as a follow-up. If the parent is busy, Pi queues it after the current work. If idle, Pi starts a turn to handle the result. Failed and canceled jobs also report back.

The `subagent_jobs` tool manages jobs:

```json
{ "action": "list" }
{ "action": "status", "jobId": "<job ID>" }
{ "action": "output", "jobId": "<finished job ID>", "taskIndex": 0, "offset": 0, "limit": 16384 }
{ "action": "cancel", "jobId": "<job ID>" }
{ "action": "forget", "jobId": "<finished job ID>" }
{ "action": "clear" }
```

Status returns retained progress or the final result. Do not poll continuously; completion messages arrive automatically. Cancellation is idempotent and may briefly show `canceling` while child processes exit.

`forget` removes one finished job record. `clear` removes all finished records without canceling active jobs. Forgetting an active job is rejected; cancel it and wait for cleanup first. These operations do not erase completion messages or Pi session history.

Background jobs have their own abort controllers. Ctrl+C on the parent's turn does not cancel them. Use `subagent_jobs` to cancel a job. On POSIX, cancellation signals the child's process group, including ordinary tool descendants, and escalates from SIGTERM to SIGKILL after one second. On Windows, it signals the direct child only.

Foreground calls and background jobs share a limit of four direct child processes per extension runtime. There can be up to eight active background jobs, with at most eight tasks in each parallel batch. Tasks waiting for a process slot can also be canceled. The extension retains the latest 32 finished job records for inspection. Finished output in this registry has a shared 32 MiB budget, estimated from serialized message records, task text, stderr, and result text. Oldest output is evicted first; an individually oversized result is not retained. Job state remains available with `outputEvicted: true`, and completion delivery still receives the result before eviction. This registry budget is not a heap-memory limit or a cap on Pi's own session history.

Completion and status text are capped at 50 KiB including headers and truncation notices, with captured output retained in details. Jobs live only in the current Pi session. Quit, `/reload`, and session replacement cancel active jobs and discard job history. Jobs do not survive a Pi restart.

Background execution requires a long-lived TUI or RPC session. Print and JSON modes must use foreground execution so they do not exit with unfinished work.

## Read captured job output

After a job finishes, `action: "output"` reads a page of a task's captured final text or failure diagnosis. `taskIndex` is zero-based and defaults to 0. For a parallel batch or chain, use the task's position in the original request. Status reports `resultCount` while results are retained.

`offset` is a UTF-8 byte offset, not a character count. Start at 0 and use the returned `nextOffset` until it is `null`. `limit` is 4 to 32768 bytes, with a default of 16384. Pages never split a UTF-8 character. Active jobs, unavailable captures, invalid indices, and offsets inside a character return an error. Evicted output cannot be recovered from this registry.

Job operations also return structured data to codemode scripts. List returns `{ action, jobs }`, inspection returns `{ action, job }`, and output adds an `output` page. Errors include `error`. Job metadata contains state and timestamps but no full message capture. Page responses do not copy the full capture into session history again.

For a completed job:

```js
const result = await tools.subagent_jobs({ action: "output", jobId: "<job ID>", taskIndex: 0 });
if (result.error) throw new Error(result.error);
text(result.output.text);
store("next-output-offset", result.output.nextOffset);
```

Read additional pages only when needed. Completion delivery still arrives automatically, so do not poll for it.

## Output capture and cleanup

Each child has bounded output capture:

- JSONL records can be up to 8 MiB in UTF-8. An oversized record fails the task, is discarded through the next newline, and does not stop stream draining.
- Stderr retains its first 64 KiB, including a truncation notice. Further stderr is drained and discarded.
- Message history retains at most 128 recent messages and 16 MiB of source JSON records. Evicting earlier messages does not change aggregate usage totals.

Results and tool details report capture truncation. These are capture limits, separate from the 50 KiB model-visible output limit. Discarded records and evicted history are not preserved elsewhere.

A zero exit code alone is not success. The child must emit a completed assistant message. Invalid JSONL, more than 128 levels of JSON nesting, or malformed assistant metadata fails the task without crashing the parent. Redacted thinking blocks are supported, and a successful retry clears errors from earlier attempts.

After a child exits, its output pipes get one second to drain. If inherited handles keep the pipes open, the extension cleans up the POSIX process group with SIGTERM and SIGKILL, then closes its pipe ends. Windows closes the inherited pipes but does not terminate descendants. Results report this cleanup instead of waiting indefinitely for `close`.

## Security

Context isolation is not a sandbox. Children run with the same OS permissions as Pi and can read or modify files. Include relevant context and task restrictions in each delegation.

Only enable project-local agents in repositories you trust. Interactive sessions ask before running project agents in untrusted projects unless `confirmProjectAgents` is disabled.

Authenticate on each machine with Pi's `/login`. Do not put credentials, sessions, or machine-local Pi state in this repository.

## Development checks

Install the pinned development SDK and test loader locally. This also works when Pi is installed as a standalone binary:

```sh
npm ci --ignore-scripts
npm run check
npm test
```

Set `PI_PACKAGE_DIR` to an npm Pi package directory to test against another SDK version. Standalone binary directories fall back to the local development SDK. The tests use fake child processes and make no model calls. They cover agent discovery and configuration, dispatch, output limits, rendering, process budgets, deadlines, cancellation and shutdown, including POSIX descendants and SIGKILL escalation. GitHub Actions runs the type check and tests on Linux and Windows with Node.js 22 and 24.

## Publishing

GitHub Actions tests pushes and pull requests. Publishing a stable GitHub
release tagged `v<package.json version>`, such as `v0.1.0`, runs the same test
matrix before publishing `@leocavalcante/pi-subagents` to npm with provenance.
Prereleases are not published. Bump `package.json` and `package-lock.json`
together before each new release. npm versions cannot be overwritten.

The publishing workflow uses npm Trusted Publishing with GitHub OIDC. It does
not use an npm token or an Actions publishing secret.

npm requires the package to exist before configuring a trusted publisher.
Bootstrap version `0.1.0` once from this checkout using interactive npm login
and 2FA, without creating a CI token:

```sh
npm login
npm ci --ignore-scripts
npm run check
npm test
npm publish --access public --provenance=false --ignore-scripts
```

The initial local publish has no provenance. Configure the package's trusted
publisher on npm using GitHub owner `leocavalcante`, repository `pi-subagents`,
and workflow filename `publish.yml`. Leave the environment name blank and
allow `npm publish`. The workflow must already exist on GitHub.

After configuring trust, select "Require two-factor authentication and disallow
tokens" in npm's publishing access settings. Bump to a new version, such as
`0.1.1`, before publishing a GitHub release. Do not run the workflow for the
already-published bootstrap version. Later releases publish through OIDC with
provenance. See [npm's trusted publishing guide](https://docs.npmjs.com/trusted-publishers/)
and the [package-existence prerequisite](https://docs.npmjs.com/cli/v11/commands/npm-trust/#prerequisites).

## Origin and license

Based on the [Pi subagent example](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent) bundled with `@earendil-works/pi-coding-agent` 1.0.0.

MIT license. The original copyright notice for Mario Zechner is preserved in [LICENSE](LICENSE).
