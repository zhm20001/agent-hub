import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const cli = fileURLToPath(new URL('../scripts/verify.mjs', import.meta.url));
function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'hub-verify-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, run(manifest: any) {
    writeFileSync(join(root, 'verify.json'), JSON.stringify(manifest));
    const result = spawnSync(process.execPath, [cli, join(root, 'verify.json'), join(root, 'report')], { encoding: 'utf8' });
    assert.equal(existsSync(join(root, 'report/report.json')), true, result.stderr);
    return { result, report: JSON.parse(readFileSync(join(root, 'report/report.json'), 'utf8')) };
  } };
}
const check = (name: string, code: string, extra = {}) => ({ name, argv: [process.execPath, '-e', code], ...extra });

test('verification aggregates every command failure instead of returning the last command exit', t => {
  const { run, root } = fixture(t);
  const { result, report } = run({ version: 1, checks: [check('bad', 'console.log("inner failure");process.exit(7)'), check('good', 'console.log("later command ran")')] });
  assert.equal(result.status, 1); assert.deepEqual(report.checks.map((c: any) => c.status), ['failed', 'passed']);
  assert.equal(report.checks[0].exitCode, 7); assert.match(readFileSync(join(root, 'report', report.checks[0].log), 'utf8'), /inner failure/);
});
test('required platform gates stay not-run and prevent an all-passing result', t => {
  const { run } = fixture(t);
  const { result, report } = run({ version: 1, checks: [check('elsewhere', 'throw Error("must not run")', { platforms: ['not-this-platform'] })] });
  assert.equal(result.status, 1); assert.equal(report.checks[0].status, 'not-run'); assert.match(report.checks[0].reason, /platform/);
});
test('source drift and newly discovered independent workspaces invalidate the matrix', t => {
  const { root, run } = fixture(t); writeFileSync(join(root, 'package.json'), '{}');
  mkdirSync(join(root, 'fuzz')); writeFileSync(join(root, 'fuzz/Cargo.toml'), '[workspace]\n');
  const hash = createHash('sha256').update('{}').digest('hex');
  const { result, report } = run({ version: 1, inventory: [{ path: 'package.json', sha256: hash }], checks: [check('old matrix', 'console.log("do not certify stale matrix")')] });
  assert.equal(result.status, 1); assert.equal(report.sources.status, 'changed'); assert.equal(report.checks[0].status, 'not-run');
  assert.ok(report.sources.issues.some((issue: string) => issue.includes('fuzz/Cargo.toml')));
});
test('command timeouts are failed checks and a later successful command does not hide them', t => {
  const { run } = fixture(t);
  const { result, report } = run({ version: 1, checks: [check('timeout', 'setTimeout(()=>{},10000)', { timeoutMs: 50 }), check('later', '')] });
  assert.equal(result.status, 1); assert.equal(report.checks[0].status, 'failed'); assert.equal(report.checks[0].timedOut, true); assert.equal(report.checks[1].status, 'passed');
});
test('reports are never overwritten and inventory discovery records workflow and nested manifests', t => {
  const { root, run } = fixture(t);
  const command = check('literal argv', 'console.log(process.argv[1])'); command.argv.push('$(touch unsafe)');
  const { result } = run({ version: 1, checks: [command] });
  assert.match(readFileSync(join(root, 'report/1.log'), 'utf8'), /\$\(touch unsafe\)/);
  assert.equal(existsSync(join(root, 'unsafe')), false);
  assert.equal(result.status, 0);
  const before = readFileSync(join(root, 'report/report.json'), 'utf8');
  assert.equal(spawnSync(process.execPath, [cli, join(root, 'verify.json'), join(root, 'report')]).status, 1);
  assert.equal(readFileSync(join(root, 'report/report.json'), 'utf8'), before);
  mkdirSync(join(root, '.github/workflows'), { recursive: true }); writeFileSync(join(root, '.github/workflows/ci.yml'), 'jobs: {}');
  const inventory = spawnSync(process.execPath, [cli, '--inventory', root], { encoding: 'utf8' });
  assert.equal(inventory.status, 0); assert.deepEqual(JSON.parse(inventory.stdout).map((s: any) => s.path), ['.github/workflows/ci.yml']);
});

test('source changes during a command invalidate the completed report', t => {
  const { root, run } = fixture(t); const source = join(root, 'ci.yml'); writeFileSync(source, 'before');
  const hash = createHash('sha256').update('before').digest('hex');
  const { result, report } = run({ version: 1, sources: [{ path: 'ci.yml', sha256: hash }], checks: [check('mutates source', `require('node:fs').writeFileSync(${JSON.stringify(source)},'after')`)] });
  assert.equal(report.checks[0].status, 'passed'); assert.equal(result.status, 1); assert.equal(report.sources.status, 'changed');
});


test('interrupting verification records the stopped check and leaves later checks unexecuted', async t => {
  const { root } = fixture(t);
  writeFileSync(join(root, 'verify.json'), JSON.stringify({ version: 1, checks: [check('wait', 'console.log("ready");setTimeout(()=>{},10000)'), check('later', '')] }));
  const child = spawn(process.execPath, [cli, join(root, 'verify.json'), join(root, 'report')], { stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  const done = new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve(code)); });
  const deadline = Date.now() + 3000;
  while (!existsSync(join(root, 'report/1.log')) || !readFileSync(join(root, 'report/1.log'), 'utf8').includes('ready')) {
    assert.ok(Date.now() < deadline, 'command started'); await new Promise(r => setTimeout(r, 10));
  }
  child.kill('SIGINT'); assert.equal(await done, 130);
  const report = JSON.parse(readFileSync(join(root, 'report/report.json'), 'utf8'));
  assert.equal(report.checks[0].interrupted, 'SIGINT'); assert.equal(report.checks[1].status, 'not-run');
});
