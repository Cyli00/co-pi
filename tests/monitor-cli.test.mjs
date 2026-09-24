import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { temporary, task } from './helpers.mjs';

test('--once 输出所有批次的任务，不使用交互分页截断', t => {
  const root = temporary(t);
  const at = new Date().toISOString();
  for (const total of [0, 1, 2, 4, 10]) {
    const stateDir = join(root, `state-${total}`);
    const sessionId = randomUUID();
    const directory = join(stateDir, sessionId);
    mkdirSync(directory, { recursive: true });
    for (let start = 0; start < total; start += 4) {
      const snapshot = { version: 1, sessionId, batchId: `batch-${start}`, pid: 1, workspace: root, heartbeatAt: at, closed: false,
        tasks: Array.from({ length: Math.min(4, total - start) }, (_, i) => ({
          task: { ...task(`one-${i + start}`), title: `TITLE_${i + start}_END` }, phase: 'running', updatedAt: at, summary: '', events: [], omittedEvents: 0,
        })) };
      writeFileSync(join(directory, `${snapshot.batchId}.json`), JSON.stringify(snapshot));
    }
    const result = spawnSync(process.execPath, ['dist/monitor-cli.js', '--once', '--state-dir', stateDir, '--codex-home', join(root, 'empty-codex')], {
      encoding: 'utf8', env: { ...process.env, CODEX_THREAD_ID: '' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal((result.stdout.match(/TITLE_\d+_END/g) ?? []).length, total);
    for (let i = 0; i < total; i++) assert.ok(result.stdout.includes(`TITLE_${i}_END`));
  }
});
