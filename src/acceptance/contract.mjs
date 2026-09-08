import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value);
function normalizeFile(value) {
  requireConfig(typeof value === 'string' && value.length > 0 && !isAbsolute(value) && !/[<>:"|?*\x00]/.test(value), 'file paths must be relative regular file names');
  const segments = value.replaceAll('\\', '/').split('/');
  requireConfig(segments.every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), 'file paths must be canonical, without traversal or Windows reserved aliases');
  return segments.join('/');
}
export function requireConfig(condition, message) {
  if (!condition) throw new Error(`INVALID_CONTRACT: ${message}`);
}
export function within(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
export async function loadContract(filename) {
  const contractPath = await realpath(resolve(filename));
  const raw = await readFile(contractPath);
  let contract;
  try { contract = JSON.parse(raw.toString('utf8')); }
  catch { throw new Error('INVALID_CONTRACT: expected a JSON object'); }
  requireConfig(contract && !Array.isArray(contract) && typeof contract === 'object', 'expected an object');
  requireConfig(contract.schemaVersion === 1, 'schemaVersion must be 1');
  requireConfig(safeId(contract.taskId), 'invalid taskId');
  requireConfig(Number.isSafeInteger(contract.version) && contract.version >= 1, 'version must be a positive integer');
  requireConfig(typeof contract.goal === 'string' && contract.goal.trim(), 'goal is required');
  requireConfig(typeof contract.projectDir === 'string' && contract.projectDir, 'projectDir is required');
  const projectDir = await realpath(resolve(dirname(contractPath), contract.projectDir));
  requireConfig((await stat(projectDir)).isDirectory(), 'projectDir must be a directory');
  requireConfig(Array.isArray(contract.sourceFiles) && contract.sourceFiles.length > 0, 'sourceFiles cannot be empty');
  requireConfig(Array.isArray(contract.allowedChanges), 'allowedChanges must be an array');
  contract.sourceFiles = contract.sourceFiles.map(normalizeFile);
  contract.allowedChanges = contract.allowedChanges.map(normalizeFile);
  requireConfig(contract.allowedChanges.every(file => contract.sourceFiles.includes(file)), 'allowedChanges must be sourceFiles');
  requireConfig(Array.isArray(contract.checks) && contract.checks.length > 0, 'checks cannot be empty');
  requireConfig(Array.isArray(contract.requirements) && contract.requirements.length > 0, 'requirements cannot be empty');
  requireConfig(contract.requirements.every(r => r && typeof r === 'object' && !Array.isArray(r)), 'requirements must contain objects');
  requireConfig(contract.requirements.some(r => r.required === true), 'at least one requirement must be required');
  const identifiers = new Set();
  for (const check of contract.checks) {
    requireConfig(check && safeId(check.id) && !identifiers.has(check.id), 'check IDs must be unique safe names');
    identifiers.add(check.id);
    requireConfig(typeof check.executable === 'string' && check.executable.trim(), 'executable is required');
    requireConfig(Array.isArray(check.args) && check.args.every(arg => typeof arg === 'string'), 'args must be a string array');
    requireConfig(typeof check.cwd === 'string', 'cwd is required');
    requireConfig(Number.isSafeInteger(check.timeoutMs) && check.timeoutMs >= 1 && check.timeoutMs <= 300000, 'timeoutMs must be 1..300000');
    requireConfig(Array.isArray(check.passExitCodes) && check.passExitCodes.length > 0 && check.passExitCodes.every(code => Number.isInteger(code) && code >= 0 && code <= 255), 'passExitCodes must contain exit codes');
    requireConfig(Array.isArray(check.files), 'check.files must explicitly list check scripts (or [] for inline commands)');
    check.files = check.files.map(normalizeFile);
    check.resolvedCwd = await realpath(resolve(projectDir, check.cwd));
    requireConfig(within(projectDir, check.resolvedCwd) && (await stat(check.resolvedCwd)).isDirectory(), 'check cwd must be a directory in projectDir');
    check.resolvedExecutable = check.executable === 'node' ? process.execPath : check.executable;
  }
  const requirementIds = new Set();
  for (const requirement of contract.requirements) {
    requireConfig(requirement && safeId(requirement.id) && !requirementIds.has(requirement.id), 'requirement IDs must be unique safe names');
    requirementIds.add(requirement.id);
    requireConfig(typeof requirement.description === 'string' && requirement.description.trim(), 'requirement description is required');
    requireConfig(typeof requirement.required === 'boolean', 'requirement.required must be boolean');
    requireConfig(Array.isArray(requirement.checkIds) && requirement.checkIds.every(id => identifiers.has(id)), 'requirement.checkIds refers to an unknown check');
  }
  const original = JSON.parse(raw.toString('utf8'));
  const protectedFiles = [...new Set(contract.checks.flatMap(check => check.files))];
  const pathKey = file => process.platform === 'win32' ? file.toLowerCase() : file;
  requireConfig(!protectedFiles.some(file => contract.allowedChanges.map(pathKey).includes(pathKey(file))), 'check scripts cannot be allowedChanges');
  const files = [...new Set([...contract.sourceFiles, ...protectedFiles])];
  requireConfig(new Set(files.map(pathKey)).size === files.length, 'file list contains duplicate path aliases');
  for (const file of files) {
    requireConfig(typeof file === 'string' && file && !isAbsolute(file), 'file lists must contain project-relative files');
    const resolved = resolve(projectDir, file);
    requireConfig(within(projectDir, resolved) && !(relative(projectDir, resolved).split(sep).includes('.proofloop')), 'snapshot files must stay inside the project and outside .proofloop');
    requireConfig(await realpath(resolved) === resolved && (await stat(resolved)).isFile(), 'snapshot files must be regular files without symlinks');
  }
  const manifestPaths = new Set(files.map(file => pathKey(resolve(projectDir, file))));
  for (const check of contract.checks) {
    const directFiles = [];
    for (const arg of check.args) {
      if (!arg || arg.startsWith('-') || arg.includes('\0')) continue;
      const candidate = resolve(check.resolvedCwd, arg);
      let info;
      try { info = await stat(candidate); } catch { continue; }
      if (info.isFile() && within(projectDir, candidate)) {
        requireConfig(manifestPaths.has(pathKey(candidate)), `command input file not listed in sourceFiles or check.files: ${arg}`);
        directFiles.push(candidate);
      }
    }
    if (check.executable === 'node' && check.args[0] && !check.args[0].startsWith('-')) {
      const entry = resolve(check.resolvedCwd, check.args[0]);
      requireConfig(check.files.some(file => pathKey(resolve(projectDir, file)) === pathKey(entry)), 'Node entry check script must be listed in check.files');
    }
    if (check.executable === 'node' && check.args.includes('--test')) {
      requireConfig(directFiles.length > 0 && directFiles.every(entry => check.files.some(file => pathKey(resolve(projectDir, file)) === pathKey(entry))), 'node --test requires explicit test scripts listed in check.files, not modifiable sourceFiles');
    }
  }
  return { contract, original, raw, contractPath, projectDir, files, protectedFiles, contractId: digest(raw) };
}
