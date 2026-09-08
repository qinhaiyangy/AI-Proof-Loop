import { join, resolve } from 'node:path';
import { verify } from './verify.mjs';

const labels = { PASSED: '通过', FAILED: '未通过', INCONCLUSIVE: '无法判定' };
const usage = '用法：node src/acceptance/cli.mjs verify <contract.json> [--approve-contract-change]\n帮助：node src/acceptance/cli.mjs --help';

async function main(args) {
  if (args.length === 1 && ['help', '--help'].includes(args[0])) {
    console.log(`ProofLoop v0.1：AI 编程任务的本地验收与人工返工工具。\n${usage}\n退出码：0 通过，1 未通过，2 无法判定，3 参数/配置/存储拒绝。\n检查命令须由用户信任；这不是安全沙箱，不自动调用模型或自主修复。`);
    return 0;
  }
  if (args[0] !== 'verify' || !args[1] || args[1].startsWith('-') || args.length > 3
      || (args.length === 3 && args[2] !== '--approve-contract-change')) {
    console.error(`INVALID_ARGUMENTS：参数无效。\n${usage}`);
    return 3;
  }
  const controller = new AbortController();
  const interrupt = () => { controller.abort(); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    const report = await verify(args[1], { signal: controller.signal, approveContractChange: args[2] === '--approve-contract-change' });
    console.log(`ProofLoop v0.1 本地验收\n最终结论：${labels[report.status]} (${report.status})`);
    console.log(`代码标识：${report.codeId}\n契约标识：${report.contractId}`);
    for (const check of report.checks) {
      console.log(`${check.id}：${labels[check.status]} (${check.status})；退出码：${check.exitCode ?? '无'}`);
      if (check.status !== 'PASSED') console.log(`  原因：${check.reason}`);
      if (check.cleanup?.attempted && !check.cleanup.confirmed) console.log(`  清理提醒：${check.cleanup.detail}`);
    }
    console.log('未验证事项：');
    for (const item of report.unverified) console.log(`- ${item}`);
    if (!report.unverified.length) console.log('- 当前记录没有额外未验证项；通过仅限约定检查，不代表程序绝对正确。');
    console.log(`报告：${join(report.recordDir, 'report.md')}`);
    console.log(`JSON：${join(report.recordDir, 'report.json')}`);
    if (report.status !== 'PASSED') console.log(`返工任务：${join(report.recordDir, 'repair-prompt.md')}`);
    return { PASSED: 0, FAILED: 1, INCONCLUSIVE: 2 }[report.status] ?? 2;
  } catch (error) {
    const reason = String(error.message ?? error).split(/\r?\n/)[0].slice(0, 1000);
    console.error(`验收未执行完成：${error.code ? `${error.code}: ` : ''}${reason}\n契约：${resolve(args[1])}\n不能据此宣布通过；请检查配置、权限和证据存储。`);
    return 3;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

process.exitCode = await main(process.argv.slice(2));
