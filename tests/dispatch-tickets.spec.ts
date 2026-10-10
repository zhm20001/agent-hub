/**
 * Unit tests for scripts/dispatch-tickets.mjs helpers.
 * Fixtures only — no live board / no ZCode tokens.
 *
 * Run with: node --import tsx --test tests/dispatch-tickets.spec.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  READY_SIGNAL,
  applyDefaults,
  isReadyTask,
  loadTicket,
  parseArgs,
  parseMattField,
  typeToken,
  toPayload,
} from '../scripts/dispatch-tickets.mjs';

const scratchDirs: string[] = [];

after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix = 'dispatch-tickets-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

describe('parseMattField / typeToken', () => {
  it('reads Type and Status from Matt body lines', () => {
    const body = `# 03: Wire login

Type: task
Status: ready-for-agent

**Blocked by:** None
`;
    assert.equal(parseMattField(body, 'Type'), 'task');
    assert.equal(parseMattField(body, 'Status'), READY_SIGNAL);
    assert.equal(typeToken('parking-lot（不是待办票）'), 'parking-lot');
    assert.equal(typeToken('task'), 'task');
  });

  it('reads bold Matt Status line', () => {
    assert.equal(
      parseMattField('**Status:** ready-for-agent\n', 'Status'),
      READY_SIGNAL,
    );
  });
});

describe('isReadyTask filter', () => {
  it('accepts Type: task + Status ready-for-agent from body', () => {
    const gate = isReadyTask({
      prompt: 'Type: task\nStatus: ready-for-agent\n\nDo the thing.\n',
    });
    assert.deepEqual(gate, { ok: true });
  });

  it('rejects grilling / parking-lot / missing type', () => {
    assert.equal(
      isReadyTask({ prompt: 'Type: grilling\nStatus: ready-for-agent\n' }).ok,
      false,
    );
    assert.equal(
      isReadyTask({ prompt: 'Type: parking-lot（x）\nStatus: ready-for-agent\n' }).ok,
      false,
    );
    assert.match(
      String(isReadyTask({ prompt: 'Status: ready-for-agent\n' }).reason),
      /missing-type/,
    );
  });

  it('rejects task that is not ready-for-agent', () => {
    const gate = isReadyTask({
      prompt: 'Type: task\nStatus: closed\n',
    });
    assert.equal(gate.ok, false);
    assert.equal(gate.reason, 'not-ready-for-agent');
  });

  it('accepts frontmatter type + status', () => {
    const gate = isReadyTask({
      prompt: 'Implement login.\n',
      meta: { type: 'task', status: 'ready-for-agent' },
    });
    assert.deepEqual(gate, { ok: true });
  });

  it('accepts frontmatter labels containing ready-for-agent', () => {
    const gate = isReadyTask({
      prompt: 'Type: task\nStatus: open\n',
      meta: { labels: ['ready-for-agent', 'p1'] },
    });
    assert.deepEqual(gate, { ok: true });
  });
});

describe('applyDefaults / parseArgs', () => {
  it('fills cwd and adapter only when ticket omitted them', () => {
    const t = applyDefaults(
      { prompt: 'x', source: 'a.md', cwd: '/ticket/cwd' },
      { cwd: '/default/cwd', adapter: 'bash' },
    );
    assert.equal(t.cwd, '/ticket/cwd');
    assert.equal(t.adapter, 'bash');
  });

  it('CLI --cwd/--adapter override env; ticket still wins in applyDefaults', () => {
    const parsed = parseArgs(
      ['./tickets', '--cwd', '/cli/cwd', '--adapter', 'bash'],
      {
        AGENT_HUB_DEFAULT_CWD: '/env/cwd',
        AGENT_HUB_DEFAULT_ADAPTER: 'zcode',
      },
    );
    assert.ok(!('error' in parsed));
    assert.equal(parsed.defaultCwd, '/cli/cwd');
    assert.equal(parsed.defaultAdapter, 'bash');

    const fromEnv = parseArgs(['./tickets'], {
      AGENT_HUB_DEFAULT_CWD: '/env/cwd',
      AGENT_HUB_DEFAULT_ADAPTER: 'zcode',
    });
    assert.equal(fromEnv.defaultCwd, '/env/cwd');
    assert.equal(fromEnv.defaultAdapter, 'zcode');
  });
});

describe('loadTicket + toPayload with defaults', () => {
  it('loads Matt md without frontmatter and applies directory defaults', () => {
    const dir = scratch();
    const path = join(dir, '03-wire-login.md');
    writeFileSync(
      path,
      `# 03: Wire login

Type: task
Status: ready-for-agent

**What to build:** login form works.

**Blocked by:** None (can start immediately)

- [ ] happy path
`,
      'utf8',
    );
    const t = loadTicket(path);
    assert.ok(t);
    assert.equal(t!.ticket, '03-wire-login');
    assert.deepEqual(isReadyTask(t!), { ok: true });
    applyDefaults(t!, { cwd: '/ws', adapter: 'bash' });
    const payload = toPayload(t!);
    assert.equal(payload.cwd, '/ws');
    assert.equal(payload.adapter, 'bash');
    assert.equal(payload.ticket, '03-wire-login');
    assert.match(String(payload.prompt), /Type: task/);
  });

  it('skips grilling ticket via isReadyTask after load', () => {
    const dir = scratch();
    const path = join(dir, '01-adapter-contract.md');
    writeFileSync(
      path,
      `# 01

Type: grilling
Status: ready-for-agent

## Question
why?
`,
      'utf8',
    );
    const t = loadTicket(path);
    assert.ok(t);
    const gate = isReadyTask(t!);
    assert.equal(gate.ok, false);
    assert.match(String(gate.reason), /not-task/);
  });
});
