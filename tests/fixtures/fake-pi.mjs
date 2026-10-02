import { appendFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
const task = args.at(-1).replace(/^Task: /, '');
const flag = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const trace = entry => appendFileSync(process.env.SUBAGENT_TEST_TRACE, JSON.stringify({ ...entry, pid: process.pid }) + '\n');
trace({ event: 'start', task, cwd: process.cwd(), model: flag('--model'), thinking: flag('--thinking'), tools: flag('--tools'), promptFile: args.includes('--append-system-prompt') ? flag('--append-system-prompt') : undefined });
if (args.includes('--append-system-prompt')) readFileSync(flag('--append-system-prompt'), 'utf8');
if (task.includes('stubborn')) process.on('SIGTERM', () => {});
if (task.includes('grandchild')) {
  const source = `const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.appendFileSync(process.env.SUBAGENT_TEST_TRACE, JSON.stringify({event: 'grandchild', pid: process.pid})+'\\n'); setInterval(() => {}, 1000);`;
  spawn(process.execPath, ['-e', source], { stdio: task.includes('grandchild-ignored') ? 'ignore' : ['ignore', 'inherit', 'inherit'] });
}
const emit = (text, stopReason = 'stop') => console.log(JSON.stringify({
  type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }],
    model: 'fake', stopReason, ...(stopReason === 'error' ? { errorMessage: 'fixture failure' } : {}),
    usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } },
  },
}));
emit('progress: ' + task);
setTimeout(() => {
  if (task.includes('crash')) { console.error('fixture crashed before final output'); process.exitCode = 1; }
  else { emit(task.includes('large') ? 'é'.repeat(40000) : 'result: ' + task, task.includes('fail') ? 'error' : 'stop'); process.exitCode = task.includes('fail') ? 1 : 0; }
  trace({ event: 'end', task });
}, Number(task.match(/delay=(\d+)/)?.[1] ?? 80));
