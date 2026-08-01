/**
 * End-to-end smoke test.
 *
 * Boots a real `next start` server against a throwaway MongoDB and drives the
 * whole product over HTTP: signup, double opt-in, campaign send through the
 * cron route, one-click unsubscribe, tracking, export, and the auth boundaries.
 *
 * The unit suite covers the libraries; this covers the wiring between them —
 * route handlers, middleware, redirects, headers and status codes. Run it
 * after `npm run build`:
 *
 *     npm run build && npm run smoke
 */
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';

const ROOT = process.cwd();
const PORT = Number(process.env.SMOKE_PORT ?? 3111);
const BASE = `http://127.0.0.1:${PORT}`;
const SECRETS = {
  CRON_SECRET: 'smoke-cron',
  SESSION_SECRET: 'smoke-session',
  CONFIRM_TOKEN_SECRET: 'smoke-confirm',
  UNSUBSCRIBE_SECRET: 'smoke-unsub',
  TRACKING_SECRET: 'smoke-track',
};

let failures = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const mongo = await MongoMemoryServer.create();
let stdout = '';

const server = spawn('npx', ['next', 'start', '-p', String(PORT), '-H', '127.0.0.1'], {
  cwd: ROOT,
  env: {
    ...process.env,
    ...SECRETS,
    NODE_ENV: 'production',
    APP_BASE_URL: BASE,
    MONGODB_URI: mongo.getUri(),
    MONGODB_DB: 'smoke',
    MAILER_DRIVER: 'console',
    DISABLE_MX_CHECK: '1',
    SES_MAX_SEND_RATE: '1000',
    ADMIN_BOOTSTRAP_EMAIL: 'admin@smoke.test',
    ADMIN_BOOTSTRAP_PASSWORD: 'a-very-long-password',
  },
});
server.stdout.on('data', (d) => (stdout += d.toString()));
server.stderr.on('data', (d) => (stdout += d.toString()));

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      await fetch(`${BASE}/login`);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
}

