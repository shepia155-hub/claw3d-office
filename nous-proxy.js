// Minimal OpenAI-compatible proxy to Nous Portal inference API, with OAuth refresh.
// Replaces the Hermes CLI proxy on Altare (no Hermes install needed here).
// Env: NOUS_ACCESS_TOKEN, NOUS_REFRESH_TOKEN (initial values; refreshed tokens are
// persisted to NOUS_TOKEN_FILE so a rotated refresh token survives restarts).
// Listens on 127.0.0.1:8642 (same as `hermes proxy start --port 8642`).
// NOTE: Nous refresh tokens are SINGLE-USE. Only this process may refresh this
// session's token. Do NOT point another Hermes install at the same session.
const http = require('http');
const https = require('https');
const fs = require('fs');

const PORTAL = 'https://portal.nousresearch.com';
const INFERENCE = 'https://inference-api.nousresearch.com/v1';
const CLIENT_ID = 'hermes-cli';
const LISTEN_PORT = parseInt(process.env.NOUS_PROXY_PORT || '8642', 10);
const TOKEN_FILE = process.env.NOUS_TOKEN_FILE || '/tmp/nous-tokens.json';

let tokens = { access_token: '', refresh_token: '', expires_at: 0 };
function loadTokens() {
  try {
    const f = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (f.access_token) tokens.access_token = f.access_token;
    if (f.refresh_token) tokens.refresh_token = f.refresh_token;
    if (f.expires_at) tokens.expires_at = f.expires_at;
  } catch (_) { /* no file yet */ }
  if (process.env.NOUS_ACCESS_TOKEN) tokens.access_token = process.env.NOUS_ACCESS_TOKEN;
  if (process.env.NOUS_REFRESH_TOKEN) tokens.refresh_token = process.env.NOUS_REFRESH_TOKEN;
  // If expires_at unknown, assume the env access token is fresh; refresh proactively soon.
  if (!tokens.expires_at) tokens.expires_at = Date.now() + 50 * 60 * 1000;
}
function saveTokens() {
  try { fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens), { mode: 0o600 }); } catch (e) { console.error('[nous-proxy] save tokens failed:', e.message); }
}

let refreshing = null;
async function refreshToken() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    if (!tokens.refresh_token) throw new Error('no refresh_token available');
    const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT_ID }).toString();
    const res = await fetch(`${PORTAL}/api/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-nous-refresh-token': tokens.refresh_token },
      body,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`refresh failed HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }
    const p = await res.json();
    if (!p.access_token) throw new Error('refresh response missing access_token');
    tokens.access_token = p.access_token;
    if (p.refresh_token) tokens.refresh_token = p.refresh_token; // rotation: persist new one
    tokens.expires_at = Date.now() + (p.expires_in ? p.expires_in * 1000 : 3599 * 1000);
    saveTokens();
    console.log('[nous-proxy] token refreshed, expires in', p.expires_in || 3599, 's');
    return tokens.access_token;
  })();
  try { return await refreshing; } finally { refreshing = null; }
}

// Proactive refresh: 5 min before expiry, and every 50 min as a safety net.
async function ensureFresh() {
  if (!tokens.access_token) throw new Error('no access_token available');
  if (Date.now() > tokens.expires_at - 5 * 60 * 1000) await refreshToken();
}
setInterval(() => { ensureFresh().catch((e) => console.error('[nous-proxy] proactive refresh failed:', e.message)); }, 50 * 60 * 1000);

function forward(req, res, body, attempt = 0) {
  ensureFresh().then(() => {
    const target = new URL(INFERENCE + req.url);
    const headers = { ...req.headers };
    delete headers.host; delete headers.connection;
    headers['authorization'] = `Bearer ${tokens.access_token}`;
    const up = https.request(target, { method: req.method, headers }, (upRes) => {
      if (upRes.statusCode === 401 && attempt === 0) {
        // Token expired mid-flight: refresh once and retry.
        upRes.resume();
        refreshToken().then(() => forward(req, res, body, 1)).catch((e) => {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'nous refresh failed: ' + e.message }));
        });
        return;
      }
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
    });
    up.on('error', (e) => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream error: ' + e.message }));
    });
    if (body && body.length) up.write(body);
    up.end();
  }).catch((e) => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'nous auth failed: ' + e.message }));
  });
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => forward(req, res, Buffer.concat(chunks)));
  req.on('error', () => { res.writeHead(400); res.end(); });
});

loadTokens();
if (!tokens.access_token || !tokens.refresh_token) {
  console.error('[nous-proxy] WARNING: NOUS_ACCESS_TOKEN / NOUS_REFRESH_TOKEN not set; inference will fail until they are.');
}
server.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(`[nous-proxy] listening on 127.0.0.1:${LISTEN_PORT} -> ${INFERENCE}`);
  ensureFresh().catch((e) => console.error('[nous-proxy] initial refresh failed:', e.message));
});
