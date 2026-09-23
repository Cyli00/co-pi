import test from 'node:test';
import assert from 'node:assert/strict';
import { Mailbox } from '../dist/mailbox.js';

test('正文引用其他消息标记不能替代那条消息的真实送达', async () => {
  const events = [];
  const mailbox = new Mailbox(event => events.push(event), () => {});
  mailbox.receive({ type: 'message', id: 'first', mode: 'steer', text: '引用 [cpi-message:second]' });
  mailbox.receive({ type: 'message', id: 'second', mode: 'followUp', text: '尚未交付' });
  mailbox.event({ type: 'message_start', message: { role: 'user', content: '[cpi-message:first]\n引用 [cpi-message:second]' } });
  assert.deepEqual(events.filter(e => e.receipt?.status === 'delivered').map(e => e.receipt.id), ['first']);
  await mailbox.drain();
  assert.equal(events.findLast(e => e.receipt?.id === 'second').receipt.status, 'unknown');
  await mailbox.close(true);
});
