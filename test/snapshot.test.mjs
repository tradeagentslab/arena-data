import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { discordText, lastWeek, snapshot, toCsv } from '../scripts/snapshot.mjs';

const NOW = Date.parse('2026-11-02T01:30:00Z'); // Monday after week 44
const board = {
  schema: 'arena.standings/v0', season: 'S1', period: { kind: 'week', id: '2026-W44' },
  rows: [
    { rank: 1, agentId: 'tal-grok', name: 'Grok', model: 'm', official: true, returnPct: 3.12, maxDrawdownPct: 2.41, score: 1.92, trades: 14, equityUsdt: '10312.00', status: 'active' },
    { rank: 2, agentId: 'x-bot', name: 'Bot, "X"', model: 'm', official: false, returnPct: -0.85, maxDrawdownPct: 1.9, score: -1.8, trades: 3, equityUsdt: '9915.00', status: 'active' },
  ],
};

function api(routes) {
  const posted = [];
  const f = async (url, init) => {
    if (init?.method === 'POST') { posted.push(JSON.parse(init.body)); return { ok: true, status: 204, json: async () => ({}) }; }
    const path = url.replace('https://arena.test', '');
    if (path in routes) return { ok: true, status: 200, json: async () => routes[path] };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  f.posted = posted;
  return f;
}

test('last week is the ISO week that just ended', () => {
  assert.equal(lastWeek(NOW).id, '2026-W44');
  assert.equal(new Date(lastWeek(NOW).from).toISOString(), '2026-10-26T00:00:00.000Z');
  assert.equal(lastWeek(Date.parse('2027-01-04T02:00:00Z')).id, '2026-W53');
});

test('copies board, csv, agents and ledgers; posts to Discord once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arena-data-'));
  const f = api({
    '/agents.json': { agents: [{ agentId: 'tal-grok' }] },
    '/weekly/2026-W44.json': board,
    '/ledger/tal-grok/2026-10-29.json': { agent: 'tal-grok', day: '2026-10-29', orders: [{ recv: 'x', line: '{}' }], results: ['{}'] },
  });
  const r = await snapshot({ api: 'https://arena.test', root, now: NOW, fetchImpl: f, webhook: 'https://discord.test/hook', site: 'https://site.test', log: () => {} });
  assert.ok(existsSync(join(root, 'weekly/2026-W44.json')));
  assert.match(readFileSync(join(root, 'weekly/2026-W44.csv'), 'utf8'), /"Bot, ""X"""/);
  assert.ok(existsSync(join(root, 'ledgers/tal-grok/2026-10-29.json')));
  assert.ok(!existsSync(join(root, 'ledgers/tal-grok/2026-10-30.json')), 'empty days are not written');
  assert.equal(r.posted, true);
  assert.match(f.posted[0].content, /1\. Grok \(House\): \+3\.12%/);
  assert.deepEqual(f.posted[0].allowed_mentions, { parse: [] });
  const again = await snapshot({ api: 'https://arena.test', root, now: NOW, fetchImpl: f, webhook: 'https://discord.test/hook', site: 'https://site.test', log: () => {} });
  assert.deepEqual(again.changed, []);
  assert.equal(f.posted.length, 1, 'no second post for the same week');
});

test('before the arena opens: nothing to copy, no post', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arena-data-'));
  const f = api({});
  const r = await snapshot({ api: 'https://arena.test', root, now: NOW, fetchImpl: f, webhook: 'https://discord.test/hook', site: 'https://site.test', log: () => {} });
  assert.deepEqual(r.changed, []);
  assert.equal(r.posted, false);
});

test('the Discord text says simulated and not advice', () => {
  const t = discordText(board, 'https://site.test');
  assert.match(t, /paper trading/);
  assert.match(t, /Not investment advice/);
  assert.ok(!/signal|guarantee|copy/i.test(t));
  assert.equal(toCsv([]).split('\n')[0].split(',').length, 11);
});
