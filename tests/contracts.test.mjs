import test from 'node:test';
import assert from 'node:assert/strict';
import { Value } from 'typebox/value';
import { handoffSchema, snapshotSchema, isTerminal } from '../dist/protocol.js';
import { PHASES, isSettled } from '../dist/handoff-contract.js';
import { handoffParameters } from '../dist/handoff-parameters.js';
import { handoff } from './helpers.mjs';

// 对同一份输入比较两个独立验证器，避免只断言实现中的常量。
test('模型参数与运行时交接契约一致：必填、额外字段、枚举和边界', () => {
  const check = (value, expected) => {
    assert.equal(Value.Check(handoffParameters, value), expected);
    assert.equal(handoffSchema.safeParse(value).success, expected);
  };
  const base = { ...handoff(), status: 'partial' };
  check(base, true);
  for (const key of Object.keys(base)) {
    const missing = { ...base }; delete missing[key]; check(missing, false);
  }
  check({ ...base, unknown: 'x' }, false);
  for (const status of ['completed', 'partial', 'blocked']) check({ ...base, status }, true);
  check({ ...base, status: 'unknown' }, false);
  for (const result of ['passed', 'failed', 'not_run', 'invalid']) {
    check({ ...base, verification: [{ action: 'a', result, detail: 'd' }] }, result !== 'invalid');
  }
  for (const length of [0, 1, 2000, 2001]) check({ ...base, summary: 'x'.repeat(length) }, length > 0 && length <= 2000);
  for (const [key, maximum] of Object.entries({ changes: 20, verification: 20, evidence: 20, unresolved: 20, nextSteps: 10 })) {
    const item = key === 'verification' ? base.verification[0] : key === 'evidence' ? base.evidence[0] : 'x';
    for (const count of [0, maximum, maximum + 1]) check({ ...base, [key]: Array(count).fill(item) }, count <= maximum);
  }
  for (const length of [0, 1, 500, 501]) check({ ...base, evidence: [{ path: 'x'.repeat(length), note: 'n' }] }, length > 0 && length <= 500);
  for (const line of [0, -1, 1.5, 1]) check({ ...base, evidence: [{ path: 'p', line, note: 'n' }] }, line === 1);
  for (const evidence of [{ path: 'p', note: 'n', unknown: 'x' }, { path: 'p' }]) check({ ...base, evidence: [evidence] }, false);
});

test('业务层仍拒绝有遗留工作的 completed，工具参数校验不能代替最终校验', () => {
  const value = { ...handoff(), unresolved: ['尚未完成'] };
  assert.equal(Value.Check(handoffParameters, value), true);
  assert.equal(handoffSchema.safeParse(value).success, false);
});

test('所有任务阶段都可落盘；未知阶段拒绝；终态分类保持兼容', () => {
  const snapshot = {
    version: 1, sessionId: '00000000-0000-4000-8000-000000000000', pid: 1,
    heartbeatAt: new Date().toISOString(), closed: false, batchId: 'b', workspace: '/tmp',
    tasks: [{ task: { id: 't', title: 'T', instruction: '', acceptance: '', mode: 'coding' },
      phase: 'running', updatedAt: new Date().toISOString(), summary: 's', events: [], omittedEvents: 0 }],
  };
  for (const phase of [...PHASES, 'unknown']) {
    snapshot.tasks[0].phase = phase;
    assert.equal(snapshotSchema.safeParse(snapshot).success, phase !== 'unknown');
  }
  for (const phase of ['queued', 'starting', 'running', 'summarizing']) assert.equal(isTerminal(phase), false);
  for (const phase of ['completed', 'partial', 'blocked', 'failed', 'cancelled']) assert.equal(isTerminal(phase), true);
});

test('两端静止判定：缺少运行态、仍在执行、重试、压缩或排队时不能交付', () => {
  const idle = { settled: true, compacting: false, queue: { steering: 0, followUp: 0 } };
  assert.equal(isSettled(idle), true);
  for (const state of [undefined, null, { ...idle, settled: false }, { ...idle, compacting: true },
    { ...idle, retry: { attempt: 1 } }, { ...idle, queue: { steering: 1, followUp: 0 } },
    { ...idle, queue: { steering: 0, followUp: 1 } }]) assert.equal(isSettled(state), false);
});
