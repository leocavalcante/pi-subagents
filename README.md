# pi-subagents

A Pi extension that delegates tasks to separate Pi processes with isolated context windows.

Extracted from Leo Cavalcante's dotfiles and based on the subagent example bundled with Pi 1.0.0. Adds session-owned background execution.

## Installation

Requires Pi. Tested with Pi 1.0.4. Pi provides the runtime dependencies, so no build step is needed.

Install from GitHub:

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

Definitions need non-empty `name` and `description` fields. Invalid YAML or configuration skips that definition instead of breaking discovery for all agents.

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

The `subagent` tool accepts exactly one mode:

| Mode | Parameters | Execution |
| --- | --- | --- |
| Single | `{ agent, task }` | One task |
| Parallel | `{ tasks: [{ agent, task }, ...] }` | Up to 8 tasks, 4 concurrent |
| Chain | `{ chain: [{ agent, task }, ...] }` | Sequential, with `{previous}` substituted into each task |

Use `cwd` to set a working directory. Relative paths resolve from the parent session's working directory. Parallel and chain entries accept their own `cwd`. Tasks reach children through stdin, so large prompts do not depend on the operating system's command-line argument limit.

Foreground execution is the default. Progress streams into the parent session. Ctrl+O expands tool output. Ctrl+C cancels foreground child processes. Parallel model-visible output is capped at 50 KiB per task; full results remain in tool details.

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
{ "action": "cancel", "jobId": "<job ID>" }
```

Status returns the latest progress or final result. Do not poll continuously; completion messages arrive automatically. Cancellation is idempotent and may briefly show `canceling` while child processes exit.

Background jobs have their own abort controllers. Ctrl+C on the parent's turn does not cancel them. Use `subagent_jobs` to cancel a job. On POSIX, cancellation signals the child's process group, including ordinary tool descendants, and escalates from SIGTERM to SIGKILL after one second. On Windows, it signals the direct child only.

Foreground calls and background jobs share a limit of four direct child processes per extension runtime. There can be up to eight active background jobs, with at most eight tasks in each parallel batch. Tasks waiting for a process slot can also be canceled. The extension retains the latest 32 finished jobs for inspection.

Completion and status text are capped at 50 KiB including headers and truncation notices, with full output retained in details. Jobs live only in the current Pi session. Quit, `/reload`, and session replacement cancel active jobs and discard job history. Jobs do not survive a Pi restart.

Background execution requires a long-lived TUI or RPC session. Print and JSON modes must use foreground execution so they do not exit with unfinished work.

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

Set `PI_PACKAGE_DIR` to an npm Pi package directory to test against another SDK version. Standalone binary directories fall back to the local development SDK. The tests use fake child processes and make no model calls. They cover agent discovery and configuration, dispatch, output extraction, rendering, process budgets, cancellation and shutdown, including POSIX descendants and SIGKILL escalation. GitHub Actions runs the type check and tests on Linux and Windows with Node.js 22 and 24.

## Origin and license

Based on the [Pi subagent example](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent) bundled with `@earendil-works/pi-coding-agent` 1.0.0.

MIT license. The original copyright notice for Mario Zechner is preserved in [LICENSE](LICENSE).
