const express = require('express');
const mail = require('../services/mail');

const router = express.Router();

// Resend, as each email to the domain arrives (Resend dashboard → Webhooks: this URL, event email.received; its
// signing secret is RESEND_WEBHOOK_SECRET). The event only says which email: the mailbox fetches it (services/mail.js).
// A failure answers 500, so Resend tries again (5 s, 5 min, 30 min… up to a day); "Check for mail" catches up too.
// req.rawBody: the body as sent, which the signature covers (server.js keeps it for /api/webhooks/).
router.post('/resend', async (req, res) => {
  if (!process.env.RESEND_WEBHOOK_SECRET) {
    console.error('[mail] a Resend webhook came in, but RESEND_WEBHOOK_SECRET is not set: refused');
    return res.status(503).json({ error: 'not_configured' });
  }
  if (!mail.verifyWebhook(req.rawBody, req.headers)) return res.status(401).json({ error: 'bad_signature' });
  const event = req.body;
  if (event?.type !== 'email.received' || typeof event.data?.email_id !== 'string') return res.json({ ok: true, ignored: true });
  try {
    await mail.ingest(event.data.email_id);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[mail] webhook for ${event.data.email_id}:`, err.message);
    res.status(500).json({ error: 'not_saved' });
  }
});

router.routes = [
  { method: 'POST', path: '/resend', label: 'Resend webhook: received emails' },
];

module.exports = router;
