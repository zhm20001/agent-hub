import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogReader } from '../src/runner/log-stream.ts';

test('log reader bounds reads, preserves UTF-8 and exposes a reconnect cursor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-log-')); const path = join(dir, 'raw.log');
  try {
    const emoji = Buffer.from('😀'); writeFileSync(path, Buffer.concat([Buffer.from('head'), emoji.subarray(0,2)]));
    const reader = new LogReader(path);
    assert.deepEqual(reader.read(), { text:'head', offset:4, reset:false, caughtUp:true });
    appendFileSync(path, emoji.subarray(2));
    assert.equal(reader.read().text, '😀');
    assert.equal(new LogReader(path,4).read().text,'😀');
    appendFileSync(path, 'x'.repeat(150000));
    let text = ''; let part;
    do { part=reader.read(true); text+=part.text; } while(!part.caughtUp);
    assert.equal(text.length,150000);
    assert.equal(part.offset,150008);
    writeFileSync(path,'new');
    assert.deepEqual(reader.read(),{text:'new',offset:3,reset:true,caughtUp:true});
    renameSync(path,join(dir,'old')); writeFileSync(path,'rotated');
    assert.equal(reader.read().reset,true);
    assert.equal(new LogReader(path,9999).read().text,'rotated');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
