import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/acceptance/cli.mjs', import.meta.url));
async function fixture(t, script = "process.stdout.write('PRIVATE_RAW_LOG_NOT_FOR_SUMMARY')") {
  const root = await mkdtemp(join(tmpdir(), 'ProofLoop CLI 中文 space '));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await writeFile(join(root, 'source.mjs'), 'export const value = 1;\n');
  await writeFile(join(root, 'check.mjs'), script);
  const contract = {
    schemaVersion: 1, taskId: 'cli-sample', version: 1, goal: 'CLI checks a real fixture', projectDir: '.',
    sourceFiles: ['source.mjs'], allowedChanges: ['source.mjs'],
    requirements: [{ id: 'R1', description: 'Check the fixture', required: true, checkIds: ['C1'] }],
    checks: [{ id: 'C1', executable: 'node', args: ['check.mjs'], cwd: '.', timeoutMs: 2000, passExitCodes: [0], files: ['check.mjs'] }],
  };
  const contractPath = join(root, '验收 契约.json');
  const save = () => writeFile(contractPath, JSON.stringify(contract, null, 2));
  await save();
  const invoke = (args = ['verify', contractPath]) => spawnSync(process.execPath, [cli, ...args], {
    cwd: root, shell: false, windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
  });
  const report = async () => {
    const base = join(root, '.proofloop', 'acceptance', 'cli-sample');
    const names = await readdir(base);
    return JSON.parse(await readFile(join(base, names[0], 'report.json'), 'utf8'));
  };
  return { root, contractPath, contract, save, invoke, report };
}

test('CLI verifies a real check in a Chinese spaced path, exits zero and links actual evidence', async t => {
  const f = await fixture(t);
  const result = f.invoke();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /通过.*PASSED/);
  assert.match(result.stdout, /C1.*退出码.*0/);
  assert.match(result.stdout, /report\.md/);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_RAW_LOG_NOT_FOR_SUMMARY/);
  const report = await f.report();
  assert.equal(report.status, 'PASSED');
  assert.ok(result.stdout.includes(report.recordDir));
});

test('CLI returns one for a real assertion failure and points to its rework task', async t => {
  const f = await fixture(t, "require('node:assert/strict').equal(1, 2)");
  // ESM fixture uses a real imported assertion, not a missing require failure.
  await writeFile(join(f.root, 'check.mjs'), "import assert from 'node:assert/strict'; assert.equal(1, 2)");
  const result = f.invoke();
  assert.equal(result.status, 1);
  assert.match(result.stdout, /未通过.*FAILED/);
  assert.match(result.stdout, /repair-prompt\.md/);
  assert.doesNotMatch(result.stdout + result.stderr, /AssertionError/);
  const report = await f.report();
  assert.equal(report.checks[0].exitCode, 1);
  assert.match(await readFile(join(report.recordDir, 'repair-prompt.md'), 'utf8'), /不得.*删除测试/);
});

test('CLI helps explicitly and rejects invalid arguments or invalid contracts without a stack dump', async t => {
  const f = await fixture(t);
  for (const args of [['help'], ['--help']]) {
    const result = f.invoke(args);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /verify.*contract\.json/);
  }
  for (const args of [[], ['unknown'], ['verify'], ['verify', f.contractPath, '--unknown'], ['--help', 'extra']]) {
    const result = f.invoke(args);
    assert.equal(result.status, 3, `arguments ${JSON.stringify(args)}`);
    assert.match(result.stderr, /INVALID_ARGUMENTS/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  }
  f.contract.checks = [];
  await f.save();
  const invalid = f.invoke();
  assert.equal(invalid.status, 3);
  assert.match(invalid.stderr, /INVALID_CONTRACT/);
  assert.ok(invalid.stderr.includes(f.contractPath));
  assert.doesNotMatch(invalid.stderr, /\n\s+at /);
  await writeFile(f.contractPath, '');
  assert.equal(f.invoke().status, 3);
});

test('a missing executable produces exit two and a real inconclusive report', async t => {
  const f = await fixture(t);
  f.contract.checks[0].executable = 'proofloop-cli-missing-executable-9a28';
  await f.save();
  const result = f.invoke();
  assert.equal(result.status, 2);
  assert.match(result.stdout, /无法判定.*INCONCLUSIVE/);
  assert.equal((await f.report()).checks[0].exitCode, null);
});

test('a timed-out check produces exit two, saves evidence and warns about cleanup limits', async t => {
  const f = await fixture(t, 'setTimeout(() => {}, 1800)');
  f.contract.checks[0].timeoutMs = 80;
  await f.save();
  const started = Date.now();
  const result = f.invoke();
  assert.equal(result.status, 2);
  assert.ok(Date.now() - started < 2500);
  assert.match(result.stdout, /清理/);
  assert.equal((await f.report()).status, 'INCONCLUSIVE');
});

test('an uncovered mandatory requirement is reported for manual acceptance and exits two', async t => {
  const f = await fixture(t);
  f.contract.requirements.push({ id: 'R2', description: 'Human checks usability', required: true, checkIds: [] });
  await f.save();
  const result = f.invoke();
  assert.equal(result.status, 2);
  assert.match(result.stdout, /R2.*人工验收/);
  assert.match(result.stdout, /未验证/);
});

test('exit zero is a CLI failure if the explicit contract only accepts exit seven', async t => {
  const f = await fixture(t);
  f.contract.checks[0].passExitCodes = [7];
  await f.save();
  const result = f.invoke();
  assert.equal(result.status, 1);
  assert.match(result.stdout, /C1.*未通过.*退出码.*0/);
  assert.equal((await f.report()).status, 'FAILED');
});

test('CLI handles a scripted SIGINT event, aborts a real check and persists an inconclusive report', async t => {
  const f = await fixture(t, 'setTimeout(() => {}, 700)');
  // Explicit fixture event: tests portable CLI cancellation wiring, not OS signal delivery.
  const preload = 'data:text/javascript,' + encodeURIComponent("setTimeout(() => process.emit('SIGINT'), 180)");
  const result = spawnSync(process.execPath, ['--import', preload, cli, 'verify', f.contractPath], {
    cwd: f.root, shell: false, windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /无法判定.*INCONCLUSIVE/);
  const report = await f.report();
  assert.equal(report.status, 'INCONCLUSIVE');
  assert.match(report.checks[0].reason, /abort|interrupt/i);
});

test('a changed contract needs the explicit approval flag at the CLI boundary', async t => {
  const f = await fixture(t);
  assert.equal(f.invoke().status, 0);
  f.contract.version = 2;
  await f.save();
  const refused = f.invoke();
  assert.equal(refused.status, 3);
  assert.match(refused.stderr, /CONTRACT_CHANGE_REQUIRES_APPROVAL/);
  const approved = f.invoke(['verify', f.contractPath, '--approve-contract-change']);
  assert.equal(approved.status, 0, approved.stderr);
});

test('unavailable evidence storage returns exit three without a false passing summary', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, '.proofloop'), 'fixture: a file blocks evidence-directory creation');
  const result = f.invoke();
  assert.equal(result.status, 3);
  assert.doesNotMatch(result.stdout, /PASSED/);
  assert.match(result.stderr, /不能据此宣布通过/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});
