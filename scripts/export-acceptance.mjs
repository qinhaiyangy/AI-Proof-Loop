import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, realpath, lstat } from 'node:fs/promises';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Repository-specific export of the synthetic keyword-filter evidence only.
// This is NOT a general-purpose secret scanner or automatic anonymization tool.
const repo = fileURLToPath(new URL('../', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const pretty = value => JSON.stringify(value, null, 2) + '\n';
const snapshotPaths = ['contract.json', 'project/checks/filter.check.mjs', 'project/src/filter.mjs'];
const checkIds = ['case-insensitive', 'empty-query', 'no-match'];
const fail = message => { throw new Error(`EXPORT_REFUSED: ${message}`); };
const same = (actual, expected, message) => assert.deepEqual(actual, expected, message);
const identity = entries => digest(JSON.stringify(entries.map(({ path, role, sha256, size }) => ({ path, role, sha256, size }))));
const noPrivatePaths = (bytes, context = 'generated artifact') => {
  const text = bytes.toString('utf8');
  if (/(?:^|[\s"'(])[A-Za-z]:[\\/]|file:\/\/\//i.test(text)) fail(`an absolute Windows or file URL path remains in ${context}; manual review required`);
};

async function readRegular(directory, filename) {
  const target = join(directory, filename);
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) fail('expected a regular evidence file');
  return readFile(target);
}

async function loadRecord(directory, expectedStatus) {
  const actual = await realpath(resolve(directory));
  const localRoot = await realpath(join(repo, 'examples', 'keyword-filter', '.proofloop', 'acceptance', 'keyword-filter'));
  const location = relative(localRoot, actual);
  if (isAbsolute(location) || !/^[a-f0-9-]{36}$/.test(location)) fail('input must be a local keyword-filter record');
  const files = new Map();
  const take = async filename => {
    const bytes = await readRegular(actual, filename);
    files.set(filename, bytes);
    return bytes;
  };
  const report = JSON.parse((await take('report.json')).toString('utf8'));
  same(report.taskId, 'keyword-filter', 'synthetic task only');
  same(report.status, expectedStatus, 'unexpected run status');
  same(report.attemptVerdict, expectedStatus);
  same(report.runOutcome, expectedStatus);
  same(report.stable, true, 'unstable evidence cannot be exported as this demonstration');
  same(resolve(report.recordDir), actual, 'record location mismatch');
  same(report.runId, location, 'record ID mismatch');
  same(report.contract.sourceFiles, ['src/filter.mjs']);
  same(report.contract.allowedChanges, ['src/filter.mjs']);
  same(report.checks.map(check => check.id), checkIds);
  const contract = await take('contract.json');
  same(digest(contract), report.contractId, 'original contract hash mismatch');
  same(JSON.parse(contract.toString('utf8')), report.contract, 'reported contract differs');
  for (const phase of ['before', 'after']) {
    const snapshot = report[phase];
    same(snapshot.entries.map(entry => entry.path), snapshotPaths, 'unexpected snapshot scope');
    for (const entry of snapshot.entries) {
      const bytes = await take(`snapshots/${phase}/${entry.path}`);
      same(digest(bytes), entry.sha256, 'original snapshot hash mismatch');
      same(bytes.length, entry.size, 'original snapshot size mismatch');
    }
    same(identity(snapshot.entries), snapshot.id, 'snapshot identity mismatch');
    same(identity(snapshot.entries.filter(entry => entry.role === 'source')), snapshot.codeId, 'source identity mismatch');
  }
  same(report.before.id, report.after.id, 'source changed during run');
  same(report.codeId, report.before.codeId);
  same(digest(JSON.stringify({ contractId: report.contractId, scripts: report.before.entries.filter(entry => entry.role === 'check').map(({ path, sha256 }) => ({ path, sha256 })) })), report.standardId);
  same(digest(JSON.stringify(report.runtime.files)), report.runtime.toolId, 'tool manifest identity mismatch');
  for (const check of report.checks) {
    const contractCheck = report.contract.checks.find(item => item.id === check.id);
    same(contractCheck.files, ['checks/filter.check.mjs']);
    same(check.args, ['checks/filter.check.mjs', check.id]);
    same(check.status, expectedStatus === 'FAILED' && check.id === 'case-insensitive' ? 'FAILED' : 'PASSED');
    same(check.exitCode, check.status === 'FAILED' ? 1 : 0);
    for (const stream of ['stdout', 'stderr']) {
      const filename = `checks/${check.id}.${stream}.log`;
      same(check.logs[stream].path, filename);
      const bytes = await take(filename);
      same(digest(bytes), check.logs[stream].sha256, 'original log hash mismatch');
      same(bytes.toString('utf8'), check[stream], 'reported output differs from original log');
    }
  }
  await take('report.md');
  if (expectedStatus === 'FAILED') await take('repair-prompt.md');
  return { report, files };
}

function sanitizer(report) {
  const replacements = [];
  for (const [path, label] of [[report.recordDir, '<RUN_RECORD>'], [report.projectDir, '<EXAMPLE_PROJECT>'], [resolve(repo), '<PROOFLOOP_REPO>'], [report.runtime.executable, '<NODE_EXECUTABLE>']]) {
    for (const variant of new Set([path, path.replaceAll('\\', '/'), JSON.stringify(path).slice(1, -1), pathToFileURL(path).href, decodeURI(pathToFileURL(path).href)])) {
      replacements.push([variant, label]);
    }
  }
  replacements.sort((a, b) => b[0].length - a[0].length);
  const sanitizeText = value => {
    for (const [original, label] of replacements) value = value.split(original).join(label);
    return value;
  };
  const sanitizeValue = value => typeof value === 'string' ? sanitizeText(value)
    : Array.isArray(value) ? value.map(sanitizeValue)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeValue(item)])) : value;
  return { sanitizeText, sanitizeValue };
}

function publicRecord(record, label) {
  const { report, files } = record;
  const { sanitizeText, sanitizeValue } = sanitizer(report);
  const derived = new Map();
  const publicReport = sanitizeValue(report);
  publicReport.export = {
    kind: 'path-redacted-derived-copy',
    originalReportSha256: digest(files.get('report.json')),
    note: 'Public copies are derived evidence. Local absolute paths were replaced. Original local records were not modified. Log sha256 refers to the exported bytes; originalSha256 identifies the local bytes.',
  };
  for (const [filename, original] of files) {
    if (filename === 'report.json') continue;
    let exported = Buffer.from(sanitizeText(original.toString('utf8')));
    if (filename === 'contract.json' || filename.startsWith('snapshots/')) {
      if (!original.equals(exported)) fail('snapshot or contract would require redaction; preserve original content identity instead');
      exported = original;
    }
    if (filename.endsWith('.md')) {
      exported = Buffer.from('> 公开派生副本：已替换本机绝对路径；原始本地证据未修改。日志字节如有脱敏变化，原始与导出 SHA-256 见 manifest.json 及 report.json。\n\n' + exported.toString('utf8'));
    }
    noPrivatePaths(exported, filename);
    derived.set(filename, { bytes: exported, originalSha256: digest(original) });
  }
  for (const check of publicReport.checks) {
    for (const stream of ['stdout', 'stderr']) {
      const entry = derived.get(check.logs[stream].path);
      check.logs[stream] = { ...check.logs[stream], originalSha256: entry.originalSha256, exportedSha256: digest(entry.bytes), sha256: digest(entry.bytes) };
      check[stream] = entry.bytes.toString('utf8');
    }
  }
  const json = Buffer.from(pretty(publicReport));
  noPrivatePaths(json, 'report.json');
  derived.set('report.json', { bytes: json, originalSha256: digest(files.get('report.json')) });
  return [...derived].map(([path, item]) => ({ path: `${label}/${path}`, ...item }));
}

function fullReplacementDiff(before, after) {
  const lines = value => value.toString('utf8').replaceAll('\r\n', '\n').replace(/\n$/, '').split('\n');
  const oldLines = lines(before), newLines = lines(after);
  return ['--- failed/snapshots/before/project/src/filter.mjs', '+++ passed/snapshots/before/project/src/filter.mjs', `@@ -1,${oldLines.length} +1,${newLines.length} @@`, ...oldLines.map(line => `-${line}`), ...newLines.map(line => `+${line}`), ''].join('\n');
}

async function main() {
  const [failedDirectory, passedDirectory, destination, ...extra] = process.argv.slice(2);
  if (!failedDirectory || !passedDirectory || !destination || extra.length) fail('usage: node scripts/export-acceptance.mjs <failedDir> <passedDir> <newDestination>');
  const target = resolve(destination);
  const targetParent = dirname(target);
  if (targetParent !== resolve(repo, 'docs', 'evidence') || await realpath(join(repo, 'docs')) !== resolve(repo, 'docs')) fail('destination must be a new direct child of this repository docs/evidence directory');
  try { await lstat(target); fail('destination already exists; no files overwritten'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const failed = await loadRecord(failedDirectory, 'FAILED');
  const passed = await loadRecord(passedDirectory, 'PASSED');
  for (const field of ['taskId', 'contractId', 'contractVersion', 'standardId']) same(passed.report[field], failed.report[field], `changed ${field}`);
  same(passed.report.runtime.toolId, failed.report.runtime.toolId, 'different tool versions');
  same(passed.report.previousRecordId, failed.report.runId, 'history linkage mismatch');
  assert.notEqual(passed.report.codeId, failed.report.codeId, 'source must have changed');
  const sourceName = 'snapshots/before/project/src/filter.mjs';
  const artifacts = [...publicRecord(failed, 'failed'), ...publicRecord(passed, 'passed')];
  artifacts.push({ path: 'source.diff', bytes: Buffer.from(fullReplacementDiff(failed.files.get(sourceName), passed.files.get(sourceName))), originalSha256: null });
  const summary = [
    '# ProofLoop v0.1：真实人工返工验收证据', '',
    '这是本仓库合成关键词筛选任务的真实检查记录。先固定验收脚本，ProofLoop 实际启动进程得到失败；随后 Codex 修改 src/filter.mjs，再由 ProofLoop 真实复验通过。没有调用额外模型 API，不是 ProofLoop 自主修复。', '',
    '| 记录 | 结论 | 开始时间（UTC） | 代码标识 |', '|---|---|---|---|',
    `| [失败报告](failed/report.md) | ${failed.report.status} | ${failed.report.startedAt} | ${failed.report.codeId} |`,
    `| [通过报告](passed/report.md) | ${passed.report.status} | ${passed.report.startedAt} | ${passed.report.codeId} |`, '',
    `同一任务：${failed.report.taskId}；契约版本：${failed.report.contractVersion}。`, '',
    `契约 SHA-256：${failed.report.contractId}`, '',
    `验收标准标识（包含验收脚本）：${failed.report.standardId}`, '',
    `两次相同的工具代码标识：${failed.report.runtime.toolId}`, '',
    `失败 Run：${failed.report.runId}；通过 Run：${passed.report.runId}；后者 previousRecordId 指向前者。`, '',
    '## 实际结果', '',
    '失败时 case-insensitive 检查退出码为 1，实际得到 []，固定期望为 ["Alpha", "alphabet"]；empty-query 与 no-match 均退出 0。修改后上述三个检查均退出 0。', '',
    '两次契约与验收脚本内容未改变，源码内容改变。[source.diff](source.diff) 从两次保存的源码直接生成完整替换差异；[返工任务](failed/repair-prompt.md) 保留原目标、条件及修改范围。', '',
    '## 导出与可信边界', '',
    '这些是公开用的派生脱敏副本，不是逐字节原始日志。本机路径被替换为 <RUN_RECORD>、<EXAMPLE_PROJECT>、<PROOFLOOP_REPO>、<NODE_EXECUTABLE>；修复任务中的占位路径需替换为自己的实际路径后才能执行。源码、验收脚本及契约快照保持原始字节。原本机记录未修改。', '',
    '导出前重新验证了原始日志 SHA-256、报告内日志内容、检查前后快照内容及代码/契约/标准/工具标识关系。manifest.json 列出所有公开 artifact 的 exportedSha256 及对应原文件 originalSha256；生成的摘要和差异没有单一原文件，因此原始哈希为空。manifest 本身不自包含哈希。report.json 的日志 sha256 指向公开日志字节，同时保留 originalSha256。', '',
    '导出脚本仅适用于本仓库合成 keyword-filter 示例，不是通用自动脱敏或安全审计产品。公开前仍需检查敏感信息。哈希只识别内容版本，不是防篡改、可信执行或数学正确性证明。', '',
    '本记录只验证固定的三个条件，不是模型任务成功率或大型 benchmark，也不代表未列入快照的环境和依赖已经验证。两次独立 Run/Attempt 保留历史，不等于断点恢复。', '',
    '从仓库根目录运行 node scripts/demo-acceptance.mjs 可以重新体验固定错误/正确实现的确定性流程演示；它会生成新的记录，不会冒充这里的人工修改历史。', '',
  ].join('\n');
  artifacts.push({ path: 'README.md', bytes: Buffer.from(summary), originalSha256: null });
  for (const artifact of artifacts) noPrivatePaths(artifact.bytes);
  const manifest = { schemaVersion: 1, kind: 'keyword-filter-public-derived-evidence', exportedAt: new Date().toISOString(), originalRecordsUntouched: true, sourceRunIds: [failed.report.runId, passed.report.runId], redaction: 'Local absolute paths only; repository-specific synthetic example; manual review still required.', artifacts: artifacts.map(({ path, bytes, originalSha256 }) => ({ path, originalSha256, exportedSha256: digest(bytes), bytes: bytes.length })) };
  try { await mkdir(targetParent); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (await realpath(targetParent) !== targetParent) fail('evidence parent must not be redirected');
  await mkdir(target);
  for (const artifact of artifacts) {
    const filename = join(target, artifact.path);
    await mkdir(dirname(filename), { recursive: true });
    await writeFile(filename, artifact.bytes, { flag: 'wx' });
  }
  await writeFile(join(target, 'manifest.json'), pretty(manifest), { flag: 'wx' });
  console.log(`Exported ${artifacts.length} artifacts plus manifest to ${relative(repo, target)}. Original records unchanged.`);
}

main().catch(error => {
  // Avoid echoing arbitrary source values or private absolute paths in failures.
  console.error(error.message.startsWith('EXPORT_REFUSED:') ? error.message : `EXPORT_REFUSED: ${error.code ?? error.name}; inspect the local inputs without publishing them.`);
  process.exitCode = 1;
});
