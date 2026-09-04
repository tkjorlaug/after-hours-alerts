const crypto = require('crypto');
const slack = require('./slack');

const {
  ZOOM_ACCOUNT_ID,
  ZOOM_CLIENT_ID,
  ZOOM_CLIENT_SECRET,
  ZOOM_WEBHOOK_SECRET_TOKEN,
  EMERGENCY_INBOX_ID,
} = process.env;

// ---- S2S OAuth token (cached ~1h) ---------------------------------------
let _token = { value: null, expiresAt: 0 };

async function getToken() {
  if (_token.value && Date.now() < _token.expiresAt - 60_000) return _token.value;
  const basic = Buffer.from(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${ZOOM_ACCOUNT_ID}`,
    { method: 'POST', headers: { Authorization: `Basic ${basic}` } }
  );
  if (!res.ok) throw new Error(`Zoom token failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  _token = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return _token.value;
}

// ---- Webhook signature verification -------------------------------------
function verifySignature(req) {
  const ts = req.header('x-zm-request-timestamp');
  const sig = req.header('x-zm-signature');
  if (!ts || !sig) return false;
  const message = `v0:${ts}:${req.rawBody.toString('utf8')}`;
  const expected =
    'v0=' + crypto.createHmac('sha256', ZOOM_WEBHOOK_SECRET_TOKEN).update(message).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

// Field paths confirmed against a real payload:
// payload.object.{inbox_id, consumer_number, message_id, date_time_ms}
function extractReceived(payload) {
  const o = payload.object || payload;
  return {
    id: o.message_id || o.id,
    inboxId: o.inbox_id,
    callerAni: o.consumer_number || o.from || o.caller_number,
    receivedAt: o.date_time_ms ? new Date(o.date_time_ms).toISOString()
      : (o.date_time || new Date().toISOString()),
    downloadUrl: o.download_url || o.recording?.download_url || null,
  };
}

// Resolve the audio URL: prefer one in the payload, else look it up via the
// Inboxes messages API. That fallback needs the scope:
//   contact_center:read:inbox_messages:admin
async function resolveDownloadUrl(vm) {
  if (vm.downloadUrl) return vm.downloadUrl;
  const token = await getToken();
  const res = await fetch(
    `https://api.zoom.us/v2/contact_center/inboxes/${vm.inboxId}/messages`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`inbox messages fetch failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const list = data.messages || data.inbox_messages || [];
  const msg = list.find((m) => (m.message_id || m.id) === vm.id) || list[0];
  return msg?.download_url || msg?.playback_url || null;
}

// Download the audio bytes. Zoom media URLs need the token, but often 302 to a
// pre-signed URL that REJECTS the auth header — so follow redirects manually
// and drop the header on the hop.
async function fetchMedia(url) {
  const token = await getToken();
  let res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'manual' });
  if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
    res = await fetch(res.headers.get('location'));
  }
  if (!res.ok) throw new Error(`media fetch failed: ${res.status}`);
  return {
    buf: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get('content-type') || 'audio/mpeg',
  };
}

// ---- Main webhook handler ------------------------------------------------
async function handleWebhook(req, res) {
  const { event, payload } = req.body || {};

  // Endpoint validation challenge (fires once when you save the URL).
  if (event === 'endpoint.url_validation') {
    const encryptedToken = crypto
      .createHmac('sha256', ZOOM_WEBHOOK_SECRET_TOKEN)
      .update(payload.plainToken)
      .digest('hex');
    return res.json({ plainToken: payload.plainToken, encryptedToken });
  }

  if (!verifySignature(req)) return res.status(401).send('bad signature');
  res.status(200).send('ok'); // ack fast, then process

  try {
    if (event !== 'contact_center.inbox_message_received') return;
    const vm = extractReceived(payload);
    if (vm.inboxId !== EMERGENCY_INBOX_ID) return; // only the emergency inbox

    const url = await resolveDownloadUrl(vm);
    if (!url) throw new Error('no download url found for message ' + vm.id);
    const { buf, contentType } = await fetchMedia(url);

    await slack.postVoicemail({
      callerAni: vm.callerAni,
      receivedAt: vm.receivedAt,
      buf,
      contentType,
    });
  } catch (err) {
    console.error('[zoom] handler error:', err);
  }
}

module.exports = { handleWebhook, getToken };
