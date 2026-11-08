'use strict';
// watchdog v2: runs every minute (cron). Keeps the bots healthy without you, and learns.
//  Known fixes (automatic, silent): crashed/stopped bot -> restart; empty or broken file blocking the
//  outbox -> move aside + restart filer; Signal service hanging / posts failing -> restart it;
//  memory almost gone -> restart the biggest bot; disk filling up -> clear logs and caches.
//  Anything else (or a known fix that keeps repeating) is an "incident":
//   1. If the playbook (its memory) has a fix that worked before for this kind of incident, use it.
//   2. Otherwise ask the AI (Groq), showing it past incidents and what worked. The AI may pick ONE
//      action from a fixed safe list (restart a bot, clear the outbox, or wait). It never runs commands.
//   3. 20 minutes later: did the incident come back? If not, that action scores a win; if so, a loss.
//      An action with wins (and at least twice as many wins as losses) is reused automatically next time.
//      Incidents that keep clearing up on their own are learned as harmless.
//  You are only notified when it runs out of things that work (silent mode, the default).
// Files in ~/watchdog: .env (optional settings), playbook.json (what it learned), incidents.jsonl
//  (history), state.json, watchdog.log, PAUSED (if present: no fixes).  Report: node watchdog.js report
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const HOME = os.homedir();
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* optional */ }
try { process.loadEnvFile(path.join(HOME, 'signal-monitor', '.env')); } catch { /* NTFY_TOPIC */ }
let GROQ_KEY = process.env.GROQ_API_KEY || '';
if (!GROQ_KEY) {
  try {
    const m = fs.readFileSync(path.join(HOME, 'drive-filer', '.env'), 'utf8').match(/^\s*GROQ_API_KEY\s*=\s*(.+)$/m);
    if (m) GROQ_KEY = m[1].trim().replace(/^["']|["']$/g, '');
  } catch { /* no AI then */ }
}

const PM2 = process.env.PM2_BIN || 'pm2';
const EXPECTED = (process.env.EXPECTED || 'tg-listener,wa-baileys,tsl-relay,signal-daemon,signal-relay,drive-filer,drive-titler')
  .split(',').map((s) => s.trim()).filter(Boolean);
const OUTBOX = process.env.OUTBOX || path.join(HOME, 'drive-outbox');
const BROKEN = path.join(HOME, 'drive-outbox-broken');
const RPC_URL = process.env.SIGNAL_RPC || 'http://127.0.0.1:8080/api/v1/rpc';
const HEALTH_URL = process.env.HEALTH_URL || 'http://127.0.0.1:3000/health';
const RELAY_STATUS = path.join(HOME, 'signal-relay', 'status.json');
const PM2_LOGS = path.join(HOME, '.pm2', 'logs');
const MIN_FREE_MB = Number(process.env.MIN_FREE_MB || 60);
const DISK_CLEAN_PCT = Number(process.env.DISK_CLEAN_PCT || 85);  // clean up above this
const DISK_STUCK_PCT = Number(process.env.DISK_STUCK_PCT || 92);  // still above this after cleaning: incident
const NTFY = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
const TOPIC = process.env.NTFY_TOPIC || '';
const QUIET = process.env.QUIET !== '0';            // silent unless a human is needed
const GROQ_URL = process.env.GROQ_URL || 'https://api.groq.com/openai/v1/chat/completions';
const AI_MODEL = process.env.AI_MODEL || 'openai/gpt-oss-120b';
const MIN = 60 * 1000;
const VERIFY_MS = Number(process.env.VERIFY_MS || 20 * MIN); // how long a fix must hold to count as a win
const GRACE_MS = Number(process.env.GRACE_MS || 2 * MIN);   // time a fix gets to take effect
const IGNORE = new Set(['whatsapp_paused', 'filing_held_for_review',
  ...String(process.env.IGNORE_PROBLEMS || '').split(',').map((s) => s.trim()).filter(Boolean)]);

const STATE_FILE = path.join(__dirname, 'state.json');
const BOOK_FILE = path.join(__dirname, 'playbook.json');
const INCIDENTS = path.join(__dirname, 'incidents.jsonl');
const LOG_FILE = path.join(__dirname, 'watchdog.log');
const LOCK = path.join(__dirname, '.lock');
const PAUSED = fs.existsSync(path.join(__dirname, 'PAUSED'));

function log(...a) {
  const line = `${new Date().toISOString()} ${a.join(' ')}`;
  console.log(line);
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1024 * 1024) {
      const t = fs.readFileSync(LOG_FILE, 'utf8');
      fs.writeFileSync(LOG_FILE, t.slice(t.length / 2));
    }
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch { /* not critical */ }
}

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const state = readJson(STATE_FILE, {});
state.cool ||= {}; state.fixes ||= {}; state.seen ||= {}; state.count ||= {};
state.trials ||= []; state.lastSeen ||= {}; state.streak ||= {};
const book = readJson(BOOK_FILE, {});
const save = () => {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch { /* */ }
  try { fs.writeFileSync(BOOK_FILE, JSON.stringify(book, null, 1)); } catch { /* */ }
};

function cooldown(key, ms) {
  if (Date.now() - (state.cool[key] || 0) < ms) return false;
  state.cool[key] = Date.now();
  return true;
}
function recordFix(key) {
  const now = Date.now();
  state.fixes[key] = [...(state.fixes[key] || []).filter((t) => now - t < 60 * MIN), now];
  return state.fixes[key].length;
}

const run = (cmd, args, timeout = 60000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) =>
    resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') }));
});

