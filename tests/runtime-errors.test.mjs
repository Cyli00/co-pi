import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyModelError, runtimeErrorGuidance } from '../dist/runtime-errors.js';

test('模型失败只公开固定分类，保留沙盒、认证、TLS 与服务错误的区别', () => {
  const restricted = { CODEX_SANDBOX_NETWORK_DISABLED: '1' };
  const cases = [
    ['No API key found for provider x', 'model_auth_required'],
    ['401 invalid API key secret-value', 'model_auth_rejected'],
    ['403 forbidden', 'model_auth_rejected'],
    ['429 Rate limit', 'model_rate_limited'],
    ['404 model not found', 'model_unavailable'],
    ['certificate verify failed', 'model_tls_failed'],
    ['fetch failed', 'model_network_disabled'],
    ['Connection error.', 'model_network_disabled'],
    ['opaque response with bearer secret-value', 'model_request_failed'],
  ];
  for (const [message, expected] of cases) {
    assert.equal(classifyModelError(message, restricted), expected);
    assert.ok(runtimeErrorGuidance(expected));
    assert.ok(!runtimeErrorGuidance(expected).includes('secret-value'));
  }
  assert.equal(classifyModelError(new Error('fetch failed', { cause: { code: 'ENOTFOUND' } }), {}), 'model_network_failed');
  assert.equal(classifyModelError({ status: 401 }, {}), 'model_auth_rejected');
  assert.equal(classifyModelError(undefined, restricted), 'model_request_failed');
});
