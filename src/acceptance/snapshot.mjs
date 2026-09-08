import { readFile, mkdir, writeFile, stat, realpath } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { digest } from './contract.mjs';

export async function snapshot(loaded, destination) {
  const entries = [];
  const inputs = [{ path: 'contract.json', absolute: loaded.contractPath, role: 'contract' },
    ...loaded.files.map(file => ({ path: `project/${file.replaceAll('\\', '/')}`, absolute: resolve(loaded.projectDir, file), role: loaded.protectedFiles.includes(file) ? 'check' : 'source' }))];
  for (const input of inputs.sort((a, b) => a.path.localeCompare(b.path, 'en'))) {
    if (await realpath(input.absolute) !== input.absolute) throw new Error(`SNAPSHOT_PATH_CHANGED: ${input.path}`);
    const content = await readFile(input.absolute);
    const info = await stat(input.absolute, { bigint: true });
    entries.push({ path: input.path, role: input.role, sha256: digest(content), size: content.length, mtimeNs: info.mtimeNs.toString(), ctimeNs: info.ctimeNs.toString() });
    if (destination) {
      const target = join(destination, input.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, { flag: 'wx' });
    }
  }
  const identity = list => digest(JSON.stringify(list.map(({ path, role, sha256, size }) => ({ path, role, sha256, size }))));
  return { id: identity(entries), codeId: identity(entries.filter(entry => entry.role === 'source')), entries };
}
