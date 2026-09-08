import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verify } from '../src/acceptance/verify.mjs';

async function fixture(t, script = "console.log('checked'); console.error('diagnostic');") {
  const root = await mkdtemp(join(tmpdir(), 'ProofLoop 中文 space '));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'checks'));
  await writeFile(join(root, 'src', 'value.mjs'), 'export const value = 1;\n');
  await writeFile(join(root, 'checks', 'check.mjs'), script);
  const contract = {
    schemaVersion: 1, taskId: 'sample', version: 1, goal: 'Check the sample', projectDir: '.',
    sourceFiles: ['src/value.mjs'], allowedChanges: ['src/value.mjs'],
    requirements: [{ id: 'R1', description: 'the sample satisfies its test', required: true, checkIds: ['C1'] }],
    checks: [{ id: 'C1', executable: 'node', args: ['checks/check.mjs'], cwd: '.', timeoutMs: 3000, passExitCodes: [0], files: ['checks/check.mjs'] }],
  };
  const contractPath = join(root, 'contract.json');
  await writeFile(contractPath, JSON.stringify(contract, null, 2));
  return { root, contractPath, contract };
}

test('a real successful check produces readable version-bound evidence and original logs', async t => {
  const f = await fixture(t);
  const result = await verify(f.contractPath);
  assert.equal(result.status, 'PASSED');
  const report = JSON.parse(await readFile(join(result.recordDir, 'report.json'), 'utf8'));
  assert.equal(report.taskId, 'sample');
  assert.equal(report.checks[0].exitCode, 0);
  assert.match(report.codeId, /^[a-f0-9]{64}$/);
  assert.match(report.contractId, /^[a-f0-9]{64}$/);
  assert.equal(await readFile(join(result.recordDir, 'checks/C1.stdout.log'), 'utf8'), 'checked\n');
  assert.equal(await readFile(join(result.recordDir, 'checks/C1.stderr.log'), 'utf8'), 'diagnostic\n');
  assert.match(await readFile(join(result.recordDir, 'report.md'), 'utf8'), /PASSED/);
  assert.equal(report.requirements[0].status, 'PASSED');
  assert.equal(report.runtime.node, process.version);
  assert.match(report.runtime.toolId, /^[a-f0-9]{64}$/);
  assert.ok(report.runtime.files.some(file => file.path === 'verify.mjs'));
});

test('manual rework gets a new record under the same task without changing the standard or erasing failure', async t => {
  const f = await fixture(t, "import assert from 'node:assert/strict'; import { value } from '../src/value.mjs'; assert.equal(value, 2);\n");
  const failed = await verify(f.contractPath);
  assert.equal(failed.status, 'FAILED');
  const originalFailure = await readFile(join(failed.recordDir, 'report.json'), 'utf8');
  const repair = await readFile(join(failed.recordDir, 'repair-prompt.md'), 'utf8');
  assert.match(repair, /Check the sample/);
  assert.match(repair, /C1/);
  assert.match(repair, /src\/value.mjs/);
  assert.match(repair, /不得.*删除测试/);
  assert.match(repair, /verify/);
  // Test mechanism only: represents a user/Codex edit, not autonomous model repair.
  await writeFile(join(f.root, 'src/value.mjs'), 'export const value = 2;\n');
  const passed = await verify(f.contractPath);
  assert.equal(passed.status, 'PASSED');
  assert.notEqual(passed.runId, failed.runId);
  assert.notEqual(passed.codeId, failed.codeId);
  assert.equal(passed.contractId, failed.contractId);
  assert.equal(passed.standardId, failed.standardId);
  assert.equal(passed.previousRecordId, failed.runId);
  assert.equal(await readFile(join(failed.recordDir, 'report.json'), 'utf8'), originalFailure);
});

test('changed acceptance scripts require a new explicitly approved contract version', async t => {
  const f = await fixture(t);
  const first = await verify(f.contractPath);
  await writeFile(join(f.root, 'checks/check.mjs'), "console.log('changed acceptance script');\n");
  await assert.rejects(verify(f.contractPath), /CONTRACT_VERSION_REUSED/);
  f.contract.version = 2;
  await writeFile(f.contractPath, JSON.stringify(f.contract, null, 2));
  await assert.rejects(verify(f.contractPath), /CONTRACT_CHANGE_REQUIRES_APPROVAL/);
  const next = await verify(f.contractPath, { approveContractChange: true });
  assert.equal(next.status, 'PASSED');
  assert.notEqual(next.standardId, first.standardId);
  assert.equal(next.contractVersion, 2);
  f.contract.version = 1;
  await writeFile(f.contractPath, JSON.stringify(f.contract, null, 2));
  await assert.rejects(verify(f.contractPath), /SUPERSEDED_CONTRACT/);
});

test('a check that changes or removes tracked input cannot produce stable passing evidence', async t => {
  for (const action of ['change', 'restore', 'delete', 'contract']) {
    await t.test(action, async sub => {
      const actions = {
        change: "writeFileSync('src/value.mjs', 'export const value = 99;');",
        restore: "const old = readFileSync('src/value.mjs'); writeFileSync('src/value.mjs', 'temporary'); writeFileSync('src/value.mjs', old);",
        delete: "unlinkSync('src/value.mjs');",
        contract: "appendFileSync('contract.json', '\\n');",
      };
      const f = await fixture(sub, `import {readFileSync,writeFileSync,unlinkSync,appendFileSync} from 'node:fs'; ${actions[action]} console.log('exit zero is not enough');`);
      const result = await verify(f.contractPath);
      assert.equal(result.status, 'INCONCLUSIVE');
      assert.equal(result.stable, false);
      assert.equal(result.requirements[0].status, 'INCONCLUSIVE');
      assert.ok(result.unverified.length > 0);
      assert.match(await readFile(join(result.recordDir, 'report.md'), 'utf8'), /INCONCLUSIVE/);
    });
  }
});

