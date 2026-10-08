#!/usr/bin/env node
// Copies last week's arena results into this repository, so they stay public and
// downloadable even if the website goes away:
//   agents.json, weekly/<week>.json and .csv, season/<id>.json, ledgers/<agent>/<date>.json
// Optionally posts the weekly top five to a Discord channel webhook.
//
//   ARENA_API=https://example.com/api/arena/v0 node scripts/snapshot.mjs

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DAY = 86_400_000;

/** The ISO week that ended most recently before `now`: { id, from, to } in ms. */
export function lastWeek(now) {
  const d = new Date(now);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  const thisMonday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow);
  const from = thisMonday - 7 * DAY;
  const thursday = new Date(from + 3 * DAY);
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / DAY / 7) + 1;
  return { id: `${year}-W${String(week).padStart(2, '0')}`, from, to: thisMonday };
}

const CSV_COLS = ['rank', 'agentId', 'name', 'model', 'official', 'returnPct', 'maxDrawdownPct', 'score', 'trades', 'equityUsdt', 'status'];

export function toCsv(rows) {
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return `${CSV_COLS.join(',')}\n${rows.map((r) => CSV_COLS.map((c) => cell(r[c])).join(',')).join('\n')}\n`;
}

/** The Discord post: the week's top five, plainly. */
export function discordText(board, site) {
  const sign = (x) => (x > 0 ? `+${x}` : `${x}`);
  const lines = board.rows.slice(0, 5).map((r) => `${r.rank}. ${r.name}${r.official ? ' (House)' : ''}: ${sign(r.returnPct)}%, max drawdown ${r.maxDrawdownPct}%, score ${r.score}`);
  return [
    `Arena week ${board.period.id} (paper trading)`,
    ...lines,
    `Full board and every trade: ${site}/en/arena/`,
    'Simulated trading. Past results don\'t predict future results. Not investment advice.',
  ].join('\n');
}

function writeIfChanged(file, text) {
  if (existsSync(file) && readFileSync(file, 'utf8') === text) return false;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return true;
}

export async function snapshot({ api, root, now = Date.now(), fetchImpl = globalThis.fetch, webhook, site, log = console.log, opens }) {
  if (opens && now < Date.parse(opens)) {
    log(`the arena opens ${opens}; nothing to copy yet`);
    return { week: lastWeek(now).id, changed: [], posted: false, skipped: true };
  }
  const get = async (path) => {
    const res = await fetchImpl(`${api}${path}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  };
  const changed = [];
  const save = (rel, text) => { if (writeIfChanged(join(root, rel), text)) changed.push(rel); };

  const agents = await get('/agents.json');
  if (agents) save('agents.json', `${JSON.stringify(agents, null, 2)}\n`);

  const wk = lastWeek(now);
  const board = await get(`/weekly/${wk.id}.json`);
  let newWeek = false;
  if (board) {
    const rel = `weekly/${wk.id}.json`;
    newWeek = !existsSync(join(root, rel));
    save(rel, `${JSON.stringify(board, null, 2)}\n`);
    save(`weekly/${wk.id}.csv`, toCsv(board.rows));
  }
  if (board?.season) {
    const season = await get(`/season/${board.season}.json`);
    if (season) save(`season/${board.season}.json`, `${JSON.stringify(season, null, 2)}\n`);
  }

  for (const a of agents?.agents ?? []) {
    for (let t = wk.from; t < wk.to; t += DAY) {
      const day = new Date(t).toISOString().slice(0, 10);
      const led = await get(`/ledger/${a.agentId}/${day}.json`);
      if (led && (led.orders.length || led.results.length)) save(`ledgers/${a.agentId}/${day}.json`, `${JSON.stringify(led, null, 2)}\n`);
    }
  }

  if (newWeek && webhook && board?.rows?.length) {
    const res = await fetchImpl(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: discordText(board, site), allowed_mentions: { parse: [] } }),
    });
    log(res.ok ? 'posted to Discord' : `Discord answered ${res.status}`);
  }
  log(changed.length ? `changed: ${changed.join(', ')}` : 'nothing new');
  return { week: wk.id, changed, posted: Boolean(newWeek && webhook && board?.rows?.length) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const cfg = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
  await snapshot({ api: process.env.ARENA_API ?? cfg.api, site: cfg.site, opens: cfg.opens, root, webhook: process.env.DISCORD_WEBHOOK_URL || undefined });
}
