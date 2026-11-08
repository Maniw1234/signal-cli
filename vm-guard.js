'use strict';
// vm-guard: Cloud Run function, called every 10 minutes by Cloud Scheduler.
// Checks the VM's website 3 times, 20 seconds apart. If none of the 3 gets an answer (frozen VM),
// it resets the VM through the Compute API and sends an ntfy alert. At most one reset per hour
// (remembered in a label on the VM). Call with ?test=1 to only check access and send a test alert.
const PROJECT = process.env.PROJECT;
const ZONE = process.env.ZONE;
const INSTANCE = process.env.INSTANCE;
const CHECK_URL = process.env.CHECK_URL;
const NTFY_URL = process.env.NTFY_URL;
const TRIES = Number(process.env.TRIES || 3);
const GAP_MS = Number(process.env.GAP_MS || 20000);
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 60 * 60 * 1000);
const COMPUTE = process.env.COMPUTE_URL || 'https://compute.googleapis.com/compute/v1';
const METADATA = process.env.METADATA_URL || 'http://metadata.google.internal';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function token() {
  const r = await fetch(`${METADATA}/computeMetadata/v1/instance/service-accounts/default/token`,
    { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(10000) });
  return (await r.json()).access_token;
}

async function api(method, path, body) {
  const r = await fetch(`${COMPUTE}/projects/${PROJECT}/zones/${ZONE}/instances/${INSTANCE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${path || 'instance'}: ${(j.error && j.error.message) || r.status}`);
  return j;
}

async function notify(title, message, priority = 'high') {
  if (!NTFY_URL) return;
  try {
    await fetch(NTFY_URL, { method: 'POST', headers: { Title: title, Priority: priority, Tags: 'rotating_light' },
      body: message, signal: AbortSignal.timeout(10000) });
  } catch (e) { console.log('ntfy failed:', e.message); }
}

// any HTTP answer except "the bot behind Caddy is not answering" counts as alive
async function alive() {
  try {
    const r = await fetch(CHECK_URL, { signal: AbortSignal.timeout(20000) });
    return ![502, 503, 504].includes(r.status);
  } catch { return false; }
}

exports.check = async (req, res) => {
  try {
    if (req.query && req.query.test) {
      const vm = await api('GET', '');
      await notify('VM guard test', `Guard can see the VM (status ${vm.status}). Website answering: ${await alive()}.`, 'default');
      return res.status(200).send(`ok: VM status ${vm.status}\n`);
    }
    for (let i = 1; i <= TRIES; i++) {
      if (await alive()) return res.status(200).send(`alive (try ${i})\n`);
      if (i < TRIES) await sleep(GAP_MS);
    }
    const vm = await api('GET', '');
    if (vm.status !== 'RUNNING') {
      await notify('VM is not running', `The VM is ${vm.status}. Start it in the Google Cloud console.`);
      return res.status(200).send(`not running: ${vm.status}\n`);
    }
    const last = Number((vm.labels || {})['guard-last-reset'] || 0);
    if (Date.now() - last < COOLDOWN_MS) {
      await notify('VM still not answering', `The website did not answer ${TRIES} times, but the VM was already reset in the last hour, so the guard is waiting. Check it by hand.`);
      return res.status(200).send('down, in cooldown\n');
    }
    await api('POST', '/setLabels', {
      labels: { ...(vm.labels || {}), 'guard-last-reset': String(Date.now()) }, labelFingerprint: vm.labelFingerprint,
    });
    await api('POST', '/reset');
    await notify('VM was frozen: reset it', `The website did not answer ${TRIES} times in a row, so the guard reset the VM. Bots should be back within about 3 minutes.`);
    return res.status(200).send('reset\n');
  } catch (e) {
    console.log('guard error:', e.message);
    await notify('VM guard error', e.message.slice(0, 300));
    return res.status(500).send(`error: ${e.message}\n`);
  }
};
