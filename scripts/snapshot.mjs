#!/usr/bin/env node
// Copies last week's arena results into this repository, so they stay public and
// downloadable even if the website goes away:
//   agents.json, weekly/<week>.json and .csv, season/<id>.json, ledgers/<agent>/<date>.json
// (the week's days, plus today's file so far).
// Optionally posts the weekly top five to a Discord channel webhook.
//
//   ARENA_API=https://example.com/api/arena/v0 node scripts/snapshot.mjs
//
// For a check that must not end up in this repository (the S0 trial season):
//
//   node scripts/snapshot.mjs --out DIR --ignore-opens --season S0
//
//   --out DIR        write into DIR instead of this repository; never posts to Discord
//   --ignore-opens   copy even before the opening date in config.json
//   --season ID      copy that season's board, every weekly board of it and every
//                    ledger day of it (only last week's, while the season is still running)
//   --live           also copy the running week's board (standings/latest.json), every
//                    closed week of its season and every ledger day so far, for
//                    `tal arena recompute --live`. Only with --out: the live board is
//                    never kept in this repository.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

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

/** Every ISO week that overlaps [from, to), as { id, from, to } in ms. */
export function weeksBetween(from, to) {
  const out = [];
  for (let w = lastWeek(from + 7 * DAY); w.from < to; w = lastWeek(w.to + 7 * DAY)) out.push(w);
  return out;
}

export async function snapshot({ api, root, now = Date.now(), fetchImpl = globalThis.fetch, webhook, site, log = console.log, opens, season, live = false }) {
  if (opens && now < Date.parse(opens)) {
    log(`the arena opens ${opens}; nothing to copy yet`);
    return { week: lastWeek(now).id, changed: [], posted: false, skipped: true };
  }
  const fetched = new Map();
  const get = async (path) => {
    if (fetched.has(path)) return fetched.get(path);
    const res = await fetchImpl(`${api}${path}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    const body = await res.json();
    fetched.set(path, body);
    return body;
  };
  const changed = [];
  const save = (rel, text) => { if (writeIfChanged(join(root, rel), text)) changed.push(rel); };

  const agents = await get('/agents.json');
  if (agents) save('agents.json', `${JSON.stringify(agents, null, 2)}\n`);

  const wk = lastWeek(now);
  const today = Math.floor(now / DAY) * DAY;
  // Which weeks and ledger days to copy. Normally last week's; with `season`, once that
  // season's board is out, all of the season (its last day file holds the closing lines).
  let weeks = [wk];
  let dayFrom = wk.from;
  let dayTo = Math.max(today, wk.to - DAY);
  // The live board first: the ledgers copied after it are then at least as new as it is.
  let liveBoard = null;
  if (live) {
    const b = await get('/standings/latest.json');
    if (b && (!season || b.season === season)) {
      liveBoard = b;
      save('standings/latest.json', `${JSON.stringify(b, null, 2)}\n`);
    } else log(`no live board${season ? ` for season ${season}` : ''}${b ? ` (the live board is season ${b.season})` : ''}`);
  }
  const seasonBoard = season ? await get(`/season/${season}.json`) : null;
  if (seasonBoard) {
    const from = Date.parse(seasonBoard.period.from);
    const to = Date.parse(seasonBoard.period.to);
    weeks = weeksBetween(from, to);
    dayFrom = Math.floor(from / DAY) * DAY;
    dayTo = Math.floor(to / DAY) * DAY;
    save(`season/${season}.json`, `${JSON.stringify(seasonBoard, null, 2)}\n`);
  } else if (liveBoard) {
    // The live week, and back from it every closed week of the same season.
    const current = lastWeek(Date.parse(liveBoard.period.from) + 7 * DAY);
    weeks = [current];
    let first = Date.parse(liveBoard.period.from);
    for (let w = lastWeek(current.from); weeks.length < 30; w = lastWeek(w.from)) {
      const b = await get(`/weekly/${w.id}.json`);
      if (!b || b.season !== liveBoard.season) break;
      weeks.unshift(w);
      first = Date.parse(b.period.from);
    }
    dayFrom = Math.floor(first / DAY) * DAY;
    dayTo = today;
  } else if (season) {
    log(`season ${season}: no season board yet (published when the season ends); copying last week only`);
  }
  const want = season ?? liveBoard?.season;

  let board = null;
  let newWeek = false;
  for (const w of weeks) {
    const b = await get(`/weekly/${w.id}.json`);
    if (!b || (want && b.season !== want)) continue;
    const rel = `weekly/${w.id}.json`;
    if (w.id === wk.id) {
      board = b;
      newWeek = !existsSync(join(root, rel));
    }
    save(rel, `${JSON.stringify(b, null, 2)}\n`);
    save(`weekly/${w.id}.csv`, toCsv(b.rows));
  }
  if (!season && board?.season) {
    const s = await get(`/season/${board.season}.json`);
    if (s) save(`season/${board.season}.json`, `${JSON.stringify(s, null, 2)}\n`);
  }

  // Also today's file so far: the arena writes the week's last minutes just after
  // midnight, so they sit in Monday's file. Next week's run copies Monday in full.
  for (const a of agents?.agents ?? []) {
    for (let t = dayFrom; t <= dayTo; t += DAY) {
      const day = new Date(t).toISOString().slice(0, 10);
      const led = await get(`/ledger/${a.agentId}/${day}.json`);
      if (led && (led.orders.length || led.results.length)) save(`ledgers/${a.agentId}/${day}.json`, `${JSON.stringify(led, null, 2)}\n`);
    }
  }

  const post = Boolean(!season && !live && newWeek && webhook && board?.rows?.length);
  if (post) {
    const res = await fetchImpl(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: discordText(board, site), allowed_mentions: { parse: [] } }),
    });
    log(res.ok ? 'posted to Discord' : `Discord answered ${res.status}`);
  }
  log(changed.length ? `changed: ${changed.join(', ')}` : 'nothing new');
  return { week: wk.id, changed, posted: post, live: Boolean(liveBoard) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values: o } = parseArgs({ options: { out: { type: 'string' }, 'ignore-opens': { type: 'boolean' }, season: { type: 'string' }, live: { type: 'boolean' } } });
  if (o.live && !o.out) throw new Error('--live only with --out: the live board is never copied into this repository');
  if (o.season != null && !/^S\d{1,3}$/.test(o.season)) throw new Error(`--season: expected an id like S0, got ${o.season}`);
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
  const cfg = JSON.parse(readFileSync(join(repo, 'config.json'), 'utf8'));
  await snapshot({
    api: process.env.ARENA_API ?? cfg.api,
    site: cfg.site,
    opens: o['ignore-opens'] ? undefined : cfg.opens,
    root: o.out ?? repo,
    season: o.season,
    live: Boolean(o.live),
    // A copy somewhere else is a check, not a publication: never post it.
    webhook: o.out ? undefined : process.env.DISCORD_WEBHOOK_URL || undefined,
  });
}
