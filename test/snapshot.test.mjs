import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { discordText, lastWeek, snapshot, toCsv, weeksBetween } from '../scripts/snapshot.mjs';

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
    f.seen.push(url);
    if (init?.method === 'POST') { posted.push(JSON.parse(init.body)); return { ok: true, status: 204, json: async () => ({}) }; }
    const path = url.replace('https://arena.test', '');
    if (path in routes) return { ok: true, status: 200, json: async () => routes[path] };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  f.posted = posted;
  f.seen = [];
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
    '/ledger/tal-grok/2026-11-02.json': { agent: 'tal-grok', day: '2026-11-02', orders: [], results: ['{"late":1}'] },
  });
  const r = await snapshot({ api: 'https://arena.test', root, now: NOW, fetchImpl: f, webhook: 'https://discord.test/hook', site: 'https://site.test', log: () => {} });
  assert.ok(existsSync(join(root, 'weekly/2026-W44.json')));
  assert.match(readFileSync(join(root, 'weekly/2026-W44.csv'), 'utf8'), /"Bot, ""X"""/);
  assert.ok(existsSync(join(root, 'ledgers/tal-grok/2026-10-29.json')));
  assert.ok(!existsSync(join(root, 'ledgers/tal-grok/2026-10-30.json')), 'empty days are not written');
  assert.ok(existsSync(join(root, 'ledgers/tal-grok/2026-11-02.json')), "Monday's file so far: the week's last minutes are written after midnight");
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

test('before the opening date: no request at all, no post', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arena-data-'));
  let calls = 0;
  const f = async () => { calls += 1; throw new Error('no network'); };
  const r = await snapshot({ api: 'https://arena.test', root, now: Date.parse('2026-10-19T01:30:00Z'), opens: '2026-10-28T00:00:00Z', fetchImpl: f, webhook: 'https://discord.test/hook', site: 'https://site.test', log: () => {} });
  assert.equal(calls, 0);
  assert.equal(r.skipped, true);
  assert.equal(r.posted, false);
});

// ---------- the S0 check: a season copied somewhere else, never posted ----------

const S0 = { schema: 'arena.standings/v0', season: 'S0', period: { kind: 'season', id: 'S0', from: '2026-10-21T00:00:00Z', to: '2026-10-27T00:00:00Z' }, rows: board.rows };
const s0week = (id, from, to) => ({ ...board, season: 'S0', period: { kind: 'week', id, from, to } });
const S0_ROUTES = {
  '/agents.json': { agents: [{ agentId: 'tal-grok' }] },
  '/season/S0.json': S0,
  '/weekly/2026-W43.json': s0week('2026-W43', '2026-10-21T00:00:00Z', '2026-10-26T00:00:00Z'),
  '/weekly/2026-W44.json': s0week('2026-W44', '2026-10-26T00:00:00Z', '2026-10-27T00:00:00Z'),
  '/ledger/tal-grok/2026-10-21.json': { agent: 'tal-grok', day: '2026-10-21', orders: [], results: ['{"a":1}'] },
  '/ledger/tal-grok/2026-10-27.json': { agent: 'tal-grok', day: '2026-10-27', orders: [], results: ['{"late":1}'] },
};

test('weeks that overlap a period', () => {
  const ids = (a, b) => weeksBetween(Date.parse(a), Date.parse(b)).map((w) => w.id);
  assert.deepEqual(ids('2026-10-21T00:00:00Z', '2026-10-27T00:00:00Z'), ['2026-W43', '2026-W44']);
  assert.deepEqual(ids('2026-10-28T00:00:00Z', '2026-12-01T00:00:00Z'), ['2026-W44', '2026-W45', '2026-W46', '2026-W47', '2026-W48', '2026-W49']);
  assert.deepEqual(ids('2026-10-26T00:00:00Z', '2026-11-02T00:00:00Z'), ['2026-W44']);
});

test('a whole season once its board is out: every week and ledger day of it, no post', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arena-s0-'));
  const f = api(S0_ROUTES);
  const r = await snapshot({ api: 'https://arena.test', root, now: Date.parse('2026-10-27T03:00:00Z'), season: 'S0', fetchImpl: f, webhook: 'https://discord.test/hook', site: 'https://site.test', log: () => {} });
  for (const rel of ['agents.json', 'season/S0.json', 'weekly/2026-W43.json', 'weekly/2026-W43.csv', 'weekly/2026-W44.json', 'ledgers/tal-grok/2026-10-21.json', 'ledgers/tal-grok/2026-10-27.json']) {
    assert.ok(existsSync(join(root, rel)), rel);
  }
  const days = f.seen.filter((u) => u.includes('/ledger/')).map((u) => u.slice(-15, -5));
  assert.equal(days[0], '2026-10-21');
  assert.equal(days.at(-1), '2026-10-27', "the season's closing lines sit in its last day file");
  assert.equal(days.length, 7);
  assert.equal(r.posted, false);
  assert.equal(f.posted.length, 0);
});

test('a season still running: last week only, and only boards of that season', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arena-s0-'));
  const routes = { ...S0_ROUTES, '/weekly/2026-W43.json': { ...board, season: 'S1' } };
  delete routes['/season/S0.json'];
  const f = api(routes);
  const logs = [];
  await snapshot({ api: 'https://arena.test', root, now: Date.parse('2026-10-26T03:00:00Z'), season: 'S0', fetchImpl: f, log: (s) => logs.push(s) });
  assert.ok(!existsSync(join(root, 'weekly/2026-W43.json')), 'a board of another season is not copied');
  assert.ok(existsSync(join(root, 'ledgers/tal-grok/2026-10-21.json')));
  assert.ok(logs.some((l) => /no season board yet/.test(l)));
});

