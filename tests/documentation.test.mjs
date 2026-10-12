import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const contributing = readFileSync(new URL('../CONTRIBUTING.md', import.meta.url), 'utf8');
const testWorkflow = readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');
const codeqlWorkflow = readFileSync(new URL('../.github/workflows/codeql.yml', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function section(title) {
  const start = readme.indexOf(`## ${title}\n`);
  assert.notEqual(start, -1, `Missing README section: ${title}`);
  const next = readme.indexOf('\n## ', start + 1);
  return readme.slice(start, next === -1 ? undefined : next);
}

test('README documents the minimum Node.js version required by the package', () => {
  const engine = packageJson.engines?.node;
  assert.match(engine, /^>=\d+\.\d+\.\d+$/, 'Expected a simple minimum Node.js engine range');
  assert.ok(readme.includes(`Node.js ${engine.slice(2)} or newer`), `README must document Node.js ${engine}`);
});

test('README documents an available installation method', () => {
  const installation = section('Installation');
  assert.match(installation, /The npm package is not yet published/);
  assert.match(installation, /pi install git:github\.com\/leocavalcante\/pi-subagents/);
  assert.match(installation, /From the checkout root, install the local copy/);
  assert.match(installation, /pi install \.\n```/);
  assert.doesNotMatch(installation, /pi install npm:/);
});

test('npm package includes required runtime support files', () => {
  for (const file of ['windows-supervisor.cs', 'windows-supervisor-invocation.ts', 'temporary-files.ts', 'abort.ts']) {
    assert.ok(packageJson.files.includes(file), `Package files must include ${file}`);
  }
});

test('npm package includes the full local dependency closure of its extension entrypoint', () => {
  const pending = ['index.ts'];
  const visited = new Set();
  const localReference = /(?:\bfrom\s*|\bimport\s*\(?\s*|\bnew URL\(\s*)["'](\.{1,2}\/[^"']+)["']/g;

  while (pending.length > 0) {
    const sourceFile = pending.pop();
    if (visited.has(sourceFile)) continue;
    visited.add(sourceFile);
    assert.ok(packageJson.files.includes(sourceFile), `Package files must include ${sourceFile}`);
    assert.ok(existsSync(new URL(`../${sourceFile}`, import.meta.url)), `Missing local source dependency: ${sourceFile}`);
    const source = readFileSync(new URL(`../${sourceFile}`, import.meta.url), 'utf8');
    for (const [, specifier] of source.matchAll(localReference)) {
      const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(sourceFile), specifier));
      assert.ok(dependency !== '..' && !dependency.startsWith('../'), `Local dependency escapes package root: ${specifier}`);
      assert.ok(packageJson.files.includes(dependency), `Package files must include ${dependency}, referenced by ${sourceFile}`);
      if (dependency.endsWith('.ts')) pending.push(dependency);
    }
  }
});

function assertActionlintDocumentationMatchesWorkflow(workflowSource) {
  const workflow = workflowSource.replace(/\r\n/g, '\n');
  const version = workflow.match(/^\s+version=(\d+\.\d+\.\d+)$/m)?.[1];
  const ignores = [...workflow.matchAll(/^\s+-ignore '([^']+)'/gm)].map(([, ignore]) => ignore);
  assert.ok(version, 'CI must pin the actionlint version');
  assert.deepEqual(ignores, ['label "ubuntu-26\\.04" is unknown\\.'],
    'the Ubuntu 26 runner-label catalog diagnostic must be the sole ignored actionlint diagnostic');
  const [ignore] = ignores;
  const invocation = `"$RUNNER_TEMP/actionlint" \\\n            -ignore '${ignore}' \\\n            .github/workflows/*.yml`;
  assert.ok(workflow.includes(invocation), 'CI must invoke actionlint on the workflow files with the scoped ignore');
  assert.ok(contributing.includes(`actionlint v${version}`));
  assert.ok(contributing.includes(`actionlint -ignore '${ignore}' .github/workflows/*.yml`));
  assert.match(contributing, /keep the explicit `ubuntu-26\.04` matrix row until GitHub's runner migration is confirmed/);
}

test('CodeQL scans the C# Windows supervisor and preserves the JavaScript check name', () => {
  const workflow = codeqlWorkflow.replace(/\r\n/g, '\n');
  assert.match(workflow, /^  analyze:\n    name: Analyze JavaScript and TypeScript$/m);
  assert.match(workflow, /^          languages: javascript-typescript$/m);

  const csharpJobMarker = '  analyze-csharp:\n';
  const csharpJobStart = workflow.indexOf(csharpJobMarker);
  assert.notEqual(csharpJobStart, -1, 'CodeQL must define a separate C# analysis job');
  const csharpJobTail = workflow.slice(csharpJobStart + csharpJobMarker.length);
  const nextJobStart = csharpJobTail.search(/^  \S/m);
  const csharpJob = nextJobStart === -1 ? csharpJobTail : csharpJobTail.slice(0, nextJobStart);

  assert.match(csharpJob, /^    name: Analyze C#$/m);
  assert.match(csharpJob, /^    permissions:\n      actions: read\n      contents: read\n      security-events: write$/m);
  assert.match(csharpJob, /^          languages: csharp\n          build-mode: none$/m);
  assert.match(csharpJob, /^      - uses: github\/codeql-action\/analyze@/m);

  assert.match(workflow, /^  push:\n    branches:\n      - main$/m);
  assert.match(workflow, /^  pull_request:\n    branches:\n      - main$/m);
  assert.match(workflow, /^  schedule:\n    - cron:/m);
});

test('CONTRIBUTING documents the sole narrowly scoped actionlint ignore used by CI', () => {
  assertActionlintDocumentationMatchesWorkflow(testWorkflow);
  assertActionlintDocumentationMatchesWorkflow(testWorkflow.replace(/\r?\n/g, '\r\n'));
});

test('CONTRIBUTING explains how Windows process containment is validated', () => {
  assert.match(contributing, /Windows-only integration tests also verify Job Object containment on cancellation, deadlines, and normal leader exit/);
  assert.match(contributing, /bare Pi executable names resolve through PATH instead of being shadowed by the task working directory/);
  assert.match(contributing, /source compilation alone does not validate this behavior—rely on Windows CI/);
  assert.match(contributing, /type check and tests on Linux, macOS, and Windows with Node\.js 22, 24, and 26/);
  assert.match(contributing, /POSIX process-group cleanup on both Linux and macOS/);
});

test('README distinguishes absent personal agent directories from inspection failures', () => {
  const agents = section('Agent definitions');
  assert.match(agents, /A missing personal-agent directory is treated as empty; permission and other inspection failures are reported as diagnostics rather than silently appearing empty/);
});

test('README documents bounded agent descriptions and discovery tags', () => {
  const agents = section('Agent definitions');
  assert.match(agents, /Descriptions are limited to 1 KiB of UTF-8 text/);
  assert.match(agents, /definition files must be valid UTF-8/);
  assert.match(agents, /metadata escapes that produce unpaired UTF-16 surrogates are rejected/);
  assert.match(agents, /optional discovery `tags`/);
  assert.match(agents, /Tags are ASCII slugs using letters, digits, dots, underscores, or hyphens, beginning with a letter or digit; input is normalized to lowercase/);
  assert.match(agents, /limited to 32 labels of at most 64 bytes each and 2 KiB total/);
  assert.match(agents, /They do not change child execution/);
});

test('README documents the agent configuration exposed by discovery', () => {
  const usage = section('Usage');
  assert.match(usage, /tags, source paths, model, thinking, tool settings, configured timeout, working-directory and filtered-environment defaults/);
  assert.match(usage, /configured timeout, working-directory and filtered-environment defaults/);
  assert.match(usage, /paginated in groups of at most 10/);
  assert.match(usage, /pass the returned `nextOffset` to continue/);
  assert.match(usage, /pass its exact, case-sensitive name/);
  assert.match(usage, /case-insensitive literal substring matching in names, descriptions, definition filenames \(not parent directories\), tags, explicitly configured tool allowlists, `cwd` paths, `unsetEnv` environment-variable names, `timeoutMs` values \(as decimal milliseconds\), model selectors, and thinking levels/);
  assert.match(usage, /Search does not infer runtime-default tools, the parent-session `cwd`, inherited model\/thinking settings, or unspecified deadlines; timeout values are matched as decimal milliseconds/);
  assert.match(usage, /It only searches the names of filtered environment variables, never their values/);
  assert.match(usage, /Unicode 17\.0 default \(non-Turkic\) full case folding and NFC normalization \(so canonically equivalent composed and decomposed forms match\)/);
  assert.match(usage, /Greek sigma, German sharp s \(`ß`\/`ẞ` → `ss`\), long s, and ligature expansions/);
  assert.match(usage, /`STRASSE` matches `Straße`/);
  assert.match(usage, /Choose one of `name`, `query`, `tag`, or `tags`/);
  assert.match(usage, /To return agents with one exact tag, pass `tag`/);
  assert.match(usage, /tag matching is case-insensitive, matches a complete label, and normalizes input to lowercase/);
  assert.match(usage, /To require several exact tags at once, pass `tags`/);
  assert.match(usage, /every listed tag must match/);
  assert.match(usage, /Neither tag filter can be combined with `name` or `query`/);
  assert.match(usage, /Filtering happens after scope precedence/);
  assert.match(usage, /Structured paths and `cwd` values are capped at 4 KiB and diagnostic messages at 512 UTF-8 bytes/);
  assert.match(usage, /These listing-only limits do not change the paths used to launch agents/);
});

test('README gives concrete exact- and multi-tag discovery examples', () => {
  const usage = section('Usage');
  assert.match(usage, /### Filter by capability tag/);
  assert.match(usage, /\{ "agentScope": "both", "tag": "security" \}/);
  assert.match(usage, /matching is case-insensitive/);
  assert.match(usage, /continue with the returned `nextOffset`, keeping the same scope and tag/);
  assert.match(usage, /\{ "agentScope": "both", "tag": "security", "offset": 10 \}/);
  assert.match(usage, /### Filter by multiple capability tags/);
  assert.match(usage, /\{ "agentScope": "both", "tags": \["security", "code-review"\] \}/);
  assert.match(usage, /every requested exact tag/);
  assert.match(usage, /keeping the same `agentScope` and `tags`/);
});

test('README documents agent timeout and environment-removal defaults and precedence', () => {
  const agents = section('Agent definitions');
  const usage = section('Usage');
  const deadlines = section('Task deadlines');
  assert.match(agents, /default `timeoutMs`, a default working directory with `cwd`, and inherited environment variables to remove with `unsetEnv` in its frontmatter/);
  assert.match(agents, /Agent `cwd` defaults must be non-empty, well-formed Unicode paths with no NUL characters/);
  assert.match(agents, /convenience, not a filesystem sandbox, and does not restrict access to other paths/);
  assert.match(agents, /Agent `unsetEnv` defaults list portable environment-variable names/);
  assert.match(usage, /configured timeout, working-directory and filtered-environment defaults/);
  assert.match(agents, /whole milliseconds from 1 to 86400000 \(24 hours\)/);
  assert.match(deadlines, /a per-entry or top-level call value overrides it/);
  assert.match(deadlines, /Set `timeoutMs` to `null` on a call or entry to explicitly disable that deadline/);
  assert.match(deadlines, /entry, top-level call, agent frontmatter, then no deadline/);
});

test('README documents bounded model selectors and agent tool allowlists', () => {
  const agents = section('Agent definitions');
  const overrides = section('Model and thinking overrides');
  assert.match(agents, /Model selectors are limited to 512 UTF-8 bytes and reject control characters/);
  assert.match(agents, /empty or whitespace-only `model` value/);
  assert.match(agents, /inherits the parent's active model and thinking level/);
  assert.match(agents, /Tool arrays are limited to 256 entries; comma-separated values and the normalized `--tools` argument are each capped at 4 KiB of UTF-8 text/);
  assert.match(agents, /Entries cannot contain commas or control characters/);
  assert.match(agents, /cannot start with `\+` or `-`, which Pi interprets as modifiers/);
  assert.match(overrides, /Model selectors .* limited to 512 UTF-8 bytes without control characters/);
  assert.match(overrides, /Set `model: null` on a call or entry to ignore the agent's configured model and inherit the parent's active model/);
  assert.match(overrides, /entry-level `null` also overrides a top-level batch model/);
  assert.match(overrides, /Set `thinking: null` to ignore the agent's configured thinking level/);
  assert.match(overrides, /Entry-level `null` overrides top-level batch thinking/);
  assert.match(overrides, /project-agent approval remains required regardless of these overrides/);
});

test('README documents bounded per-call tool overrides and precedence', () => {
  const overrides = section('Tool allowlist overrides');
  assert.match(overrides, /comma-separated string .* also accepted/);
  assert.match(overrides, /entry, top-level call, agent frontmatter, then the child Pi defaults/);
  assert.match(overrides, /Set `tools: \[\]` to disable the initial tool selection/);
  assert.match(overrides, /set `tools: null` .* ignore the agent's configured allowlist/);
  assert.match(overrides, /at most 256 entries and 4 KiB of normalized UTF-8 tool names/);
  assert.match(overrides, /not a sandbox/);
  assert.match(overrides, /do not bypass project-agent approval/);
});

test('README documents bounded delegated working-directory paths and precedence', () => {
  const usage = section('Usage');
  const agents = section('Agent definitions');
  assert.match(agents, /Agent `cwd` paths resolve relative to the parent session's working directory, not the definition file/);
  assert.match(usage, /Use a non-empty `cwd` path .* empty strings are rejected rather than treated as the parent directory/);
  assert.match(usage, /Precedence is entry `cwd`, top-level call `cwd`, agent frontmatter `cwd`, then the parent session directory/);
  assert.match(usage, /Project-agent approval lists the effective resolved child working directories, including dispatch overrides and the parent session fallback/);
  assert.match(usage, /summarizes each requested project's effective model, thinking level, initial tool selection, and runtime deadline/);
  assert.match(usage, /When approval is required for an untrusted project, details are never silently truncated/);
  assert.match(usage, /complete prompt exceeds 32 KiB, the call fails before approval or child launch/);
  assert.match(usage, /tool selection is not a sandbox/);
  assert.match(usage, /Discovery and approval still use the parent session/);
  assert.match(usage, /Paths are limited to 32,767 UTF-16 code units, including the resolved path after a relative path is joined/);
});

test('README documents the bounded delegated task input size', () => {
  const usage = section('Usage');
  assert.match(usage, /Task, model-selector, and working-directory strings must be well-formed Unicode/);
  assert.match(usage, /Each task is limited to 4 MiB of UTF-8 text/);
  assert.match(usage, /all task text submitted in one dispatch is limited to 16 MiB total/);
  assert.match(usage, /chain context after substitution/);
  assert.match(usage, /Expanded chain task text is also limited to 16 MiB total across all steps/);
});

test('README documents aggregate capture limits for parallel and chained results', () => {
  const capture = section('Output capture and cleanup');
  assert.match(capture, /16 MiB of source JSON records per task/);
  assert.match(capture, /parallel batches and chains share an additional 32 MiB aggregate history budget/i);
  assert.match(capture, /final assistant message is not retained in bounded history, the task fails/);
  assert.match(capture, /at most 65,536 structural tokens/);
  assert.match(capture, /structure beyond 65,536 tokens/);
  assert.match(capture, /escaped unpaired surrogates/);
  assert.match(capture, /Child stdout is capped at 128 MiB per task/);
});

test('README documents Pi interrupt-key behavior for foreground and background jobs', () => {
  const usage = section('Usage');
  const background = section('Background execution');
  assert.match(usage, /configured interrupt key \(Escape by default in Pi 1\.1\) to cancel a foreground subagent operation/);
  assert.match(usage, /Ctrl\+C is Pi's `app\.clear` binding .* not its interrupt key, and does not cancel a foreground subagent/);
  assert.doesNotMatch(usage, /Ctrl\+C cancels foreground child processes/);
  assert.match(background, /Ctrl\+C on the parent's turn does not cancel them/);
  assert.match(background, /Use `subagent_jobs` to cancel a job/);
});

test('README documents bounded UUID job identifiers', () => {
  const background = section('Background execution');
  assert.match(background, /Job IDs are generated UUIDs \(36 characters\); `jobId` inputs are bounded to that length/);
});

test('README discloses that Windows supervisor compilation is outside task deadlines and unbounded', () => {
  const deadlines = section('Task deadlines');
  assert.match(deadlines, /first-use supervisor compilation happens before child spawn, is outside the task deadline, and has no independent deadline/);
  assert.match(deadlines, /If PowerShell or `Add-Type` stalls, calls waiting on compilation may hang indefinitely/);
  assert.match(deadlines, /Canceling a caller detaches only that caller; the shared compilation keeps running/);
  assert.match(deadlines, /later invocations in the same runtime also wait for it/);
  assert.match(deadlines, /not safe to terminate PowerShell without verified process-tree containment/);
});

test('README documents selecting paginated chain output by named step ID', () => {
  const chains = section('Named chain outputs');
  const background = section('Background execution');
  const output = section('Read captured job output');
  assert.match(chains, /Paginate a named step by `stepId`/);
  assert.match(background, /"stepId": "review"/);
  assert.match(output, /Select a named chain step with `stepId`/);
  assert.match(output, /selectors are mutually exclusive/);
  assert.match(output, /keep the same `stepId` or `taskIndex` selector and advance `offset`/);
});

test('README documents timeout metadata and the opt-in stderr stream on background output pages', () => {
  const output = section('Read captured job output');
  assert.match(output, /`output\.timedOut` indicates whether the runtime deadline fired/);
  assert.match(output, /`output\.timeoutMs` reports the effective per-task deadline when configured/);
  assert.match(output, /set `stream: "stderr"` to page the task's separately captured stderr/);
  assert.match(output, /`output\.stderrTruncated` indicates whether stderr reached its 64 KiB capture limit/);
});

test('README documents the bounded shared process queue', () => {
  const background = section('Background execution');
  assert.match(background, /limit of four direct child processes per extension runtime/);
  assert.match(background, /At most 32 additional task requests can wait/);
  assert.match(background, /excess requests fail with a retryable queue-full result/);
  assert.match(background, /shared 32 MiB budget, estimated from serialized message records, retained model metadata, task text, stderr, and result text/);
});

test('README relative file links are included in the npm package', () => {
  const relativeLinks = [...readme.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
    .map(([, target]) => target.split(/[?#]/, 1)[0])
    .filter(target => target && !/^[a-z][a-z\d+.-]*:/i.test(target));

  for (const target of relativeLinks) {
    assert.ok(packageJson.files.includes(target), `README target is missing from the npm package: ${target}`);
  }
});

test('README documents fail-closed lookup when a nearer project-agent directory is inaccessible', () => {
  const usage = section('Usage');
  assert.match(usage, /Missing and non-directory candidates are skipped/);
  assert.match(usage, /access or I\/O error/);
  assert.match(usage, /discovery stops with a diagnostic rather than silently falling back to an ancestor/);
});

test('README documents mandatory approval for untrusted project agents', () => {
  const security = section('Security');
  assert.match(security, /require an interactive approval or an already-trusted Pi project/);
  assert.match(security, /headless sessions fail closed for untrusted project agents/);
  assert.match(security, /Approval cannot be disabled through a tool argument/);
});

test('README documents inherited environment filtering without describing it as a sandbox', () => {
  const agents = section('Agent definitions');
  const filtering = section('Inherited environment filtering');
  const security = section('Security');
  assert.match(agents, /inherited environment variables to remove with `unsetEnv`/);
  assert.match(agents, /at most 128 names and 4 KiB total/);
  assert.match(filtering, /combine additively/);
  assert.match(filtering, /applied case-insensitively on Windows/);
  assert.match(filtering, /PI_SUBAGENTS_NESTING_DEPTH/);
  assert.match(filtering, /Agent listings and project-agent approval prompts show variable names, never their values/);
  assert.match(filtering, /only filters variables inherited at child startup; it is not a sandbox/);
  assert.match(security, /child `pi` process inherits the parent process's environment by default/);
  assert.match(security, /Use `unsetEnv` to omit known variables from the child's startup environment/);
  assert.match(security, /do not rely on environment filtering as a security boundary/);
});

test('README documents temporary system-prompt storage and platform permissions', () => {
  const security = section('Security');
  assert.match(security, /Agent system prompts are written briefly to a temporary UTF-8 file/);
  assert.match(security, /removed during invocation cleanup/);
  assert.match(security, /Transient removal failures get bounded retries, and failed cleanup is retried at process exit/);
  assert.match(security, /On POSIX, the temporary directory and file grant no group or other access/);
  assert.match(security, /On Windows, access follows the ACLs inherited from the configured temporary directory/);
  assert.match(security, /other processes running as the same user/);
});

test('README documents terminal-control escaping for foreground, background, and job output', () => {
  const security = section('Security');
  assert.match(security, /foreground subagent result renderer escapes terminal control characters in child output and tool-call previews/);
  assert.match(security, /background completion-message renderer also escapes child output and failure details for TUI display/i);
  assert.match(security, /subagent_jobs.*call and result renderers likewise escape untrusted job IDs, captured output, and failure text only for display/i);
  assert.match(security, /preserving the raw follow-up content and structured details/i);
});

test('README distinguishes POSIX process-group cleanup from Windows Job Object supervision', () => {
  const deadlines = section('Task deadlines');
  assert.match(deadlines, /On POSIX, cleanup signals the child's process group/);
  assert.match(deadlines, /On Windows, after compilation the supervisor joins a kill-on-close outer Job Object/);
  assert.match(deadlines, /creates Pi suspended with only its standard I\/O handles inherited/);
  assert.match(deadlines, /Job setup or cleanup failures fail closed/);
  assert.match(deadlines, /waits at most 30 seconds for job settlement/);
  assert.match(deadlines, /Windows uses an immediate termination request instead of the POSIX escalation delay/);

  const cleanup = section('Output capture and cleanup');
  assert.match(cleanup, /On POSIX, when a child exits, the extension sends SIGTERM to remaining members of its process group/);
  assert.match(cleanup, /assigns it to a nested kill-on-close Job Object before resuming it/);
  assert.match(cleanup, /confirms the job is empty before reporting success/);
});