// urgent = a human is needed. Everything else is only logged in silent mode.
async function notify(title, message, urgent = false) {
  log(urgent ? 'ALERT:' : 'info:', title, '-', message.replace(/\n/g, ' | ').slice(0, 300));
  if (!TOPIC || (QUIET && !urgent)) return;
  try {
    await fetch(`${NTFY}/${encodeURIComponent(TOPIC)}`, {
      method: 'POST', headers: { Title: title, Priority: urgent ? 'high' : 'low', Tags: urgent ? 'warning' : 'wrench' },
      body: message.slice(0, 3500), signal: AbortSignal.timeout(15000),
    });
  } catch (e) { log('ntfy failed:', e.message); }
}

async function restart(name, why) {
  if (PAUSED) { log(`PAUSED: would restart ${name} (${why})`); return false; }
  const r = await run(PM2, ['restart', name], 90000);
  log(`restart ${name}: ${r.ok ? 'ok' : 'FAILED ' + r.err.slice(0, 200)} (${why})`);
  return r.ok;
}

function tail(file, lines) {
  try { return fs.readFileSync(file, 'utf8').split('\n').slice(-lines - 1).join('\n'); } catch { return ''; }
}
const redact = (s) => s
  .replace(/(key|token|secret|password|authorization|bearer)(["'\s:=]+)[^\s"',]+/gi, '$1$2[hidden]')
  .replace(/\+?\d{10,15}/g, '[number]');

function memAvailableMb() {
  try {
    const m = fs.readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)/);
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch { return null; }
}

function diskUsedPct(p = process.env.DISK_PATH || '/') {
  try { const s = fs.statfsSync(p); return Math.round(100 * (1 - s.bavail / s.blocks)); } catch { return null; }
}

async function getProcs() {
  const r = await run(PM2, ['jlist'], 60000);
  if (!r.ok) return null;
  try {
    const list = JSON.parse(r.out.slice(r.out.indexOf('[')));
    return list.map((p) => ({
      name: p.name, status: p.pm2_env && p.pm2_env.status, restarts: (p.pm2_env && p.pm2_env.restart_time) || 0,
      memMb: Math.round(((p.monit && p.monit.memory) || 0) / 1048576),
    }));
  } catch { return null; }
}

// ---------------- learning ----------------
const SAFE_ACTIONS = ['none', 'clear_bad_outbox', ...EXPECTED.map((n) => `restart:${n}`)];

// "fingerprint" of an incident: its kind + the last error line, with numbers/times/ids removed,
// so the same failure on another day matches the same playbook entry.
function signature(key, focus) {
  let line = '';
  for (const n of focus || []) {
    const errs = tail(path.join(PM2_LOGS, `${n}-error.log`), 40).split('\n').reverse()
      .find((l) => /error|fail|exception|refused|timeout|denied|cannot|unexpected/i.test(l));
    if (errs) { line = errs; break; }
  }
  const norm = line.toLowerCase()
    .replace(/^.*?(error|fail|exception|refused|timeout|denied|cannot|unexpected)/, '$1')
    .replace(/0x[0-9a-f]+|[0-9a-f]{8,}/g, '#').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 100);
  return `${key.split(':').slice(0, 2).join(':')}${norm ? ' | ' + norm : ''}`;
}

function bestLearned(entry) {
  let best = null;
  for (const [action, s] of Object.entries((entry && entry.actions) || {})) {
    if (action === 'none' || !SAFE_ACTIONS.includes(action)) continue;
    if (s.win >= 1 && s.win >= 2 * s.loss && (!best || s.win - s.loss > best[1].win - best[1].loss)) best = [action, s];
  }
  return best ? best[0] : null;
}

async function applyAction(action, why) {
  if (action === 'none') return true;
  if (PAUSED) { log(`PAUSED: would ${action} (${why})`); return false; }
  if (action === 'clear_bad_outbox') return (await clearBadOutbox()) || true;
  if (action.startsWith('restart:')) return restart(action.slice(8), why);
  return false;
}

// grade earlier tries: an action wins if its incident has not come back within VERIFY_MS
function gradeTrials() {
  const now = Date.now();
  state.trials = state.trials.filter((t) => {
    const back = (state.lastSeen[t.key] || 0) > t.ts + GRACE_MS;
    if (!back && now - t.ts < VERIFY_MS) return true; // still waiting
    const e = (book[t.sig] ||= { first: t.ts, count: 0, actions: {}, selfCleared: 0 });
    const s = (e.actions[t.action] ||= { win: 0, loss: 0 });
    if (back) s.loss++; else s.win++;
    if (t.action === 'none' && !back) e.selfCleared++;
    fs.appendFileSync(INCIDENTS, JSON.stringify({ ts: now, sig: t.sig, action: t.action, result: back ? 'came back' : 'fixed' }) + '\n');
    log(`learned: "${t.sig}" + ${t.action} -> ${back ? 'LOSS (came back)' : 'WIN'}`);
    return false;
  });
}

function pastIncidents() {
  try {
    return fs.readFileSync(INCIDENTS, 'utf8').trim().split('\n').slice(-12).map((l) => {
      const j = JSON.parse(l); return `- ${new Date(j.ts).toISOString().slice(0, 16)} ${j.sig}: ${j.action}${j.result ? ' -> ' + j.result : ''}${j.diagnosis ? ' (' + j.diagnosis.slice(0, 120) + ')' : ''}`;
    }).join('\n');
  } catch { return '(none yet)'; }
}

// an incident needs attention. `confirmed`: already proven real (repeating); otherwise it must be
// seen on 2 runs in a row first, so passing blips are ignored.
async function incident(key, problem, procs, focus, confirmed = false) {
  state.lastSeen[key] = Date.now();
  seenThisRun.add(key);
  state.streak[key] = (state.streak[key] || 0) + 1;
  if (!confirmed && state.streak[key] < 2) return;
  if (state.trials.some((t) => t.key === key)) return; // a fix is being tried; wait for its grade

  const sig = signature(key, focus);
  const entry = (book[sig] ||= { first: Date.now(), count: 0, actions: {}, selfCleared: 0 });
  entry.count++; entry.last = Date.now(); entry.example = problem.slice(0, 200);

  // learned as harmless: it keeps clearing up on its own
  if (entry.selfCleared >= 3 && !bestLearned(entry)) { log(`known harmless, waiting: ${sig}`); state.trials.push({ key, sig, action: 'none', ts: Date.now() }); return; }

  // 1) a fix that worked before
  const learned = bestLearned(entry);
  if (learned && cooldown(`learned:${sig}:${learned}`, 30 * MIN)) {
    log(`using learned fix for "${sig}": ${learned}`);
    if (await applyAction(learned, 'learned')) state.trials.push({ key, sig, action: learned, ts: Date.now() });
    fs.appendFileSync(INCIDENTS, JSON.stringify({ ts: Date.now(), sig, action: learned, source: 'learned' }) + '\n');
    return;
  }

  // 2) ask the AI, with its memory
  if (!cooldown('ai:' + sig, 60 * MIN)) return;
  const tried = Object.entries(entry.actions).map(([a, s]) => `${a}: worked ${s.win}x, failed ${s.loss}x`).join('; ') || 'nothing yet';
  if (!GROQ_KEY) return stuck(sig, entry, problem, 'No AI key found.');
  const logs = (focus || []).map((n) =>
    `--- ${n} errors ---\n${tail(path.join(PM2_LOGS, `${n}-error.log`), 25)}\n--- ${n} output ---\n${tail(path.join(PM2_LOGS, `${n}-out.log`), 25)}`).join('\n');
  const context = redact([
    `PROBLEM: ${problem}`,
    `FINGERPRINT: ${sig} (seen ${entry.count}x). TRIED BEFORE FOR THIS: ${tried}`,
    `MEMORY: ${memAvailableMb()} MB available of ~964 MB. LOAD: ${os.loadavg().map((x) => x.toFixed(2)).join(' ')}`,
    `PM2: ${(procs || []).map((p) => `${p.name}=${p.status},${p.memMb}MB,restarts ${p.restarts}`).join('; ')}`,
    `RECENT INCIDENTS (oldest first):\n${pastIncidents()}`,
    logs,
  ].join('\n')).slice(0, 10000);
  const system = 'You are the on-call engineer for a small Debian VM (1 GB RAM) that runs Node.js bots under pm2: ' +
    'tg-listener (Telegram -> pipeline), wa-baileys (website + /forward), signal-relay and signal-daemon (signal-cli, posts to a Signal group), ' +
    'drive-filer (files recordings from ~/drive-outbox to Google Drive), drive-titler (transcribes with Groq), tsl-relay (another WhatsApp bot). ' +
    'Use the history: do not repeat an action that already failed for this fingerprint. ' +
    'Reply with JSON only: {"diagnosis": "2-4 plain-English sentences", ' +
    `"auto_action": one of ${JSON.stringify(SAFE_ACTIONS)} ("none" = wait, it may clear up), ` +
    '"needs_human": true only if none of the actions can help, "human_fix": "what a person should do, in plain words, or empty"}.';
  let ans;
  try {
    const r = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({
        model: AI_MODEL, temperature: 0.2, max_completion_tokens: 1500, reasoning_effort: 'low',
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: context }],
      }),
      signal: AbortSignal.timeout(90000),
    });
    const j = await r.json();
    const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!text) throw new Error((j.error && j.error.message) || `HTTP ${r.status}`);
    ans = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch (e) {
    log('AI failed:', e.message);
    return; // try again next hour; not worth bothering a human over an AI hiccup
  }
  entry.diagnosis = String(ans.diagnosis || '').slice(0, 600);
  entry.humanFix = String(ans.human_fix || '').slice(0, 400);
  let action = SAFE_ACTIONS.includes(ans.auto_action) ? ans.auto_action : 'none';
  const s = entry.actions[action];
  if (s && s.loss >= 2 && s.win < s.loss) action = 'none'; // the AI suggested something that failed here before
  fs.appendFileSync(INCIDENTS, JSON.stringify({ ts: Date.now(), sig, action, source: 'ai', diagnosis: entry.diagnosis }) + '\n');
  log(`AI for "${sig}": ${action}${ans.needs_human ? ' (needs human)' : ''} - ${entry.diagnosis.slice(0, 200)}`);

  const allFailed = Object.keys(entry.actions).length > 0 && Object.values(entry.actions).every((x) => x.win === 0 && x.loss >= 2);
  if (ans.needs_human || (action === 'none' && allFailed)) return stuck(sig, entry, problem);
  if (await applyAction(action, 'AI')) state.trials.push({ key, sig, action, ts: Date.now() });
}

