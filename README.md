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

Project-local definitions live in `.pi/agents/*.md`. The tool loads only personal agents by default. Set `agentScope: "project"` or `"both"` to include project agents. Project definitions override personal definitions of the same name when using `"both"`. Project agent directories and files may use symlinks that resolve within the project root; links resolving outside it are skipped and reported as diagnostics. Personal agent symlinks are unchanged.

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
| Chain | `{ chain: [{ agent, task, id? }, ...] }` | Up to 32 sequential steps, with `{previous}` and named output references |

At the first chain step, `{previous}` is an empty string. A first task containing only that placeholder is rejected before approval or launch. If a later substitution makes the task blank, the chain stops at that step without starting another child.

Use `cwd` to set a working directory. Relative paths resolve from the parent session's working directory. Parallel and chain entries accept their own `cwd`. Tasks reach children through stdin, so large prompts do not depend on the operating system's command-line argument limit.

Foreground execution is the default. Progress streams into the parent session. Ctrl+O expands tool output. Ctrl+C cancels foreground child processes. Model-facing text is capped at 50 KiB per response, including headers and truncation notices. The same limit applies to progress updates, single tasks, chains, and entire parallel batches. Parallel tasks share the available text budget so every task's status remains visible. Captured results remain in tool details, and chains pass the full captured final text to the next step.

Collapsed tool output shows bounded text previews rather than wrapping an entire long line. Expand with Ctrl+O to see captured final text. All modes show process, protocol, and model failure diagnoses, including stderr when no explicit error message is available. Tool arguments remain compact previews in either view.

## Named chain outputs

Give a chain step an optional `id` to reuse its output in any later step:

```json
{
  "chain": [
    { "id": "review", "agent": "worker", "task": "Review the authentication code without changing files." },
    { "id": "tests", "agent": "worker", "task": "Inspect the tests without changing files." },
    { "agent": "worker", "task": "Compare the code review with the test findings. Review: {steps.review}\nTests: {steps.tests}" }
  ]
}
```

`{previous}` still means the immediately preceding step's captured final text. `{steps.ID}` means the captured final text from an earlier step with that ID. IDs are case-sensitive and unique within a chain. Use 1 to 64 ASCII characters: a leading letter, then letters, digits, underscores, or hyphens.

The tool rejects invalid IDs, duplicate IDs, and unknown, self, or forward references before approval or child launch. A failed step still stops the chain. If substitution produces a blank task, the next child does not start.

References use full captured text, not the model-facing preview. Substitution happens once, so placeholders and dollar sequences inside an agent's output stay literal. This works in foreground and background chains, including silent jobs. Captured step results include `stepId`, and output pages include it when present. Pagination still selects steps by zero-based `taskIndex`.

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

By default, a finished job sends its result as a follow-up. If the parent is busy, Pi queues it after the current work. If idle, Pi starts a turn to handle the result. Failed and canceled jobs also report back.

Set `notify: false` for a silent background job:

```json
{
  "agent": "worker",
  "task": "Review the authentication code without changing files.",
  "background": true,
  "notify": false
}
```

Silent jobs do not send automatic follow-ups, including failures and cancellations, and do not trigger another parent turn. Results remain available through `subagent_jobs` status, output, and wait. The `notify` flag is background-only, defaults to true, and applies to the whole job in every mode. Launch details and job metadata expose the policy, and the job list marks silent jobs.

Use a silent job with a bounded `wait` when the parent will consume its result explicitly. Silent jobs have the same process, capture, and retention limits. If their output is evicted, there is no completion-message copy to recover.

The `subagent_jobs` tool manages jobs:

```json
{ "action": "list" }
{ "action": "status", "jobId": "<job ID>" }
{ "action": "wait", "jobId": "<job ID>", "timeoutMs": 30000 }
{ "action": "output", "jobId": "<finished job ID>", "taskIndex": 0, "offset": 0, "limit": 16384 }
{ "action": "cancel", "jobId": "<job ID>" }
{ "action": "forget", "jobId": "<finished job ID>" }
{ "action": "clear" }
```

Status returns retained progress or the final result. Job-level error diagnostics are capped at 2 KiB without splitting UTF-8 characters. If both the run and completion delivery throw, the diagnostic keeps both causes. Do not poll continuously; non-silent jobs send completion messages automatically. Cancellation is idempotent and may briefly show `canceling` while child processes exit.

