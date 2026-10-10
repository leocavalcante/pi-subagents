import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
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

test('npm package includes the Windows process supervisor source', () => {
  assert.ok(packageJson.files.includes('windows-supervisor.cs'));
});

test('README documents bounded agent descriptions', () => {
  const agents = section('Agent definitions');
  assert.match(agents, /Descriptions are limited to 1 KiB of UTF-8 text/);
  assert.match(agents, /definition files must be valid UTF-8/);
  assert.match(agents, /metadata escapes that produce unpaired UTF-16 surrogates are rejected/);
});

test('README documents agent timeout defaults and precedence', () => {
  const agents = section('Agent definitions');
  const usage = section('Usage');
  const deadlines = section('Task deadlines');
  assert.match(agents, /default `timeoutMs` in its frontmatter/);
  assert.match(usage, /configured timeout defaults/);
  assert.match(agents, /whole milliseconds from 1 to 86400000 \(24 hours\)/);
  assert.match(deadlines, /a per-entry or top-level call value overrides it/);
  assert.match(deadlines, /Set `timeoutMs` to `null` on a call or entry to explicitly disable that deadline/);
  assert.match(deadlines, /entry, top-level call, agent frontmatter, then no deadline/);
});

test('README documents bounded model selectors and tool allowlists', () => {
  const agents = section('Agent definitions');
  const overrides = section('Model and thinking overrides');
  assert.match(agents, /Model selectors are limited to 512 UTF-8 bytes and reject control characters/);
  assert.match(agents, /Tool arrays are limited to 256 entries; comma-separated values and the normalized `--tools` argument are each capped at 4 KiB of UTF-8 text/);
  assert.match(agents, /Entries cannot contain commas or control characters/);
  assert.match(agents, /cannot start with `\+` or `-`, which Pi interprets as modifiers/);
  assert.match(overrides, /Model selectors .* limited to 512 UTF-8 bytes without control characters/);
});

test('README documents bounded delegated working-directory paths', () => {
  const usage = section('Usage');
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
  assert.match(capture, /final assistant message cannot fit its task's allocated history budget, that task fails/);
  assert.match(capture, /at most 65,536 structural tokens/);
  assert.match(capture, /structure beyond 65,536 tokens/);
  assert.match(capture, /escaped unpaired surrogates/);
  assert.match(capture, /Child stdout is capped at 128 MiB per task/);
});

test('README documents bounded UUID job identifiers', () => {
  const background = section('Background execution');
  assert.match(background, /Job IDs are generated UUIDs \(36 characters\); `jobId` inputs are bounded to that length/);
});

test('README documents timeout metadata on background output pages', () => {
  const output = section('Read captured job output');
  assert.match(output, /`output\.timedOut` indicates whether the runtime deadline fired/);
  assert.match(output, /`output\.timeoutMs` reports the effective per-task deadline when configured/);
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

test('README documents mandatory approval for untrusted project agents', () => {
  const security = section('Security');
  assert.match(security, /require an interactive approval or an already-trusted Pi project/);
  assert.match(security, /headless sessions fail closed for untrusted project agents/);
  assert.match(security, /Approval cannot be disabled through a tool argument/);
});

test('README documents terminal-control escaping for foreground, background, and job output', () => {
  const security = section('Security');
  assert.match(security, /foreground subagent result renderer escapes terminal control characters in child output and tool-call previews/);
  assert.match(security, /background completion-message renderer also escapes child output and failure details for TUI display/i);
  assert.match(security, /subagent_jobs.*call and result renderers likewise escape untrusted job IDs, captured output, and failure text only for display/i);
  assert.match(security, /preserving the raw follow-up content and structured details/i);
});

test('README distinguishes POSIX process-group cleanup from Windows direct-child cleanup', () => {
  const deadlines = section('Task deadlines');
  assert.match(deadlines, /On POSIX, cleanup signals the child's process group/);
  assert.match(deadlines, /On Windows, only the direct child is signaled; descendants may continue running after a timeout or cancellation/);
  assert.match(deadlines, /Windows uses an immediate termination request instead of the POSIX escalation delay/);

  const cleanup = section('Output capture and cleanup');
  assert.match(cleanup, /On Windows, descendants are not terminated when the direct child exits, whether normally or after cancellation or a deadline/);
});