// the only notification in silent mode: once a day per kind of incident
async function stuck(sig, entry, problem, extra = '') {
  if (!cooldown('stuck:' + sig, 24 * 60 * MIN)) return;
  const tried = Object.entries(entry.actions).map(([a, s]) => `${a} (worked ${s.win}x, failed ${s.loss}x)`).join(', ') || 'nothing';
  await notify('Server needs a person', `${problem}\n\n${entry.diagnosis || ''}\n\nAlready tried: ${tried}.` +
    (entry.humanFix ? `\n\nWhat to do: ${entry.humanFix}` : '') + (extra ? `\n${extra}` : ''), true);
}

// ---------------- known problems ----------------
async function clearBadOutbox() {
  let names;
  try { names = fs.readdirSync(OUTBOX); } catch { return false; }
  const bad = new Set();
  for (const n of names) {
    const f = path.join(OUTBOX, n);
    let st;
    try { st = fs.statSync(f); } catch { continue; }
    if (!st.isFile() || Date.now() - st.mtimeMs < 2 * MIN) continue;
    let broken = st.size === 0;
    if (!broken && n.endsWith('.json')) {
      try { JSON.parse(fs.readFileSync(f, 'utf8')); } catch { broken = true; }
    }
    if (broken) bad.add(n.replace(/\.[^.]+$/, ''));
  }
  if (!bad.size) return false;
  if (PAUSED) { log('PAUSED: would move bad outbox files', [...bad].join(',')); return false; }
  fs.mkdirSync(BROKEN, { recursive: true });
  let moved = 0;
  for (const n of names) {
    if (bad.has(n.replace(/\.[^.]+$/, ''))) {
      try { fs.renameSync(path.join(OUTBOX, n), path.join(BROKEN, n)); moved++; } catch { /* */ }
    }
  }
  await restart('drive-filer', 'bad outbox files');
  await notify('Fixed: stuck outbox', `Moved ${moved} broken file(s) (${[...bad].join(', ')}) to drive-outbox-broken and restarted the filer.`);
  return true;
}

