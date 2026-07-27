import express from 'express';
import http from 'http';
import crypto from 'crypto';

const {
  SEND_PORT = '8105',
  WEBHOOK_PORT = '8106',
  N8N_WEBHOOK_URL,
  SEND_AUTH_TOKEN,
  PHOTON_PROJECT_ID,
  PHOTON_API_KEY,
  PHOTON_SEND_URL,
  PHOTON_AUTH_HEADER = 'Authorization',
  PHOTON_AUTH_SCHEME = 'Bearer',
  PHOTON_WEBHOOK_SECRET,
  PHOTON_SIGNATURE_HEADER = 'x-photon-signature',
} = process.env;

if (!N8N_WEBHOOK_URL) {
  console.error('Missing N8N_WEBHOOK_URL env var');
  process.exit(1);
}
if (!PHOTON_SEND_URL || !PHOTON_API_KEY) {
  console.error('Missing PHOTON_SEND_URL or PHOTON_API_KEY env var');
  process.exit(1);
}

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

app.get('/health', (_req, res) => res.json({ ok: true }));

function verifyPhotonSignature(req) {
  if (!PHOTON_WEBHOOK_SECRET) return true;
  const signature = req.get(PHOTON_SIGNATURE_HEADER);
  if (!signature) return false;
  const expected = crypto
    .createHmac('sha256', PHOTON_WEBHOOK_SECRET)
    .update(req.rawBody ?? Buffer.alloc(0))
    .digest('hex');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Photon -> bridge : appelé par Photon a chaque iMessage recu (endpoint public)
app.post('/webhook/photon', async (req, res) => {
  if (!verifyPhotonSignature(req)) {
    return res.status(401).json({ error: 'invalid signature' });
  }
  res.status(200).json({ received: true });

  try {
    const r = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    if (!r.ok) {
      console.error(`n8n webhook responded ${r.status}`);
    }
  } catch (err) {
    console.error('Failed to forward message to n8n:', err.message, err.cause ?? '');
  }
});

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
    const photonRes = await fetch(PHOTON_SEND_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [PHOTON_AUTH_HEADER]: `${PHOTON_AUTH_SCHEME} ${PHOTON_API_KEY}`.trim(),
      },
      body: JSON.stringify({ projectId: PHOTON_PROJECT_ID, to, text }),
    });

    const data = await photonRes.json().catch(() => ({}));
    if (!photonRes.ok) {
      return res.status(photonRes.status).json({ error: 'photon send failed', details: data });
    }
    res.json({ ok: true, photon: data });
  } catch (err) {
    console.error('Failed to call Photon:', err.message, err.cause ?? '');
    res.status(502).json({ error: 'photon request failed', details: String(err.cause ?? err.message) });
  }
});

// Deux serveurs HTTP distincts sur le meme process Express :
// - SEND_PORT : lie en local uniquement (127.0.0.1), c'est n8n qui l'appelle.
// - WEBHOOK_PORT : exposé publiquement, c'est Photon qui l'appelle depuis internet.
http.createServer(app).listen(Number(SEND_PORT), '0.0.0.0', () => {
  console.log(`[send]    listening on :${SEND_PORT} (bind to 127.0.0.1 via docker-compose/firewall)`);
});
http.createServer(app).listen(Number(WEBHOOK_PORT), '0.0.0.0', () => {
  console.log(`[webhook] listening on :${WEBHOOK_PORT} (expose this one publicly for Photon)`);
});
