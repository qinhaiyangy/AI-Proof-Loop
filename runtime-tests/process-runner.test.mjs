import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCheck } from '../src/acceptance/process-runner.mjs';

function nodeCheck(source, overrides = {}) {
  return {
    id: 'real-process', executable: process.execPath, args: ['-e', source],
    cwd: process.cwd(), timeoutMs: 2000, passExitCodes: [0], ...overrides,
  };
}

test('a real check captures stdout, stderr, timing and its accepted exit code', async () => {
  const result = await runCheck(nodeCheck("process.stdout.write('actual stdout'); process.stderr.write('actual stderr')"));
  assert.equal(result.status, 'PASSED');
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'actual stdout');
  assert.equal(result.stderr, 'actual stderr');
  assert.ok(Date.parse(result.finishedAt) >= Date.parse(result.startedAt));
});

test('a real failing assertion is FAILED and a missing executable is INCONCLUSIVE', async () => {
  const failed = await runCheck(nodeCheck("require('node:assert/strict').equal(1, 2)"));
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.exitCode, 1);
  assert.match(failed.stderr, /AssertionError/);
  const absent = await runCheck(nodeCheck('', { executable: 'proofloop-deliberately-missing-executable-923f' }));
  assert.equal(absent.status, 'INCONCLUSIVE');
  assert.equal(absent.exitCode, null);
  assert.match(absent.reason, /ENOENT/);
});

test('a timeout stops waiting, reports INCONCLUSIVE and describes targeted cleanup', async () => {
  const started = Date.now();
  const result = await runCheck(nodeCheck('setTimeout(() => {}, 1800)', { timeoutMs: 100 }));
  assert.equal(result.status, 'INCONCLUSIVE');
  assert.match(result.reason, /timed out/i);
  assert.equal(result.cleanup.attempted, true);
  assert.equal(typeof result.cleanup.confirmed, 'boolean');
  assert.ok(result.cleanup.detail.length > 0);
  assert.ok(Date.now() - started < 1700);
});

test('an aborted check is INCONCLUSIVE and a pre-aborted check is never started', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 80);
  try {
    const result = await runCheck(nodeCheck('setTimeout(() => {}, 500)'), { signal: controller.signal });
    assert.equal(result.status, 'INCONCLUSIVE');
    assert.match(result.reason, /abort|interrupt/i);
    assert.equal(result.cleanup.attempted, true);
    const skipped = await runCheck(nodeCheck("process.stdout.write('must not run')"), { signal: controller.signal });
    assert.equal(skipped.status, 'INCONCLUSIVE');
    assert.equal(skipped.stdout, '');
    assert.equal(skipped.cleanup.attempted, false);
  } finally { clearTimeout(timer); }
});

test('output beyond 1 MiB is bounded evidence and cannot create a passing result', async () => {
  const result = await runCheck(nodeCheck("process.stdout.write('x'.repeat(2 * 1024 * 1024))"));
  assert.equal(result.status, 'INCONCLUSIVE');
  assert.match(result.reason, /output.*limit|limit.*output/i);
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 1024 * 1024);
  assert.ok(result.stdout.length > 0);
});

test('Chinese and spaced working paths and literal arguments are not shell commands', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'proofloop 中文 路径 '));
  try {
    const script = join(workspace, '实际 检查.mjs');
    await writeFile(script, "process.stdout.write(JSON.stringify({cwd: process.cwd(), args: process.argv.slice(2)}))");
    const result = await runCheck(nodeCheck('', { args: [script, '中文 & literal space'], cwd: workspace }));
    assert.equal(result.status, 'PASSED');
    assert.deepEqual(JSON.parse(result.stdout), { cwd: workspace, args: ['中文 & literal space'] });
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('a synchronously rejected spawn argument is an inconclusive check, not an escaped exception', async () => {
  const result = await runCheck(nodeCheck('', { args: ['contains\u0000nul'] }));
  assert.equal(result.status, 'INCONCLUSIVE');
  assert.equal(result.exitCode, null);
  assert.match(result.reason, /start|argument/i);
});

test('a check with an output-inheriting child is bounded by its timeout', async () => {
  const source = "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1800)'], { stdio: 'inherit', windowsHide: true }); setTimeout(() => {}, 1800)";
  const started = Date.now();
  const result = await runCheck(nodeCheck(source, { timeoutMs: 200 }));
  assert.equal(result.status, 'INCONCLUSIVE');
  assert.match(result.reason, /timed out/i);
  assert.equal(result.cleanup.confirmed, false);
  assert.ok(Date.now() - started < 1600);
});

test('timing out one check does not terminate another independently running check', async () => {
  const [timedOut, independent] = await Promise.all([
    runCheck(nodeCheck('setTimeout(() => {}, 1000)', { timeoutMs: 80 })),
    runCheck(nodeCheck("setTimeout(() => process.stdout.write('still alive'), 300)")),
  ]);
  assert.equal(timedOut.status, 'INCONCLUSIVE');
  assert.equal(independent.status, 'PASSED');
  assert.equal(independent.stdout, 'still alive');
});

test('a nonzero exit is accepted only when the contract explicitly permits it', async () => {
  const result = await runCheck(nodeCheck('process.exit(7)', { passExitCodes: [7] }));
  assert.equal(result.status, 'PASSED');
  assert.equal(result.exitCode, 7);
});

test('termination by a signal is inconclusive and names the signal', {
  skip: process.platform === 'win32' ? 'Windows reports self-SIGTERM as exit code 1 without a signal; this signal metadata branch requires a POSIX run.' : false,
}, async () => {
  const result = await runCheck(nodeCheck("process.kill(process.pid, 'SIGTERM')"));
  assert.equal(result.status, 'INCONCLUSIVE');
  assert.equal(result.signal, 'SIGTERM');
  assert.match(result.reason, /SIGTERM/);
});