function signPayload(secret, payload) {
  const encoded = Buffer.from(payload, 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

try {
  if (!(await waitForServer())) throw new Error('server never started:\n' + stdout);

  // --- unauthenticated access -------------------------------------------
  const noAuth = await fetch(`${BASE}/api/admin/lists`);
  check('admin API rejects an unauthenticated request', noAuth.status === 401, `status ${noAuth.status}`);

  const cronNoAuth = await fetch(`${BASE}/api/cron/send`);
  check('cron rejects a request with no bearer token', cronNoAuth.status === 401, `status ${cronNoAuth.status}`);

  const cronBadAuth = await fetch(`${BASE}/api/cron/send`, { headers: { authorization: 'Bearer wrong' } });
  check('cron rejects a wrong bearer token', cronBadAuth.status === 401, `status ${cronBadAuth.status}`);

  // --- login -------------------------------------------------------------
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@smoke.test', password: 'a-very-long-password' }),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  check('admin can log in with the bootstrap credentials', login.ok && cookie.startsWith('sm_session='));

  const badLogin = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@smoke.test', password: 'wrong' }),
  });
  check('a wrong password is refused', badLogin.status === 401);

  const authed = (path, init = {}) =>
    fetch(`${BASE}${path}`, { ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) } });

  // --- list --------------------------------------------------------------
  const listResponse = await authed('/api/admin/lists', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Smoke Weekly',
      sendingDomain: 'news.smoke.test',
      fromName: 'Smoke',
      fromEmail: 'hello@news.smoke.test',
      replyTo: 'hello@smoke.test',
      physicalAddress: 'Smoke Ltd, 1 Test Street',
      sesConfigurationSet: 'smoke-set',
      mergeFields: ['city'],
      seedEmails: ['seed@smoke.test'],
    }),
  });
  const { id: listId } = await listResponse.json();
  check('a list can be created', listResponse.status === 201 && Boolean(listId));

  // --- signup, identical responses (§5.1) ---------------------------------
  const signup = (email) =>
    fetch(`${BASE}/api/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ listId, email, website: '', attributes: { first_name: 'Ada' } }),
    });

  const first = await signup('subscriber@example.com');
  const firstBody = await first.text();
  check('signup returns success', first.ok, firstBody);

  const repeat = await signup('subscriber@example.com');
  const bogus = await signup('not-an-email');
  const suppressedResponse = await (async () => {
    await authed('/api/admin/suppressions', {
      method: 'POST',
      body: JSON.stringify({ emails: ['suppressed@example.com'], reason: 'manual' }),
    });
    return signup('suppressed@example.com');
  })();

  const bodies = [firstBody, await repeat.text(), await bogus.text(), await suppressedResponse.text()];
  check(
    'signup response is identical for new, repeat, malformed and suppressed addresses (no enumeration oracle)',
    new Set(bodies).size === 1,
    JSON.stringify(bodies),
  );

  // The suppressed address must not have been created.
  const suppressedLookup = await authed(`/api/admin/subscribers?listId=${listId}&q=suppressed@example.com`);
  const suppressedList = await suppressedLookup.json();
  check('a suppressed address is silently not subscribed', suppressedList.total === 0);

  // --- confirm -----------------------------------------------------------
  const match = stdout.match(new RegExp(`${BASE.replace(/[.]/g, '\\.')}/api/confirm\\?token=([A-Za-z0-9_-]+)`));
  check('a confirmation email was sent with a confirm link', Boolean(match));

  if (match) {
    const confirm = await fetch(match[0], { redirect: 'manual' });
    check('confirm redirects to the welcome page', confirm.status === 303, `status ${confirm.status}`);

    // §5.2 clears the token hash on use, so a replay is "already used" and
    // gets the friendly page — never a raw error.
    const replay = await fetch(match[0], { redirect: 'manual' });
    const replayLocation = replay.headers.get('location') ?? '';
    check(
      'a spent confirm link lands on the friendly page, not an error',
      replay.status === 303 && replayLocation.includes('/confirm/failed'),
      `${replay.status} ${replayLocation}`,
    );
  }

  const badConfirm = await fetch(`${BASE}/api/confirm?token=nonsense`, { redirect: 'manual' });
  check(
    'an unknown confirm token gets the friendly failure page',
    badConfirm.status === 303 && (badConfirm.headers.get('location') ?? '').includes('/confirm/failed'),
  );

  const subscribers = await (await authed(`/api/admin/subscribers?listId=${listId}&status=confirmed`)).json();
  check('the subscriber is now confirmed', subscribers.total === 1, JSON.stringify(subscribers.total));
  const subscriberId = subscribers.subscribers?.[0]?._id;
  check('consent evidence was recorded', Boolean(subscribers.subscribers?.[0]?.confirmIp));

  // --- campaign ----------------------------------------------------------
  const created = await authed('/api/admin/campaigns', {
    method: 'POST',
    body: JSON.stringify({ listId, name: 'Smoke test', subject: 'Hello' }),
  });
  const { id: campaignId } = await created.json();
  check('a campaign can be created', created.status === 201 && Boolean(campaignId));

  const patch = await authed(`/api/admin/campaigns/${campaignId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      subject: 'Hi {{ first_name | default: "there" }}',
      preheader: 'Smoke issue',
      bodySource: {
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Smoke' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Hello {{ first_name | default: "there" }}.' }] },
        ],
      },
    }),
  });
  check('autosave works and reports a save time', patch.ok && Boolean((await patch.json()).savedAt));

  const preview = await (
    await authed(`/api/admin/campaigns/${campaignId}/preview`, { method: 'POST', body: JSON.stringify({}) })
  ).json();
  check('preview renders HTML with fallbacks applied', preview.html?.includes('Hello there.'), preview.subject);
  check('preview renders a plain-text part', preview.text?.includes('Smoke'));

  const gate = await (
    await authed(`/api/admin/campaigns/${campaignId}/validate?quick=1`, { method: 'POST' })
  ).json();
  check('pre-send gate passes for a valid campaign', gate.passed === true, JSON.stringify(gate.checks?.filter((c) => !c.passed)));
  check('gate reports the recipient count', gate.recipientCount === 1);
  check('confirmation summary restates the from address', gate.confirmation?.fromEmail === 'hello@news.smoke.test');

  const send = await authed(`/api/admin/campaigns/${campaignId}/send`, { method: 'POST', body: JSON.stringify({}) });
  const sendBody = await send.json();
  check('send freezes the campaign', send.ok && sendBody.recipients === 1, JSON.stringify(sendBody));

  const cron = await fetch(`${BASE}/api/cron/send`, { headers: { authorization: 'Bearer smoke-cron' } });
  const cronBody = await cron.json();
  check('the cron route sends the batch', cron.ok && cronBody.sent === 1, JSON.stringify(cronBody));
  check('the campaign reconciles to completed', cronBody.campaignsCompleted === 1);

  const secondCron = await fetch(`${BASE}/api/cron/send`, { headers: { authorization: 'Bearer smoke-cron' } });
  const secondCronBody = await secondCron.json();
  check('a second cron run sends nothing more', secondCronBody.sent === 0, JSON.stringify(secondCronBody));

  const report = await (await authed(`/api/admin/campaigns/${campaignId}/report`)).json();
  check('the report shows one sent message', report.sentTotal === 1 && report.campaign?.status === 'sent');

  // --- one-click unsubscribe (§9) ----------------------------------------
  const token = signPayload(SECRETS.UNSUBSCRIBE_SECRET, `${subscriberId}:${campaignId}`);
  const oneClick = await fetch(`${BASE}/api/unsubscribe?t=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'List-Unsubscribe=One-Click',
  });
  check('one-click unsubscribe returns 200 with no landing page', oneClick.status === 200);

  const afterUnsub = await (await authed(`/api/admin/subscribers/${subscriberId}`)).json();
  check('the subscriber is unsubscribed', afterUnsub.subscriber?.status === 'unsubscribed');
  check('unsubscribe does not add a global suppression', afterUnsub.suppression === null);
  check('consent evidence survives the unsubscribe', Boolean(afterUnsub.subscriber?.confirmIp));

  const badUnsub = await fetch(`${BASE}/api/unsubscribe?t=tampered`, { method: 'POST' });
  check('an invalid unsubscribe token still returns 200 (never surface an error to a mail client)', badUnsub.status === 200);

  const humanUnsub = await fetch(`${BASE}/api/unsubscribe?t=${encodeURIComponent(token)}`, { redirect: 'manual' });
  check('GET unsubscribe sends a human to the page', humanUnsub.status === 303);

  // --- tracking ----------------------------------------------------------
  const pixel = await fetch(`${BASE}/api/t/o/${signPayload(SECRETS.TRACKING_SECRET, `o:${campaignId}:${subscriberId}`)}`);
  check('open pixel returns a GIF', pixel.ok && pixel.headers.get('content-type') === 'image/gif');

  const badPixel = await fetch(`${BASE}/api/t/o/garbage`);
  check('an invalid open token still returns a pixel', badPixel.ok);

  const openRedirect = await fetch(`${BASE}/api/t/c/garbage`, { redirect: 'manual' });
  const redirectTarget = openRedirect.headers.get('location') ?? '';
  check('an unsigned click token does not become an open redirect', !redirectTarget.includes('evil'), redirectTarget);

  // --- webhook -----------------------------------------------------------
  const forged = await fetch(`${BASE}/api/webhooks/ses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      Type: 'Notification',
      MessageId: 'forged',
      TopicArn: 'arn',
      Message: JSON.stringify({ eventType: 'Bounce' }),
      Timestamp: new Date().toISOString(),
      SignatureVersion: '1',
      Signature: 'ZmFrZQ==',
      SigningCertURL: 'https://evil.example.com/cert.pem',
    }),
  });
  check('the SES webhook rejects an unsigned/forged message', forged.status === 403);

  // --- export ------------------------------------------------------------
  const exported = await authed(`/api/admin/export/subscribers?listId=${listId}`);
  const csv = await exported.text();
  check('subscriber export includes consent evidence columns', csv.includes('confirm_ip') && csv.includes('confirm_user_agent'));
  check('subscriber export contains the subscriber', csv.includes('subscriber@example.com'));

  const suppressionCsv = await (await authed('/api/admin/export/suppressions')).text();
  check('suppression export works', suppressionCsv.includes('suppressed@example.com'));

  // --- public pages ------------------------------------------------------
  for (const [path, needle] of [
    [`/subscribe/${listId}`, 'Smoke Weekly'],
    ['/confirmed', 'You&rsquo;re subscribed'.replace('&rsquo;', '’')],
    ['/confirm/failed?reason=expired', 'expired'],
  ]) {
    const page = await fetch(`${BASE}${path}`);
    const html = await page.text();
    check(`public page ${path} renders`, page.ok && html.includes(needle), `status ${page.status}`);
  }

  // --- system ------------------------------------------------------------
  const system = await (await authed('/api/admin/system')).json();
  check('the sent_log unique index invariant is present', system.invariants?.sentLogUniqueIndex === true);
} catch (error) {
  check('smoke run completed', false, String(error));
} finally {
  console.log('\n' + results.join('\n'));
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  server.kill('SIGKILL');
  await mongo.stop();
  process.exit(failures > 0 ? 1 : 0);
}