test('missing raw log evidence cannot be replaced by an in-memory success', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'checks/remove-log.mjs'), "import {readdirSync,unlinkSync} from 'node:fs'; const base='.proofloop/acceptance/sample'; const id=readdirSync(base).find(x=>/^[a-f0-9-]{36}$/.test(x)); unlinkSync(base+'/'+id+'/checks/C1.stdout.log');");
  f.contract.checks.push({ ...f.contract.checks[0], id: 'C2', args: ['checks/remove-log.mjs'], files: ['checks/remove-log.mjs'] });
  f.contract.requirements[0].checkIds.push('C2');
  await writeFile(f.contractPath, JSON.stringify(f.contract, null, 2));
  const result = await verify(f.contractPath);
  assert.equal(result.status, 'INCONCLUSIVE');
  assert.match(result.unverified.join('\n'), /C1.stdout.log/);
  assert.equal(result.checks.find(check => check.id === 'C1').status, 'INCONCLUSIVE');
  assert.match(await readFile(join(result.recordDir, 'repair-prompt.md'), 'utf8'), /C1.stdout.log/);
});

test('invalid contracts and path aliases are rejected before a check can run', async t => {
  const cases = [
    ['empty checks', c => { c.checks = []; }],
    ['bad timeout', c => { c.checks[0].timeoutMs = 0; }],
    ['shell text args', c => { c.checks[0].args = 'checks/check.mjs'; }],
    ['unknown requirement check', c => { c.requirements[0].checkIds = ['unknown']; }],
    ['duplicate check', c => { c.checks.push(c.checks[0]); }],
    ['null requirement', c => { c.requirements = [null]; }],
    ['protected path alias', c => { c.sourceFiles.push('checks\\check.mjs'); c.allowedChanges.push('checks\\check.mjs'); }],
    ['parent path alias', c => { c.sourceFiles = ['src/../src/value.mjs']; c.allowedChanges = []; }],
    ['reserved Windows identifier', c => { c.taskId = 'CON'; }],
    ['nonstring task ID', c => { c.taskId = 123; }],
    ['node test script is not modifiable source', c => { c.checks[0].args = ['--test', 'checks/check.mjs']; c.checks[0].files = []; c.sourceFiles.push('checks/check.mjs'); }],
  ];
  for (const [name, change] of cases) await t.test(name, async sub => {
    const f = await fixture(sub, "import {writeFileSync} from 'node:fs'; writeFileSync('ran.txt', 'bad');");
    change(f.contract);
    await writeFile(f.contractPath, JSON.stringify(f.contract));
    await assert.rejects(verify(f.contractPath), /INVALID_CONTRACT/);
    await assert.rejects(access(join(f.root, 'ran.txt')));
  });
});

test('two simultaneous verifications of the same task cannot race its standard and history', async t => {
  const f = await fixture(t, "import {writeFileSync} from 'node:fs'; writeFileSync('started.txt','yes'); setTimeout(()=>console.log('done'),300);");
  const running = verify(f.contractPath);
  try {
    for (let count = 0; count < 100; count++) {
      try { await access(join(f.root, 'started.txt')); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    await assert.rejects(verify(f.contractPath), /TASK_BUSY/);
  } finally { assert.equal((await running).status, 'PASSED'); }
  assert.equal((await verify(f.contractPath)).status, 'PASSED');
});

test('an explicitly executed local script must be included in the acceptance file manifest', async t => {
  const f = await fixture(t);
  f.contract.checks[0].files = [];
  await writeFile(f.contractPath, JSON.stringify(f.contract));
  await assert.rejects(verify(f.contractPath), /INVALID_CONTRACT.*not listed/);
});

test('raw log files retain original output bytes even when the text preview is not valid UTF-8', async t => {
  const f = await fixture(t, 'process.stdout.write(Buffer.from([255, 0, 65]));');
  const result = await verify(f.contractPath);
  assert.equal(result.status, 'PASSED');
  assert.deepEqual(await readFile(join(result.recordDir, 'checks/C1.stdout.log')), Buffer.from([255, 0, 65]));
});

test('unconfirmed cleanup prevents later checks from starting effects', async t => {
  const f = await fixture(t, 'setInterval(()=>{},1000);');
  f.contract.checks[0].timeoutMs = 150;
  await writeFile(join(f.root, 'checks/next.mjs'), "import {writeFileSync} from 'node:fs'; writeFileSync('should-not-run.txt','bad');");
  f.contract.checks.push({ ...f.contract.checks[0], id: 'C2', args: ['checks/next.mjs'], files: ['checks/next.mjs'], timeoutMs: 3000 });
  f.contract.requirements[0].checkIds.push('C2');
  await writeFile(f.contractPath, JSON.stringify(f.contract));
  const result = await verify(f.contractPath);
  assert.equal(result.status, 'INCONCLUSIVE');
  assert.equal(result.checks[1].status, 'INCONCLUSIVE');
  assert.match(result.checks[1].reason, /not started|未执行/);
  await assert.rejects(access(join(f.root, 'should-not-run.txt')));
});
