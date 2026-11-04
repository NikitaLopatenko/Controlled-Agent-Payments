import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const npmCliPath = process.env.npm_execpath;
assert.ok(typeof npmCliPath === 'string' && isAbsolute(npmCliPath),
  'Run this check through npm run smoke:consumer or npm run measure.');

export async function packPackages(directory) {
  directory = resolve(directory);
  await mkdir(directory, { recursive: true });
  const result = {};
  for (const name of ['payments', 'testing']) {
    const { stdout } = await exec(process.execPath, [npmCliPath, 'pack', '--workspace', `@cap/${name}`,
      '--pack-destination', directory, '--json', '--ignore-scripts'],
    { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const packed = JSON.parse(stdout);
    assert.equal(packed.length, 1, `Expected one @cap/${name} tarball`);
    const metadata = packed[0];
    assert.equal(metadata.name, `@cap/${name}`);
    assert.equal(metadata.version, '0.1.0');
    assert.equal(typeof metadata.filename, 'string');
    assert.equal(metadata.filename, metadata.filename.split('/').at(-1));
    assert.ok(Array.isArray(metadata.files) && metadata.files.length > 0);
    result[name] = { path: join(directory, metadata.filename), metadata };
  }
  return result;
}
