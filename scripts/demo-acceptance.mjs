import { mkdir, mkdtemp, copyFile, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { verify } from '../src/acceptance/verify.mjs';

// A deterministic replay with real child-process checks. It does not call a model.
async function demo() {
  const repo = fileURLToPath(new URL('../', import.meta.url));
  const example = join(repo, 'examples', 'keyword-filter');
  const output = join(repo, '.proofloop');
  await mkdir(output, { recursive: true });
  if (await realpath(output) !== output) throw new Error('Demo output must not redirect through a symlink.');
  const directory = await mkdtemp(join(output, 'demo-'));
  await mkdir(join(directory, 'src'));
  await mkdir(join(directory, 'checks'));
  await copyFile(join(example, 'contract.json'), join(directory, 'contract.json'));
  await copyFile(join(example, 'checks', 'filter.check.mjs'), join(directory, 'checks', 'filter.check.mjs'));
  await copyFile(join(example, 'fixtures', 'filter.broken.txt'), join(directory, 'src', 'filter.mjs'));
  console.log('ProofLoop 确定性流程演示：真实运行检查，不是实时模型自主修复。');
  const failed = await verify(join(directory, 'contract.json'));
  assert.equal(failed.status, 'FAILED', 'The deliberately broken fixture must actually fail.');
  console.log(`1. 错误夹具：${failed.status}；返工任务：${join(failed.recordDir, 'repair-prompt.md')}`);
  // This pre-authored replacement represents a manual edit only for repeatable demos.
  await copyFile(join(example, 'src', 'filter.mjs'), join(directory, 'src', 'filter.mjs'));
  const passed = await verify(join(directory, 'contract.json'));
  assert.equal(passed.status, 'PASSED', 'The fixed fixture must actually pass.');
  assert.equal(passed.contractId, failed.contractId);
  assert.equal(passed.standardId, failed.standardId);
  assert.notEqual(passed.codeId, failed.codeId);
  assert.equal(passed.previousRecordId, failed.runId);
  const summary = report => ({ runId: report.runId, previousRecordId: report.previousRecordId, status: report.status, codeId: report.codeId, contractId: report.contractId, standardId: report.standardId, recordDir: report.recordDir });
  await writeFile(join(directory, 'demo.json'), JSON.stringify({ kind: 'deterministic-fixture', failed: summary(failed), passed: summary(passed) }, null, 2) + '\n', { flag: 'wx' });
  await writeFile(join(directory, 'demo.md'), [
    '# ProofLoop 确定性流程演示', '',
    '使用预设错误/正确实现，验收命令由真实进程执行。不是实时模型自主修复。', '',
    `失败：${failed.runId}；代码 ${failed.codeId}`, '',
    `通过：${passed.runId}；代码 ${passed.codeId}`, '',
    `契约保持不变：${passed.contractId}`, '', `检查脚本与标准保持不变：${passed.standardId}`, '',
    `[失败报告](.proofloop/acceptance/keyword-filter/${failed.runId}/report.md) · [返工任务](.proofloop/acceptance/keyword-filter/${failed.runId}/repair-prompt.md) · [通过报告](.proofloop/acceptance/keyword-filter/${passed.runId}/report.md)`, '',
    '本目录每次新建，不改发布示例、不覆盖旧日志。', '',
  ].join('\n'), { flag: 'wx' });
  console.log(`2. 预设修复：${passed.status}；契约和验收标准未变，代码标识已变化。`);
  console.log(`通过报告：${join(passed.recordDir, 'report.md')}`);
  console.log(`演示记录：${join(directory, 'demo.json')}`);
}

try { await demo(); }
catch (error) { console.error(`演示未完成：${error.message}`); process.exitCode = 2; }
