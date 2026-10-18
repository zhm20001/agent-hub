import { spawnSync } from 'node:child_process';
import { cpSync, rmSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
rmSync(new URL('../lib', import.meta.url), {recursive:true,force:true});
for (const [entry,args] of [
  ['../node_modules/vite/bin/vite.js',['build']],
  ['../node_modules/typescript/bin/tsc',['-p','tsconfig.build.json']],
]) {
  const result = spawnSync(process.execPath,[fileURLToPath(new URL(entry,import.meta.url)),...args],{cwd:root,stdio:'inherit'});
  if (result.status !== 0) process.exit(result.status ?? 1);
}
cpSync(new URL('../src/prompts',import.meta.url),new URL('../lib/prompts',import.meta.url),{recursive:true});
chmodSync(new URL('../lib/cli.js',import.meta.url),0o755);
