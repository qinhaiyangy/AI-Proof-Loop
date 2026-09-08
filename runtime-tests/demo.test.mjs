import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const repo = fileURLToPath(new URL('../', import.meta.url));
test('one-command deterministic demo uses real failing and passing checks without editing the shipped example', async t => {
  const original = await readFile(join(repo, 'examples/keyword-filter/src/filter.mjs'));
  const result = spawnSync(process.execPath, [join(repo, 'scripts/demo-acceptance.mjs')], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /确定性.*不是.*自主修复/);
  const recordFile = result.stdout.match(/演示记录：(.*)/)?.[1].trim();
  assert.ok(recordFile);
  const demo = JSON.parse(await readFile(recordFile, 'utf8'));
  assert.equal(demo.kind, 'deterministic-fixture');
  assert.equal(demo.failed.status, 'FAILED');
  assert.equal(demo.passed.status, 'PASSED');
  assert.equal(demo.failed.contractId, demo.passed.contractId);
  assert.equal(demo.failed.standardId, demo.passed.standardId);
  assert.notEqual(demo.failed.codeId, demo.passed.codeId);
  assert.equal(demo.passed.previousRecordId, demo.failed.runId);
  assert.deepEqual(await readFile(join(repo, 'examples/keyword-filter/src/filter.mjs')), original);
  assert.match(await readFile(join(demo.failed.recordDir, 'checks/case-insensitive.stderr.log'), 'utf8'), /AssertionError/);
  // Only remove the newly generated test demo, never the example's primary evidence.
  const generated = resolve(dirname(recordFile));
  assert.equal(dirname(generated), resolve(repo, '.proofloop'));
  assert.match(generated.slice(dirname(generated).length + 1), /^demo-/);
  t.after(() => rm(generated, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
});
