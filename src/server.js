import express from 'express';
import { createGrpcClient } from '@photon-ai/advanced-imessage/grpc';

const {
  SEND_PORT = '8105',
  N8N_WEBHOOK_URL,
  SEND_AUTH_TOKEN,
  PHOTON_PROJECT_ID,
  PHOTON_PROJECT_SECRET,
  SPECTRUM_CLOUD_URL = 'https://spectrum.photon.codes',
  PHOTON_IMESSAGE_ADDRESS,
} = process.env;

if (!N8N_WEBHOOK_URL) {
  console.error('Missing N8N_WEBHOOK_URL env var');
  process.exit(1);
}
if (!PHOTON_PROJECT_ID || !PHOTON_PROJECT_SECRET) {
  console.error('Missing PHOTON_PROJECT_ID or PHOTON_PROJECT_SECRET env var');
  process.exit(1);
}

// Mints a short-lived iMessage token from Photon's Spectrum Cloud control
// plane: POST /projects/{projectId}/imessage/tokens with HTTP Basic auth
// (projectId:projectSecret). Response is { succeed, data: { type, token or
// auth, expiresIn, ... } } - mirrors what @spectrum-ts/imessage does
// internally (createCloudClients in its published source).
async function fetchImessageTokenData() {
  const basic = Buffer.from(`${PHOTON_PROJECT_ID}:${PHOTON_PROJECT_SECRET}`).toString('base64');
  const res = await fetch(`${SPECTRUM_CLOUD_URL}/projects/${PHOTON_PROJECT_ID}/imessage/tokens`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.succeed) {
    throw new Error(`Photon token mint failed (${res.status}): ${body.message ?? JSON.stringify(body)}`);
  }
  return body.data;
}

let tokenData;
let client;
let clientReady;

function currentToken() {
  if (tokenData.type === 'dedicated') return Object.values(tokenData.auth)[0];
  return tokenData.token;
}

function scheduleTokenRefresh() {
  const refreshInMs = Math.max((tokenData.expiresIn - 60) * 1000, 30_000);
  setTimeout(async () => {
    try {
      tokenData = await fetchImessageTokenData();
    } catch (err) {
      console.error('Token refresh failed:', err.message);
    }
    scheduleTokenRefresh();
  }, refreshInMs).unref();
}

// Lazily creates (once) the gRPC client used for both sending and receiving.
// "shared" projects talk to Photon's shared multi-tenant proxy; "dedicated"
// projects talk to their own instance (one phone number = one address).
async function getClient() {
  if (clientReady) return clientReady;
  clientReady = (async () => {
    tokenData = await fetchImessageTokenData();
    scheduleTokenRefresh();

    const address = PHOTON_IMESSAGE_ADDRESS
      ?? (tokenData.type === 'dedicated'
        ? `${Object.keys(tokenData.auth)[0]}.imsg.photon.codes:443`
        : 'imessage.spectrum.photon.codes:443');

    client = createGrpcClient({
      address,
      tls: true,
      retry: true,
      autoIdempotency: true,
      token: async () => currentToken(),
    });
    console.log(`[imessage] gRPC client connected to ${address} (${tokenData.type})`);
    return client;
  })();
  return clientReady;
}

// Turns a bare recipient ("to") into a direct-message chat guid, unless it's
// already a full chat guid (contains the "any;-;" / "any;+;" separator).
function toChatGuid(to) {
  return /;[-+];/.test(to) ? to : `any;-;${to}`;
}

async function forwardToN8n(event) {
  try {
    const r = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatGuid: event.chatGuid,
        from: event.actor?.address,
        text: event.message.content.text,
        messageGuid: event.message.guid,
        occurredAt: event.occurredAt,
      }),
    });
    if (!r.ok) console.error(`n8n webhook responded ${r.status}`);
  } catch (err) {
    console.error('Failed to forward message to n8n:', err.message, err.cause ?? '');
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Long-lived event loop: keeps a live gRPC stream open to Photon and forwards
// every inbound "message.received" event to n8n. No public port needed for
// this direction - the connection is outbound, initiated by this container.
async function runEventLoop() {
  for (;;) {
    try {
      const im = await getClient();
      for await (const event of im.messages.subscribeEvents()) {
        if (event.type !== 'message.received' || event.isFromMe) continue;
        forwardToN8n(event);
      }
      console.error('[imessage] event stream ended, reconnecting in 5s');
    } catch (err) {
      console.error('[imessage] event stream error:', err.message, err.cause ?? '');
    }
    await sleep(5000);
  }
}

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));

// n8n -> bridge : appelé localement pour envoyer un iMessage sortant
app.post('/send', async (req, res) => {
  if (SEND_AUTH_TOKEN && req.get('x-bridge-token') !== SEND_AUTH_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { to, text } = req.body ?? {};
  if (!to || !text) {
    return res.status(400).json({ error: '"to" and "text" are required' });
  }

  try {
    const im = await getClient();
    const sent = await im.messages.sendText(toChatGuid(to), text);
    res.json({ ok: true, guid: sent.guid });
  } catch (err) {
    console.error('Failed to send via Photon:', err.message, err.cause ?? '');
    res.status(502).json({ error: 'photon send failed', details: String(err.cause ?? err.message) });
  }
});

app.listen(Number(SEND_PORT), '0.0.0.0', () => {
  console.log(`[send] listening on :${SEND_PORT}`);
});

runEventLoop();
