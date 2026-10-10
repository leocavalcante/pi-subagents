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

test('README documents the bounded delegated task input size', () => {
  const usage = section('Usage');
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
  assert.match(capture, /Child stdout is capped at 128 MiB per task/);
});

test('README documents bounded UUID job identifiers', () => {
  const background = section('Background execution');
  assert.match(background, /Job IDs are generated UUIDs \(36 characters\); `jobId` inputs are bounded to that length/);
});

test('README documents the bounded shared process queue', () => {
  const background = section('Background execution');
  assert.match(background, /limit of four direct child processes per extension runtime/);
  assert.match(background, /At most 32 additional task requests can wait/);
  assert.match(background, /excess requests fail with a retryable queue-full result/);
});

test('README relative file links are included in the npm package', () => {
  const relativeLinks = [...readme.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
    .map(([, target]) => target.split(/[?#]/, 1)[0])
    .filter(target => target && !/^[a-z][a-z\d+.-]*:/i.test(target));

  for (const target of relativeLinks) {
    assert.ok(packageJson.files.includes(target), `README target is missing from the npm package: ${target}`);
  }
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
