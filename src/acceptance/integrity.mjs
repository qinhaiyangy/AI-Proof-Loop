import { watch } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Best-effort observation plus content/metadata snapshots; not trusted execution.
export function watchInputs(loaded) {
  const key = path => process.platform === 'win32' ? path.toLowerCase() : path;
  const inputs = [loaded.contractPath, ...loaded.files.map(file => resolve(loaded.projectDir, file))];
  const files = new Set(inputs.map(key));
  const changes = new Set();
  const watchers = [];
  for (const directory of new Set(inputs.map(dirname))) {
    try {
      const watcher = watch(directory, (_event, filename) => {
        if (!filename) changes.add(`无法识别变动文件：${directory}`);
        else if (files.has(key(resolve(directory, filename.toString())))) changes.add(`观察到文件变动：${resolve(directory, filename.toString())}`);
      });
      watcher.on('error', error => changes.add(`文件监控不可用：${error.code ?? error.message}`));
      watchers.push(watcher);
    } catch (error) { changes.add(`文件监控无法启动：${error.code ?? error.message}`); }
  }
  return { changes, close() { for (const watcher of watchers) watcher.close(); } };
}