`forget` removes one finished job record. `clear` removes all finished records without canceling active jobs. Forgetting an active job is rejected; cancel it and wait for cleanup first. These operations do not erase completion messages or Pi session history.

Background jobs have their own abort controllers. Ctrl+C on the parent's turn does not cancel them. Use `subagent_jobs` to cancel a job. On POSIX, cancellation signals the child's process group, including ordinary tool descendants, and escalates from SIGTERM to SIGKILL after one second. On Windows, it signals the direct child only.

Foreground calls and background jobs share a limit of four direct child processes per extension runtime. There can be up to eight active background jobs, with at most eight tasks in each parallel batch. Tasks waiting for a process slot can also be canceled. The extension retains the latest 32 finished job records for inspection. Finished output in this registry has a shared 32 MiB budget, estimated from serialized message records, task text, stderr, and result text. Oldest output is evicted first; an individually oversized result is not retained. Job state remains available with `outputEvicted: true`, and enabled completion delivery still receives the result before eviction. This registry budget is not a heap-memory limit or a cap on Pi's own session history.

Completion and status text are capped at 50 KiB including headers and truncation notices, with captured output retained in details. Jobs live only in the current Pi session. Quit, `/reload`, and session replacement cancel active jobs and discard job history. Jobs do not survive a Pi restart.

Background execution requires a long-lived TUI or RPC session. Print and JSON modes must use foreground execution so they do not exit with unfinished work.

## Wait for a background job

Use `action: "wait"` when the next operation needs a particular job's result. It waits for the job to finish cleanup, without polling. `timeoutMs` defaults to 30000 and accepts whole milliseconds from 1 to 60000. This limits the wait, not the child's runtime.

The response includes the same snapshot as status, plus `timedOut`. A completed, failed, or canceled job returns `timedOut: false`. If the wait expires first, it returns the current state with `timedOut: true`; the background job stays active. Unknown or forgotten IDs return an error immediately.

Canceling the waiting tool call only stops the wait. To cancel the job, use `action: "cancel"`. Waiters also finish when session shutdown completes job cleanup. Waiting does not consume a child-process slot, add usage charges, or send an extra completion message. Automatic follow-ups still arrive as usual unless the job is silent.

In a codemode script:

```js
const result = await tools.subagent_jobs({
  action: "wait", jobId: "<job ID>", timeoutMs: 30000
});
if (result.error) throw new Error(result.error);
return { state: result.job.state, timedOut: result.timedOut };
```

Use one bounded wait when needed rather than a repeated status or wait loop.

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

Read additional pages only when needed. Non-silent jobs send completion messages automatically, so do not poll for them.

## Usage accounting

Foreground results report cumulative child token and cost totals through Pi's standard tool-result `usage` field. This includes completed assistant attempts and nested model usage in canonical `message_end` tool results, even when a task fails or earlier message history is evicted. Legacy `tool_result_end` copies do not add usage again. Reasoning tokens and one-hour cache writes are subsets, not additional tokens.

Background totals remain in retained job details; they are not added to Pi's session statistics. Launch acknowledgements, progress updates, and job inspection never report billable usage again. Parent-aborted foreground calls do not return a billable tool result.

Malformed usage and arithmetic overflow fail the task without exposing provider payloads. An overflow while combining batch totals marks the response as an error and preserves individual captures, but omits aggregate usage.

## Output capture and cleanup

Each child has bounded output capture:

- JSONL records can be up to 8 MiB in UTF-8. An oversized record fails the task, is discarded through the next newline, and does not stop stream draining.
- Stderr retains its first 64 KiB, including a truncation notice. Further stderr is drained and discarded.
- Message history retains at most 128 recent messages and 16 MiB of source JSON records. Evicting earlier messages does not change aggregate usage totals.

Results and tool details report capture truncation. These are capture limits, separate from the 50 KiB model-visible output limit shared across all text blocks in one response. Discarded records and evicted history are not preserved elsewhere.

Pre-spawn failures, such as an unwritable prompt file or a synchronous spawn error, return a failed task result with the setup phase and a safe error code. They preserve earlier chain results and let independent batch tasks continue. Cancellation still aborts the operation. Raw setup-error messages are not exposed because they may contain private prompt data.

A zero exit code alone is not success. The child must emit a completed assistant message. Invalid JSONL, JSON nesting beyond 128 levels, or malformed assistant or tool-result messages (including metadata, content, or usage) cause the task to fail without crashing the parent. Redacted thinking blocks are supported, and a successful retry clears errors from earlier attempts.

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
