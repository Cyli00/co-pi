import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanHandoff, prepareHandoff } from '../dist/protocol.js';
import { handoff } from './helpers.mjs';

function feedback(value) {
  let error;
  try { prepareHandoff(value); } catch (caught) { error = caught; }
  assert.ok(error, '无效交接应被拒绝');
  const result = JSON.parse(error.message);
  assert.equal(result.error, 'handoff_validation_failed');
  assert.match(result.instruction, /call submit_handoff again/);
  return result;
}

test('交接七个顶层字段均必填，不会自动补成空数组', () => {
  for (const field of ['status', 'summary', 'changes', 'verification', 'evidence', 'unresolved', 'nextSteps']) {
    const value = handoff();
    delete value[field];
    assert.throws(() => cleanHandoff(value));
    assert.ok(feedback(value).issues.some(issue => issue.path === field && issue.code === 'required'), field);
  }
});

test('数组允许为空；证据行号可省略，其他条目字段不可省略', () => {
  const minimal = { status: 'completed', summary: '只读检查完成，无修改', changes: [], verification: [], evidence: [], unresolved: [], nextSteps: [] };
  assert.deepEqual(prepareHandoff(minimal), minimal);
  const noLine = handoff();
  delete noLine.evidence[0].line;
  assert.deepEqual(prepareHandoff(noLine), noLine);
  for (const [array, fields] of [['verification', ['action', 'result', 'detail']], ['evidence', ['path', 'note']]]) {
    for (const field of fields) {
      const value = handoff();
      delete value[array][0][field];
      assert.ok(feedback(value).issues.some(issue => issue.path === `${array}.0.${field}` && issue.code === 'required'));
    }
  }
});

test('交接约束错误给出字段反馈，不回显原始参数或未知字段名', () => {
  const value = handoff('PRIVATE_VALUE_SENTINEL');
  value.status = 'PRIVATE_STATUS_SENTINEL';
  value.PRIVATE_FIELD_SENTINEL = 'PRIVATE_VALUE_SENTINEL';
  const result = feedback(value);
  assert.ok(result.issues.some(issue => issue.path === 'status' && issue.code === 'invalid_enum_value'));
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
  assert.ok(feedback({ ...handoff(), unresolved: ['尚未完成'] }).issues.some(issue => issue.path === 'unresolved'));
  assert.ok(feedback({ ...handoff(), summary: '' }).issues.some(issue => issue.path === 'summary'));
  const zeroLine = handoff(); zeroLine.evidence[0].line = 0;
  assert.ok(feedback(zeroLine).issues.some(issue => issue.path === 'evidence.0.line'));
  const badVerification = handoff(); badVerification.verification[0].result = 'unknown';
  assert.ok(feedback(badVerification).issues.some(issue => issue.path === 'verification.0.result'));
});

test('交接总字节数超限时要求重新提交，不截断交接后冒充成功', () => {
  const value = { ...handoff(), changes: Array.from({ length: 20 }, () => '大'.repeat(1000)) };
  const result = feedback(value);
  assert.equal(result.issues[0].code, 'handoff_too_large');
  assert.equal(value.changes.length, 20);
  assert.equal(value.changes[0].length, 1000);
});
