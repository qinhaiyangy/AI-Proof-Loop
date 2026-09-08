import { mkdir, writeFile, readFile, readdir, open, unlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadContract, digest } from './contract.mjs';
import { snapshot } from './snapshot.mjs';
import { runCheck } from './process-runner.mjs';
import { reportMarkdown, repairMarkdown } from './report.mjs';
import { watchInputs } from './integrity.mjs';
import { runtimeIdentity } from './runtime.mjs';

export async function verify(contractPath, { signal, approveContractChange = false } = {}) {
  const loaded = await loadContract(contractPath);
  const runtime = await runtimeIdentity();
  const monitor = watchInputs(loaded);
  let lock;
  let lockPath;
  let lockToken;
  try {
  const startedAt = new Date().toISOString();
  const recordId = randomUUID();
  const taskDir = join(loaded.projectDir, '.proofloop', 'acceptance', loaded.contract.taskId);
  for (const directory of [join(loaded.projectDir, '.proofloop'), join(loaded.projectDir, '.proofloop', 'acceptance'), taskDir]) {
    await mkdir(directory, { recursive: true });
    if (await realpath(directory) !== directory) throw new Error('EVIDENCE_PATH_ALIAS: output directories must not redirect through symlinks');
  }
  lockPath = join(taskDir, 'active.lock');
  lockToken = JSON.stringify({ runId: recordId, pid: process.pid, startedAt });
  try { lock = await open(lockPath, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`TASK_BUSY: ${lockPath}; another verification or an interrupted run owns the lock. Do not remove it until you confirm its process has stopped.`);
    throw error;
  }
  await lock.writeFile(lockToken);
  const history = [];
  for (const directory of await readdir(taskDir, { withFileTypes: true })) {
    if (!directory.isDirectory() || !/^[a-f0-9-]{36}$/.test(directory.name)) continue;
    try { history.push(JSON.parse(await readFile(join(taskDir, directory.name, 'report.json'), 'utf8'))); }
    catch { throw new Error(`INCOMPLETE_HISTORY: inspect ${directory.name}; no previous result was reused`); }
  }
  history.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const previous = history.at(-1);
  const initial = await snapshot(loaded);
  const standardId = digest(JSON.stringify({ contractId: loaded.contractId, scripts: initial.entries.filter(entry => entry.role === 'check').map(({ path, sha256 }) => ({ path, sha256 })) }));
  if (initial.entries.find(entry => entry.role === 'contract').sha256 !== loaded.contractId) throw new Error('CONTRACT_CHANGED_BEFORE_CHECK: reload and verify again');
  const latestVersion = Math.max(0, ...history.map(record => record.contractVersion));
  const sameVersion = history.filter(record => record.contractVersion === loaded.contract.version);
  if (loaded.contract.version < latestVersion) throw new Error('SUPERSEDED_CONTRACT: cannot silently return to an older standard');
  if (sameVersion.some(record => record.standardId !== standardId)) throw new Error('CONTRACT_VERSION_REUSED: changed contract or check script; obtain user approval and increase version');
  if (previous && loaded.contract.version > latestVersion && !approveContractChange) throw new Error('CONTRACT_CHANGE_REQUIRES_APPROVAL: user must confirm the new version, then use --approve-contract-change');
  const recordDir = join(taskDir, recordId);
  await mkdir(join(recordDir, 'checks'), { recursive: true });
  const before = await snapshot(loaded, join(recordDir, 'snapshots', 'before'));
  const checks = [];
  let cleanupUnconfirmed = false;
  for (const check of loaded.contract.checks) {
    const result = await runCheck({ ...check, executable: check.resolvedExecutable, cwd: check.resolvedCwd }, { signal: cleanupUnconfirmed ? AbortSignal.abort() : signal });
    if (cleanupUnconfirmed) result.reason = '未执行：前一检查的进程清理未完全确认，请人工检查后再重新验收。';
    if (result.cleanup.attempted && !result.cleanup.confirmed) cleanupUnconfirmed = true;
    const stdoutBytes = result.stdoutBytes ?? Buffer.from(result.stdout);
    const stderrBytes = result.stderrBytes ?? Buffer.from(result.stderr);
    await writeFile(join(recordDir, 'checks', `${check.id}.stdout.log`), stdoutBytes, { flag: 'wx' });
    await writeFile(join(recordDir, 'checks', `${check.id}.stderr.log`), stderrBytes, { flag: 'wx' });
    result.logs = { stdout: { path: `checks/${check.id}.stdout.log`, sha256: digest(stdoutBytes) }, stderr: { path: `checks/${check.id}.stderr.log`, sha256: digest(stderrBytes) } };
    delete result.stdoutBytes;
    delete result.stderrBytes;
    checks.push(result);
  }
  let after = null;
  const evidenceProblems = [];
  try { after = await snapshot(loaded, join(recordDir, 'snapshots', 'after')); }
  catch (error) { evidenceProblems.push(`检查后快照不可用：${error.code ?? error.message}`); }
  for (const check of checks) {
    for (const log of Object.values(check.logs)) {
      try {
        if (digest(await readFile(join(recordDir, log.path))) !== log.sha256) throw new Error('CONTENT_CHANGED');
      } catch (error) {
        check.status = 'INCONCLUSIVE';
        check.reason = `原始证据缺失或变化：${log.path} (${error.code ?? error.message})`;
        evidenceProblems.push(check.reason);
      }
    }
  }
  for (const [phase, value] of [['before', before], ['after', after]]) {
    if (!value) continue;
    for (const entry of value.entries) {
      try {
        if (digest(await readFile(join(recordDir, 'snapshots', phase, entry.path))) !== entry.sha256) throw new Error('CONTENT_CHANGED');
      } catch (error) { evidenceProblems.push(`快照证据缺失或变化：snapshots/${phase}/${entry.path} (${error.code ?? error.message})`); }
    }
  }
  await new Promise(resolve => setImmediate(resolve));
  if ((await runtimeIdentity()).toolId !== runtime.toolId) evidenceProblems.push('ProofLoop运行层文件在检查过程中变化，请重新验证。');
  if (signal?.aborted) evidenceProblems.push('运行被中断：必须重新验收，不能沿用中断期间的检查结论。');
  const requirements = loaded.contract.requirements.map(requirement => {
    const outcomes = checks.filter(check => requirement.checkIds.includes(check.id));
    const status = !outcomes.length || outcomes.some(check => check.status === 'INCONCLUSIVE') ? 'INCONCLUSIVE' : outcomes.some(check => check.status === 'FAILED') ? 'FAILED' : 'PASSED';
    return { ...requirement, status };
  });
  const unstable = !after || monitor.changes.size > 0 || JSON.stringify(initial.entries) !== JSON.stringify(before.entries) || JSON.stringify(before.entries) !== JSON.stringify(after.entries);
  if (unstable || evidenceProblems.length > 0) {
    for (const requirement of requirements) {
      requirement.observedCheckStatus = requirement.status;
      requirement.status = 'INCONCLUSIVE';
      requirement.reason = '当前代码版本或落盘证据完整性无法确认。';
    }
  }
  const mandatory = [...checks, ...requirements.filter(requirement => requirement.required)];
  const status = unstable || evidenceProblems.length > 0 || mandatory.some(item => item.status === 'INCONCLUSIVE') ? 'INCONCLUSIVE' : mandatory.some(item => item.status === 'FAILED') ? 'FAILED' : 'PASSED';
  const report = { schemaVersion: 1, taskId: loaded.contract.taskId, runId: recordId, attemptId: randomUUID(), recordDir, projectDir: loaded.projectDir, startedAt, finishedAt: new Date().toISOString(), previousRecordId: previous?.runId ?? null, contractId: loaded.contractId, contractVersion: loaded.contract.version, standardId, codeId: before.codeId, contract: loaded.original, before, after, checks, requirements, status, attemptVerdict: status, runOutcome: status, stable: !unstable, unverified: [...evidenceProblems, ...monitor.changes, ...requirements.filter(r => !r.checkIds.length).map(r => `${r.id} 尚需人工验收`), ...(unstable ? ['检查期间快照文件发生变化或无法确认稳定，必须重新验证。'] : [])] };
  await writeFile(join(recordDir, 'contract.json'), loaded.raw, { flag: 'wx' });
  report.runtime = runtime;
  await writeFile(join(recordDir, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  await writeFile(join(recordDir, 'report.md'), reportMarkdown(report), { flag: 'wx' });
  if (status !== 'PASSED') await writeFile(join(recordDir, 'repair-prompt.md'), repairMarkdown(report, loaded.contractPath), { flag: 'wx' });
  await readFile(join(recordDir, 'report.json'));
  return report;
  } finally {
    monitor.close();
    if (lock) {
      await lock.close();
      if (await readFile(lockPath, 'utf8') === lockToken) await unlink(lockPath);
    }
  }
}
