import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
export const grammar = Object.freeze({
  package: 'tree-sitter-bash', version: '0.25.1',
  sha256: '8292919c88a0f7d3fb31d0cd0253ca5a9531bc1ede82b0537f2c63dd8abe6a7a',
});

export function verifyGrammar(bytes, version) {
  if (version !== grammar.version || createHash('sha256').update(bytes).digest('hex') !== grammar.sha256) {
    throw new Error('bash_grammar_version_or_hash_mismatch');
  }
}

export async function copyRuntimeAssets(outDir = join(root, 'dist')) {
  const source = dirname(require.resolve('tree-sitter-bash/package.json'));
  const bytes = await readFile(join(source, 'tree-sitter-bash.wasm'));
  verifyGrammar(bytes, JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).version);
  const target = join(outDir, 'vendor', 'pi-permission-system');
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'tree-sitter-bash.wasm'), bytes);
  await copyFile(join(source, 'LICENSE'), join(target, 'tree-sitter-bash.LICENSE'));
  for (const file of ['LICENSE', 'README.md']) {
    await copyFile(join(root, 'src', 'vendor', 'pi-permission-system', file), join(target, file));
  }
  await writeFile(join(target, 'tree-sitter-bash.version.json'), JSON.stringify(grammar, null, 2) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await copyRuntimeAssets(process.argv[2] ? resolve(process.argv[2]) : undefined);
}