async function signalAnswers() {
  try {
    const r = await fetch(RPC_URL, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'version', id: 1 }), signal: AbortSignal.timeout(20000),
    });
    const j = await r.json();
    return !!(j && j.result);
  } catch { return false; }
}

// ---------------- report ----------------
function report() {
  const rows = Object.entries(book).sort((a, b) => b[1].count - a[1].count);
  if (!rows.length) return console.log('Nothing learned yet. (Incidents appear here after the first unknown or repeating problem.)');
  for (const [sig, e] of rows) {
    const acts = Object.entries(e.actions).map(([a, s]) => `${a} ${s.win}W/${s.loss}L`).join(', ') || 'none tried';
    const learned = bestLearned(e);
    console.log(`\n${sig}\n  seen ${e.count}x, last ${e.last ? new Date(e.last).toISOString().slice(0, 16) : '-'}; tried: ${acts}` +
      `\n  status: ${learned ? (e.actions[learned].win >= 2 ? 'LEARNED fix: ' : 'probably fixed by: ') + learned : e.selfCleared >= 3 ? 'learned as harmless (clears itself)' : 'still learning'}` +
      (e.diagnosis ? `\n  diagnosis: ${e.diagnosis}` : ''));
  }
}

// ---------------- main ----------------
const seenThisRun = new Set();

