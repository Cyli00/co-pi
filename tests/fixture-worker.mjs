import { handoff } from './helpers.mjs';
let timer;
let started;
const send = event => process.send?.(event);
const settled = () => send({ type: 'runtime', state: { settled: true, compacting: false, queue: { steering: 0, followUp: 0 } } });
const finish = result => { settled(); process.send(result, () => process.exit(0)); };
process.on('message', message => {
  if (message.type === 'cancel') {
    if (started?.task.instruction === 'ignore-cancel') return;
    clearTimeout(timer);
    process.exit(0);
  }
  if (message.type === 'message') {
    if (started?.task.instruction === 'lost-ack') { process.exit(2); return; }
    send({ type: 'receipt', receipt: { id: message.id, mode: message.mode, status: 'delivered', at: new Date().toISOString() } });
    clearTimeout(timer);
    finish({ type: 'result', handoff: handoff(message.text) });
  }
  if (message.type !== 'start') return;
  started = message;
  send({ type: 'ready', model: 'fixture/model', thinking: 'high' });
  send({ type: 'activity', kind: 'tool_start', text: '此执行详情不应进入 MCP 最终结果' });
  send({ type: 'progress', phase: 'running', summary: '已开始本地验证' });
  const mode = message.task.instruction;
  if (['wait', 'ignore-cancel', 'lost-ack'].includes(mode)) { timer = setInterval(() => send({ type: 'heartbeat' }), 100); return; }
  timer = setTimeout(() => {
    if (mode === 'crash') process.exit(2);
    else if (mode === 'unsettled') process.send({ type: 'result', handoff: handoff() }, () => process.exit(0));
    else if (mode === 'invalid') finish({ type: 'result', handoff: { status: 'completed' } });
    else if (mode === 'error') finish({ type: 'error', code: 'model_request_failed' });
    else if (mode === 'partial') finish({ type: 'result', handoff: { ...handoff(), status: 'partial', unresolved: ['还需集成验证'] } });
    else if (mode === 'late') {
      settled();
      send({ type: 'result', handoff: handoff() });
      send({ type: 'progress', phase: 'running', summary: '迟到事件' });
      setTimeout(() => process.exit(0), 50);
    } else finish({ type: 'result', handoff: handoff() });
  }, mode === 'slow' ? 1300 : 120);
});
