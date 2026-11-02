// The team's mailboxes (Admin → Mail, services/mail.js). genlpt.com's mail is received by Resend (its MX record
// points there): Resend tells the app about each email (POST /api/webhooks/resend), and the app keeps it in
// mail_messages, where admins read and answer it. Mail to an address at the domain that isn't listed here (no-reply@,
// a typo) still comes in, under Other. name: the sender's name on mail sent from that address. icon: its Boxicon.
const MAILBOXES = [
  { address: 'support@genlpt.com', name: 'GenLPT Support', icon: 'headphone-mic' },
  { address: 'privacy@genlpt.com', name: 'GenLPT Privacy', icon: 'shield' },
  { address: 'alerts@genlpt.com', name: 'GenLPT Alerts', icon: 'bell' },
];

// Dates in the mailbox are shown in the business's time zone (it's in Florida)
const TIME_ZONE = 'America/New_York';

// An email the mailbox can't keep whole: its HTML past this (inline images make it big) is fetched again with the
// images left out, and dropped if that's still too big (the text stays). MongoDB documents stop at 16 MB.
const HTML_MAX_CHARS = 4 * 1024 * 1024;
const TEXT_MAX_CHARS = 1024 * 1024;

// What an admin can write: the message, and how many addresses (Resend's own limit is 50)
const BODY_MAX_CHARS = 20000;
const RECIPIENTS_MAX = 20;
const SIGNATURE_MAX_CHARS = 500;

// What an email can carry, files attached and forwarded together: Resend takes 40 MB an email, counted after Base64,
// which adds a third
const ATTACHMENTS_MAX_BYTES = 29 * 1024 * 1024;
const ATTACHMENTS_MAX_FILES = 10; // attached to one email, from the form

module.exports = { MAILBOXES, TIME_ZONE, HTML_MAX_CHARS, TEXT_MAX_CHARS, BODY_MAX_CHARS, RECIPIENTS_MAX, SIGNATURE_MAX_CHARS, ATTACHMENTS_MAX_BYTES, ATTACHMENTS_MAX_FILES };