async function main() {
  const procs = await getProcs();
  if (!procs) { log('pm2 did not answer (VM overloaded?)'); return; }
  const byName = Object.fromEntries(procs.map((p) => [p.name, p]));
  const now = Date.now();

  // 1) expected bots that are stopped / errored / missing
  for (const name of EXPECTED) {
    const p = byName[name];
    if (!p) { await incident('missing:' + name, `${name} is not in pm2 at all (it should be running).`, procs, [], true); continue; }
    if (['stopped', 'errored'].includes(p.status) && cooldown('restart:' + name, 5 * MIN)) {
      if (!(await restart(name, `status ${p.status}`))) continue;
      const n = recordFix('restart:' + name);
      await notify(`Fixed: ${name}`, `${name} was ${p.status}; restarted it.`);
      if (n >= 3) await incident('repeat:' + name, `${name} keeps stopping (${p.status}); restarted ${n} times in the last hour.`, procs, [name], true);
    }
  }

  // 2) crash loops
  for (const p of procs.filter((x) => EXPECTED.includes(x.name))) {
    const hist = (state.seen[p.name] || []).filter((h) => now - h[0] < 15 * MIN);
    hist.push([now, p.restarts]);
    state.seen[p.name] = hist;
    if (hist.length > 1 && p.restarts - hist[0][1] >= 5) {
      await incident('loop:' + p.name, `${p.name} restarted ${p.restarts - hist[0][1]} times in 15 minutes (crash loop).`, procs, [p.name], true);
    }
  }

  // 3) broken files blocking the Drive filer
  await clearBadOutbox();

  // 4) Signal service hanging (2 checks in a row) or posts failing
  if (byName['signal-daemon'] && byName['signal-daemon'].status === 'online') {
    state.count.signalDown = (await signalAnswers()) ? 0 : (state.count.signalDown || 0) + 1;
    if (state.count.signalDown >= 2 && cooldown('restart:signal-daemon', 10 * MIN)) {
      state.count.signalDown = 0;
      if (await restart('signal-daemon', 'not answering')) {
        const n = recordFix('signal-daemon');
        await notify('Fixed: Signal service', 'The Signal service stopped answering; restarted it.');
        if (n >= 3) await incident('signal-hang', `Signal service keeps hanging; restarted ${n} times in the last hour.`, procs, ['signal-daemon', 'signal-relay'], true);
      }
    }
  }
  try {
    const s = JSON.parse(fs.readFileSync(RELAY_STATUS, 'utf8'));
    if (s.lastFail > (s.lastOk || 0) && now - s.lastFail < 30 * MIN && s.lastFail !== state.count.lastFailSeen
      && cooldown('restart:signal-daemon', 10 * MIN)) {
      state.count.lastFailSeen = s.lastFail;
      if (await restart('signal-daemon', 'posting failed')) {
        const n = recordFix('signal-post');
        await notify('Fixed: Signal posting', `A call failed to post (${String(s.lastError || '').slice(0, 150)}); restarted the Signal service.`);
        if (n >= 3) await incident('signal-post', `Posting to Signal keeps failing: ${s.lastError}`, procs, ['signal-relay', 'signal-daemon'], true);
      }
    }
  } catch { /* no status yet */ }

  // 5) memory almost gone -> restart the biggest bot
  const free = memAvailableMb();
  if (free !== null && free < MIN_FREE_MB) {
    const big = procs.filter((p) => EXPECTED.includes(p.name) && p.status === 'online').sort((a, b) => b.memMb - a.memMb)[0];
    if (big && cooldown('memory', 10 * MIN) && (await restart(big.name, `low memory ${free} MB`))) {
      const n = recordFix('memory');
      await notify('Fixed: low memory', `Only ${free} MB free; restarted ${big.name} (${big.memMb} MB).`);
      if (n >= 3) await incident('memory', `Memory keeps running out (${free} MB free); restarted the biggest bot ${n} times in the last hour.`, procs, [big.name], true);
    }
  }

  // 6) disk filling up -> empty bot logs, trim system logs and package cache
  const used = diskUsedPct();
  if (used !== null && used >= DISK_CLEAN_PCT && cooldown('disk-clean', 30 * MIN) && !PAUSED) {
    await run(PM2, ['flush'], 60000);
    await run('sudo', ['-n', 'journalctl', '--vacuum-size=100M'], 120000);
    await run('sudo', ['-n', 'apt-get', 'clean'], 120000);
    const after = diskUsedPct();
    log(`disk cleanup: ${used}% -> ${after}%`);
    await notify('Fixed: disk filling up', `Disk was ${used}% full; cleared logs and caches. Now ${after}%.`);
    if (after !== null && after >= DISK_STUCK_PCT) {
      await incident('disk', `Disk is still ${after}% full after clearing logs and caches. Something else is filling it.`, procs, [], true);
    }
  }

  // 7) problems reported by the feed's health page with no known fix
  try {
    const h = await (await fetch(HEALTH_URL, { signal: AbortSignal.timeout(15000) })).json();
    for (const p of (Array.isArray(h.problems) ? h.problems : []).map(String)) {
      if (!IGNORE.has(p)) await incident('health:' + p, `The feed health page reports "${p}". Health data: ${JSON.stringify(h).slice(0, 800)}`, procs, ['wa-baileys']);
    }
  } catch { /* restarts above handle a dead website bot */ }

  // grade earlier fixes now that this run's observations are in
  gradeTrials();

  // incidents not seen this run lose their streak (blips must repeat to count)
  for (const k of Object.keys(state.streak)) if (!seenThisRun.has(k)) delete state.streak[k];
}

if (process.argv[2] === 'report') { report(); } else {
  (async () => {
    try {
      if (fs.existsSync(LOCK) && Date.now() - fs.statSync(LOCK).mtimeMs < 10 * MIN) return;
      fs.writeFileSync(LOCK, String(process.pid));
    } catch { return; }
    try { await main(); } catch (e) { log('watchdog error:', e.stack || e.message); } finally {
      save();
      try { fs.unlinkSync(LOCK); } catch { /* */ }
    }
  })();
}