test('live, mid-season: the live board, every closed week of its season, every ledger day so far', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arena-live-'));
  const routes = {
    ...S0_ROUTES,
    '/standings/latest.json': s0week('2026-W44', '2026-10-26T00:00:00Z', '2026-10-27T00:00:00Z'),
    '/weekly/2026-W42.json': { ...board, season: 'S9' },
  };
  delete routes['/season/S0.json'];
  delete routes['/weekly/2026-W44.json'];
  routes['/ledger/tal-grok/2026-10-26.json'] = { agent: 'tal-grok', day: '2026-10-26', orders: [], results: ['{"b":1}'] };
  const f = api(routes);
  const r = await snapshot({ api: 'https://arena.test', root, now: Date.parse('2026-10-26T02:00:00Z'), season: 'S0', live: true, fetchImpl: f, webhook: 'https://discord.test/hook', log: () => {} });
  assert.equal(r.live, true);
  assert.ok(existsSync(join(root, 'standings/latest.json')));
  assert.ok(existsSync(join(root, 'weekly/2026-W43.json')));
  assert.ok(!existsSync(join(root, 'weekly/2026-W42.json')), 'the walk back stops at another season');
  assert.ok(existsSync(join(root, 'ledgers/tal-grok/2026-10-21.json')));
  assert.ok(existsSync(join(root, 'ledgers/tal-grok/2026-10-26.json')));
  const days = f.seen.filter((u) => u.includes('/ledger/')).map((u) => u.slice(-15, -5));
  assert.deepEqual([days[0], days.at(-1), days.length], ['2026-10-21', '2026-10-26', 6]);
  assert.ok(f.seen.indexOf('https://arena.test/standings/latest.json') < f.seen.findIndex((u) => u.includes('/ledger/')), 'live board first, ledgers after it');
  assert.equal(f.posted.length, 0);
});

test('live: a live board of another season is not copied', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arena-live-'));
  const logs = [];
  const f = api({ '/agents.json': { agents: [] }, '/standings/latest.json': { ...board, season: 'S1' } });
  const r = await snapshot({ api: 'https://arena.test', root, now: Date.parse('2026-10-29T02:00:00Z'), season: 'S0', live: true, fetchImpl: f, log: (s) => logs.push(s) });
  assert.equal(r.live, false);
  assert.ok(!existsSync(join(root, 'standings/latest.json')));
  assert.ok(logs.some((l) => /no live board for season S0 \(the live board is season S1\)/.test(l)));
});

const SCRIPT = fileURLToPath(new URL('../scripts/snapshot.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));

function run(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH, ...env } }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

test('command line: --out writes only there, --ignore-opens copies before opening, no Discord post', async () => {
  const posts = [];
  const routes = { ...S0_ROUTES };
  const server = createServer((req, res) => {
    if (req.method === 'POST') { posts.push(req.url); res.writeHead(204).end(); return; }
    const body = routes[req.url.replace('/api', '')];
    if (body === undefined) { res.writeHead(404).end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const before = readdirSync(REPO).sort();
  try {
    const out = mkdtempSync(join(tmpdir(), 'arena-s0-cli-'));
    const r = await run(['--out', out, '--ignore-opens', '--season', 'S0', '--live'], { ARENA_API: `${base}/api`, DISCORD_WEBHOOK_URL: `${base}/hook` });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(existsSync(join(out, 'agents.json')));
    assert.ok(existsSync(join(out, 'season/S0.json')));
    assert.ok(existsSync(join(out, 'ledgers/tal-grok/2026-10-27.json')));
    assert.deepEqual(posts, [], 'a copy elsewhere is never posted');
    assert.deepEqual(readdirSync(REPO).sort(), before, 'nothing new in the repository');
    const repoLive = await run(['--live', '--ignore-opens'], { ARENA_API: `${base}/api` });
    assert.notEqual(repoLive.code, 0, '--live never writes into the repository');
    assert.match(repoLive.stderr, /--live only with --out/);
    assert.deepEqual(readdirSync(REPO).sort(), before);
    const bad = await run(['--out', out, '--season', 'S0; rm -rf /'], { ARENA_API: `${base}/api` });
    assert.notEqual(bad.code, 0);
  } finally {
    server.close();
  }
});

test('the S0 check workflow never writes to this repository', () => {
  const y = readFileSync(join(REPO, '.github/workflows/s0-check.yml'), 'utf8');
  const code = y.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  for (const no of ['git push', 'git commit', 'git add', 'upload-artifact', 'contents: write', 'DISCORD_WEBHOOK_URL']) assert.ok(!code.includes(no), no);
  assert.match(code, /workflow_dispatch/);
  assert.match(code, /snapshot\.mjs --out "\$RUNNER_TEMP\/[^"]+" --ignore-opens --live --season "\$SEASON"/);
  assert.match(code, /arena recompute --data "\$DIR" --live/);
  assert.match(code, /arena recompute --data "\$DIR" --season "\$SEASON"/);
  assert.match(code, /schedule:\n\s+- cron:/);
});
