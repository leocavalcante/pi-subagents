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

test('README relative file links are included in the npm package', () => {
  const relativeLinks = [...readme.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
    .map(([, target]) => target.split(/[?#]/, 1)[0])
    .filter(target => target && !/^[a-z][a-z\d+.-]*:/i.test(target));

  for (const target of relativeLinks) {
    assert.ok(packageJson.files.includes(target), `README target is missing from the npm package: ${target}`);
  }
});

test('README distinguishes POSIX process-group cleanup from Windows direct-child cleanup', () => {
  const deadlines = section('Task deadlines');
  assert.match(deadlines, /On POSIX, cleanup signals the child's process group/);
  assert.match(deadlines, /On Windows, only the direct child is signaled; descendants may continue running after a timeout or cancellation/);
  assert.match(deadlines, /Windows uses an immediate termination request instead of the POSIX escalation delay/);

  const cleanup = section('Output capture and cleanup');
  assert.match(cleanup, /On Windows, descendants are not terminated when the direct child exits, whether normally or after cancellation or a deadline/);
});
