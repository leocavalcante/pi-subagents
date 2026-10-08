import { appendFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
const task = readFileSync(0, 'utf8').replace(/^Task: /, '');
const flag = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const trace = entry => appendFileSync(process.env.SUBAGENT_TEST_TRACE, JSON.stringify({ ...entry, pid: process.pid }) + '\n');
trace({ event: 'start', task, cwd: process.cwd(), model: flag('--model'), thinking: flag('--thinking'), tools: flag('--tools'), noTools: args.includes('--no-tools'), promptFile: args.includes('--append-system-prompt') ? flag('--append-system-prompt') : undefined });
if (args.includes('--append-system-prompt')) readFileSync(flag('--append-system-prompt'), 'utf8');
if (task.includes('stubborn')) process.on('SIGTERM', () => {});
if (task.includes('grandchild')) {
  const source = `const fs = require('node:fs'); process.on('SIGTERM', () => fs.appendFileSync(process.env.SUBAGENT_TEST_TRACE, JSON.stringify({event: 'grandchild-term', pid: process.pid})+'\\n')); fs.appendFileSync(process.env.SUBAGENT_TEST_TRACE, JSON.stringify({event: 'grandchild', pid: process.pid})+'\\n'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['-e', source], { stdio: task.includes('grandchild-ignored') ? 'ignore' : ['ignore', 'inherit', 'inherit'] });
  if (task.includes('orphan')) child.unref();
}
const emit = (text, stopReason = 'stop') => console.log(JSON.stringify({
  type: 'message_end', message: { role: 'assistant', content: (Array.isArray(text) ? text : [text]).map(text => ({ type: 'text', text })),
    model: 'fake', stopReason, ...(stopReason === 'error' ? { errorMessage: task === 'large-error fail' ? 'é'.repeat(40000) : 'fixture failure' } : {}),
    usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } },
  },
}));
const write = (stream, text) => new Promise((resolve, reject) => stream.write(text, error => error ? reject(error) : resolve()));
const toolUseEvent = { type: 'message_end', message: {
  role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'echo done' } }],
  stopReason: 'toolUse', usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } },
} };
if (task === 'tool-use-only') {
  await write(process.stdout, JSON.stringify(toolUseEvent) + '\n');
  trace({ event: 'end', task });
  process.exit(0);
}
if (task === 'tool-use-then-final') await write(process.stdout, JSON.stringify(toolUseEvent) + '\n');
if (['silent-exit', 'junk-exit', 'session-only-exit'].includes(task)) {
  if (task === 'junk-exit') await write(process.stdout, 'not JSON\n');
  if (task === 'session-only-exit') await write(process.stdout, '{"type":"session"}\n');
  trace({ event: 'end', task });
  process.exit(0);
}
if (task === 'nested-usage') {
  const message = { role: 'toolResult', toolCallId: 'nested', toolName: 'nested', content: [], isError: false,
    usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cacheWrite1h: 5, reasoning: 7, totalTokens: 100,
      cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 } } };
  console.log(JSON.stringify({ type: 'message_end', message }));
  console.log(JSON.stringify({ type: 'tool_result_end', message }));
}
if (task === 'malformed-cost-component' || task === 'malformed-nested-usage') {
  const toolResult = task === 'malformed-nested-usage';
  console.log(JSON.stringify({ type: 'message_end', message: {
    role: toolResult ? 'toolResult' : 'assistant', content: [],
    ...(toolResult ? { toolCallId: 'nested-bad', toolName: 'nested', isError: false } : { stopReason: 'stop' }),
    usage: { cost: { input: 'private payload', total: 0 } },
  } }));
}
if (task === 'usage-overflow' || task === 'large-usage') for (let i = 0; i < (task === 'large-usage' ? 1 : 2); i++) console.log(JSON.stringify({
  type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'stop', usage: { input: 1e308 } }
}));
if (task === 'non-finite-number') console.log('{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"huge","name":"tool","arguments":{"value":1e400}}],"stopReason":"toolUse"}}');
if (task === 'malformed-json') console.log('{"type":');
if (task === 'deep-json') {
  const nested = '['.repeat(20000) + '0' + ']'.repeat(20000);
  console.log('{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"deep","name":"opaque","arguments":{"nested":' + nested + '}}],"stopReason":"stop"}}');
}
if (task === 'malformed-metadata') console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: {} } }));
if (task === 'malformed-pending') console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'pending' } }));
if (task === 'retry-recovered') emit('transient error', 'error');
if (task === 'redacted-thinking') console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', redacted: true, thinkingSignature: 'opaque' }], stopReason: 'stop' } }));
if (task === 'odd-tool-args') console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: ['bash', 'read', 'write', 'edit', 'ls', 'find', 'grep'].map(name => ({ type: 'toolCall', id: name, name, arguments: { command: 42, path: {}, pattern: 42, content: 42, offset: null, limit: {} } })), stopReason: 'toolUse' } }));
if (task === 'long-path') console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'long-read', name: 'read', arguments: { path: '/' + 'p'.repeat(40000) } }], stopReason: 'toolUse' } }));
if (task === 'malformed-tool-result') console.log(JSON.stringify({ type: 'tool_result_end', message: {
  role: 'toolResult', toolName: 'read', content: [], isError: false,
} }));
if (task === 'wrong-role-tool-result') console.log(JSON.stringify({ type: 'tool_result_end', message: {
  role: 'assistant', content: [], stopReason: 'stop',
} }));
if (task === 'malformed-legacy') console.log(JSON.stringify({ type: 'tool_result_end', message: { role: 'assistant' } }));
if (task === 'malformed-message') console.log(JSON.stringify({ type: 'message_end', message: [] }));
if (task === 'malformed-null') console.log('null');
if (task === 'malformed-content') console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant' } }));
if (task === 'malformed-usage') console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [], usage: { cost: { total: 'bad' } } } }));
if (task === 'stdout-flood' || task.startsWith('stdout-flood-hang')) await write(process.stdout, 'x'.repeat(9 * 1024 * 1024) + '\n');
if (task === 'stderr-flood') await write(process.stderr, 'é'.repeat(100 * 1024));
if (task === 'history-flood') for (let i = 0; i < 200; i++) emit(`history ${i}`);
if (task === 'retention-heavy') for (let i = 0; i < 3; i++) emit('r'.repeat(3 * 1024 * 1024));
emit('progress: ' + task);
setTimeout(async () => {
  if (task.includes('crash')) { console.error('fixture crashed before final output'); process.exitCode = 1; }
  else {
    const output = task === 'empty-final' ? [] : task === 'blocks' ? ['first block', 'second block']
      : task === 'dollars' ? '$& $$ $` $\' {previous}'
      : task.includes('large') ? 'é'.repeat(40000) : 'result: ' + task;
    emit(output, task.includes('fail') ? 'error' : 'stop');
    process.exitCode = task.includes('fail') && !task.includes('zero-exit') ? 1 : 0;
  }
  if (task === 'stdout-flood-unterminated') await write(process.stdout, 'x'.repeat(9 * 1024 * 1024));
  trace({ event: 'end', task });
}, Number(task.match(/delay=(\d+)/)?.[1] ?? 80));
