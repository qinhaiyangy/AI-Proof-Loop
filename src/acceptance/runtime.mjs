import { readFile, readdir } from 'node:fs/promises';
import { digest } from './contract.mjs';

export async function runtimeIdentity() {
  const directory = new URL('./', import.meta.url);
  const files = [];
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.mjs')).sort()) {
    files.push({ path: name, sha256: digest(await readFile(new URL(name, directory))) });
  }
  return { version: '0.1.0', node: process.version, platform: process.platform, arch: process.arch, executable: process.execPath, toolId: digest(JSON.stringify(files)), files };
}
