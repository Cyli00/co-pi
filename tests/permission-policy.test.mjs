import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { temporary } from './helpers.mjs';
import { createPermissionPolicy } from '../dist/permission-policy.js';

test('内置权限模块：工作区文件放行，外部路径和未知程序请求审批', async t => {
  const root = temporary(t), workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const policy = await createPermissionPolicy(workspace);
  for (const name of ['read', 'write', 'edit', 'grep', 'find', 'ls']) {
    assert.deepEqual(await policy(name, { path: './local.txt', content: 'test', oldText: 'a', newText: 'b' }), [], name);
    assert.ok((await policy(name, { path: '../outside.txt', content: 'test' })).length, name);
  }
  for (const command of ['pwd', 'printf hello > ./local.txt', 'cat ./local.txt']) {
    assert.deepEqual(await policy('bash', { command }), [], command);
  }
  for (const command of ['printf hello > ../outside.txt', 'cat ../outside.txt',
    'cd .. && pwd', 'python -c "print(1)"', 'node script.js', 'git rm local.txt',
    'bash -c "pwd"', 'eval "pwd"', './script.sh', 'cat $(echo ../outside.txt)',
    'printf hello > "$TARGET"', 'extension-command']) {
    assert.ok((await policy('bash', { command })).length, command);
  }
  assert.ok((await policy('custom_tool', { path: './local.txt' })).length);
  assert.ok((await policy('write', { path: '@../outside.txt', content: 'test' })).length);
  // 不继承用户或项目的 YOLO/允许规则，也不豁免外部 node_modules 读取。
  mkdirSync(join(workspace, '.pi', 'extensions', 'pi-permission-system'), { recursive: true });
  writeFileSync(join(workspace, '.pi', 'extensions', 'pi-permission-system', 'config.json'),
    JSON.stringify({ yoloMode: true, permission: { '*': 'allow', external_directory: 'allow' } }));
  assert.ok((await policy('read', { path: '../node_modules/package/index.js' })).length);
});

test('内置权限模块：工作区内的目录链接不能免审访问外部文件或新建文件', async t => {
  const root = temporary(t), workspace = join(root, 'workspace'), outside = join(root, 'outside');
  mkdirSync(workspace); mkdirSync(outside); writeFileSync(join(outside, 'existing.txt'), 'old');
  symlinkSync(outside, join(workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const policy = await createPermissionPolicy(workspace);
  for (const path of ['linked/existing.txt', 'linked/new.txt', 'linked/new-dir/new.txt']) {
    assert.ok((await policy('write', { path, content: 'new' })).length, path);
    assert.ok((await policy('bash', { command: `printf new > ${path}` })).length, path);
  }
});

test('Bash AST：字面量与重定向放行，间接输入、解析错误和未知工作目录审批', async t => {
  const workspace = temporary(t);
  const policy = await createPermissionPolicy(workspace);
  for (const command of ['cat "space name.txt"', "cat 'space name.txt'", 'cat < local.txt',
    'printf "%s" hello >> local.txt', 'wc -l local.txt', 'ls -al .']) {
    assert.deepEqual(await policy('bash', { command }), [], command);
  }
  for (const command of ['cat "../space name.txt"', "printf x > '../outside.txt'", 'cat < ../outside.txt',
    'wc --files0-from=../list.txt', 'ls -R .', 'ls -L .', 'cat *.txt', 'cat ~/file',
    'printf x > ~/file', 'cat "$HOME/file"', 'cat "$(pwd)/file"', 'cat <(pwd)', 'cat <<< hello',
    'cat <> ../file', 'cat "unterminated', 'echo x; pwd', 'echo x && pwd', 'echo x | cat',
    'X=value cat local.txt', 'printf x > file 2>&1', 'echo x > file > ../outside.txt']) {
    assert.ok((await policy('bash', { command })).length, command);
  }
  assert.ok((await policy('bash', { command: 'cat local.txt', workdir: join(workspace, '..') })).length);
  if (process.platform === 'win32') {
    const msys = workspace.replaceAll('\\', '/').replace(/^([a-z]):/i, (_, drive) => `/${drive.toLowerCase()}`);
    assert.deepEqual(await policy('bash', { command: `cat '${msys}/new.txt'` }), []);
    assert.ok((await policy('bash', { command: 'cat /tmp/file' })).length);
  }
});

test('悬空目录链接及其缺失后代不能作为工作区内新文件免审', async t => {
  const root = temporary(t), workspace = join(root, 'workspace');
  mkdirSync(workspace);
  symlinkSync(join(root, 'missing'), join(workspace, 'dangling'), process.platform === 'win32' ? 'junction' : 'dir');
  const policy = await createPermissionPolicy(workspace);
  for (const path of ['dangling/file.txt', 'dangling/subdir/new.txt']) {
    assert.ok((await policy('write', { path, content: 'test' })).length, path);
    assert.ok((await policy('bash', { command: `printf x > ${path}` })).length, path);
  }
});

test('Bash 路径不能先词法折叠链接后的父目录', async t => {
  const root = temporary(t), workspace = join(root, 'workspace'), outside = join(root, 'outside');
  mkdirSync(workspace); mkdirSync(outside);
  symlinkSync(outside, join(workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const policy = await createPermissionPolicy(workspace);
  for (const command of ['cat linked/../outside.txt', 'printf fixture > linked/../escaped.txt',
    "cat 'linked/../outside.txt'", 'cat < linked/../outside.txt']) {
    assert.ok((await policy('bash', { command })).length, command);
  }
  assert.deepEqual(await policy('bash', { command: 'cat ./local.txt' }), []);
});

test('Bash 续行及转义路径必须审批，不能按 AST 原文本放行', async t => {
  const policy = await createPermissionPolicy(temporary(t));
  const slash = String.fromCharCode(92);
  for (const command of [`cat .${slash}\n./outside.txt`, `cat .${slash}\r\n./outside.txt`,
    `printf fixture > .${slash}\n./escaped.txt`, `cat ..${slash}/outside.txt`,
    `cat "local${slash}${slash}name.txt"`]) {
    assert.ok((await policy('bash', { command })).length, JSON.stringify(command));
  }
  assert.deepEqual(await policy('bash', { command: "cat 'space name.txt'" }), []);
});
