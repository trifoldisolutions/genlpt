// Account emails, as { subject, text, html }. Wording: dev_resources/account_copy.md.
// No email includes anything a visitor typed (not even a name): these go to addresses that anyone can enter,
// and a name would let a stranger put their own words in an email sent from our domain.

const brand = require('../../config/brand');
const { VERIFY_LINK_HOURS, RESET_LINK_HOURS, UNVERIFIED_DAYS } = require('../../config/limits');

const { appName } = brand;
const hours = (n) => (n === 1 ? '1 hour' : `${n} hours`);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const FONT = "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const P = 'margin:0 0 16px;font-size:15px;line-height:1.55;color:#27272a;';
const LINK = 'color:#c11562;text-decoration:underline;';

// Blocks: a string is a paragraph; { button, url } is the one main action; { links: [[label, url], …] } are
// secondary links; { quote } is text kept as written, line breaks included (a support request's message);
// { details: [[label, value], …] } is a compact list of facts. The text version turns every link into
// "label: url". signed: false leaves out "The {appName} team".
function compose(subject, blocks, { signed = true } = {}) {
  const text = [
    ...blocks.map((b) => {
      if (typeof b === 'string') return b;
      if (b.quote != null) return b.quote;
      if (b.details) return b.details.map(([label, value]) => `${label}: ${value}`).join('\n');
      if (b.button) return `${b.button}: ${b.url}`;
      return b.links.map(([label, url]) => `${label}: ${url}`).join('\n');
    }),
    ...(signed ? [`The ${appName} team`] : []),
  ].join('\n\n');

  const body = blocks.map((b) => {
    if (typeof b === 'string') return `<p style="${P}">${esc(b)}</p>`;
    if (b.quote != null) return `<p style="${P}white-space:pre-wrap;border-left:3px solid #e4e4e7;padding-left:12px;">${esc(b.quote)}</p>`;
    if (b.details) {
      const rows = b.details.map(([label, value]) => `<tr><td style="padding:2px 12px 2px 0;color:#71717a;white-space:nowrap;vertical-align:top;">${esc(label)}</td><td style="padding:2px 0;color:#27272a;word-break:break-all;">${esc(value)}</td></tr>`);
      return `<table style="margin:0 0 16px;border-collapse:collapse;font-size:13px;line-height:1.5;">${rows.join('')}</table>`;
    }
    if (b.button) {
      return `<p style="margin:24px 0;"><a href="${esc(b.url)}" style="display:inline-block;background:#de247d;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:11px 20px;border-radius:6px;">${esc(b.button)}</a></p>`
        + `<p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:#71717a;">If the button doesn't work, copy and paste this link into your browser:<br><a href="${esc(b.url)}" style="${LINK}word-break:break-all;">${esc(b.url)}</a></p>`;
    }
    return `<p style="${P}">${b.links.map(([label, url]) => `<a href="${esc(url)}" style="${LINK}">${esc(label)}</a>`).join(' &nbsp;·&nbsp; ')}</p>`;
  }).join('\n');

  const html = `<!doctype html>
<html lang="en">
<body style="margin:0;padding:24px 16px;background:#fafafa;font-family:${FONT};">
<div style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #e4e4e7;border-radius:6px;padding:28px 24px;">
<p style="margin:0 0 24px;font-size:18px;font-weight:700;color:#18181b;">${esc(appName)}</p>
${body}
${signed ? `<p style="margin:24px 0 0;font-size:15px;line-height:1.55;color:#27272a;">The ${esc(appName)} team</p>` : ''}
</div>
</body>
</html>`;

  return { subject, text, html };
}

// Signup with a new (or never confirmed) address
function verifyEmail({ url }) {
  return compose(`Confirm your email address for ${appName}`, [
    `Thank you for creating a ${appName} account. Please confirm your email address to activate it.`,
    { button: 'Confirm my email address', url },
    `This link expires in ${hours(VERIFY_LINK_HOURS)} and can be used only once.`,
    `If you didn't create this account, someone may have entered your email address by mistake or on purpose. The account will not be activated unless this link is used, and it will be deleted automatically after ${UNVERIFIED_DAYS} days.`,
  ]);
}

// Signup with an address that already has a confirmed account (agreed 2026-10-03)
function alreadyRegistered({ loginUrl, forgotUrl }) {
  return compose(`A ${appName} account already exists for this email address`, [
    `We received a request to create a ${appName} account using this email address, which is already registered with us.`,
    'If this was you, you can log in to your existing account, or reset your password if you\'ve forgotten it.',
    { links: [['Log in', loginUrl], ['Reset my password', forgotUrl]] },
    'If this wasn\'t you, someone may have entered your email address by mistake or on purpose. No new account was created, and your existing account has not been changed. To keep your account secure, make sure your password is strong and isn\'t used on any other site.',
  ]);
}

function resetPassword({ url }) {
  return compose(`Reset your ${appName} password`, [
    `We received a request to reset the password for your ${appName} account. To choose a new password, use the button below.`,
    { button: 'Reset my password', url },
    `This link expires in ${hours(RESET_LINK_HOURS)} and can be used only once.`,
    'If you didn\'t request a password reset, someone may have entered your email address by mistake or on purpose. Your password has not been changed, and it will stay the same unless this link is used.',
  ]);
}

// To the new address an account asked to change to, from its settings (which takes the password)
function confirmNewEmail({ url }) {
  return compose(`Confirm your new email address for ${appName}`, [
    `We received a request to change the email address of a ${appName} account to this one. Please confirm it to complete the change.`,
    { button: 'Confirm my new email address', url },
    `This link expires in ${hours(VERIFY_LINK_HOURS)} and can be used only once. You'll be asked to log in to the account if you aren't already.`,
    'If you didn\'t ask for this, someone may have entered your email address by mistake or on purpose. Nothing will change unless this link is used.',
  ]);
}

// The same request, for an address that already has a confirmed account: there's nothing to confirm
function emailInUse({ loginUrl, forgotUrl }) {
  return compose(`This email address is already registered with ${appName}`, [
    `We received a request to change the email address of a ${appName} account to this one. This address already belongs to another ${appName} account, so it can't be used, and nothing was changed.`,
    'If this was you, you can log in to the account that uses this address, or reset its password if you\'ve forgotten it.',
    { links: [['Log in', loginUrl], ['Reset my password', forgotUrl]] },
    'If this wasn\'t you, someone may have entered your email address by mistake or on purpose. Your account has not been changed.',
  ]);
}

// To the previous address, once the new one is confirmed. The new one isn't named: an email never says what a visitor typed.
function emailChanged() {
  return compose(`Your ${appName} email address has been changed`, [
    `The email address of your ${appName} account has been changed, as requested from its settings and confirmed from the new address. From now on, you'll log in with the new address, and emails about your account will go there.`,
    'If you didn\'t make this change, someone who knew your password did. If you use the same password on other sites, change it there now.',
  ]);
}

// After a password change in settings, which takes the old one
function passwordChanged({ forgotUrl }) {
  return compose(`Your ${appName} password has been changed`, [
    `The password of your ${appName} account has been changed from its settings, and every other device that was logged in to it has been logged out.`,
    'If you didn\'t change it, someone who knew your previous password did. To get your account back, reset your password now.',
    { links: [['Reset my password', forgotUrl]] },
  ]);
}

// After an account was deleted from its settings, which takes its password: a stranger who knew it should be noticed
function accountDeleted() {
  return compose(`Your ${appName} account has been deleted`, [
    `Your ${appName} account has been permanently deleted, together with all of its sessions, as requested from its settings. This cannot be undone.`,
    'If you didn\'t delete it, someone who knew your password did. If you use the same password on other sites, change it there now.',
  ]);
}

// Not an account email: to the team (ALERT_EMAIL or the admins), the first time a day's AI spend crosses a line
// of DAILY_SPEND (config/limits.js). line: 'warning', 'guest' or 'free'. test: sent by npm run alert:test, to check
// alerts reach their inbox, and says so.
function spendAlert({ line, cost, byPlan, limits, test = false }) {
  const usd = (n) => `$${(n || 0).toFixed(2)}`; // what was spent
  const at = (n) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`; // a line
  const { guest, free } = limits.pause;
  const subject = {
    warning: `${appName}: today's AI spend reached ${at(limits.warning)}`,
    guest: `${appName}: AI is paused for guests until midnight UTC`,
    free: `${appName}: AI is paused for guests and free accounts until midnight UTC`,
  }[line];
  const next = {
    warning: `Guests will be paused at ${at(guest)} and free accounts at ${at(free)}.`,
    guest: `Guests can't use AI until midnight UTC. Free accounts will be paused at ${at(free)}.`,
    free: 'Guests and free accounts can\'t use AI until midnight UTC. Paid accounts keep going.',
  }[line];
  return compose(test ? `[Test] ${subject}` : subject, [
    ...(test ? ['This is a test of the daily AI spend alerts: nothing was spent and nothing is paused. A real alert looks like the rest of this email.'] : []),
    `Today's AI spend is ${usd(cost)} since midnight UTC. ${next}`,
    `By plan: guests ${usd(byPlan.guest)}, free accounts ${usd(byPlan.free)}, paid accounts ${usd(byPlan.paid)}.`,
    'These lines are DAILY_SPEND in config/limits.js.',
  ]);
}

const SUPPORT_TOPICS = { billing: 'Billing', account: 'Account', usage: 'AI and usage', sessions: 'Sessions', words: 'Words and acronyms', other: 'Other' };
const PLAN_NAMES = { guest: 'Guest', free: 'Free account', paid: 'Paid plan' };
const day = (date) => (date ? new Date(date).toISOString().slice(0, 10) : '?');

// Not an account email: a message from Settings → Help center, to the support inbox (services/support.js), sent
// with Reply-To the sender. It holds what they typed, which is fine here: it only ever goes to our own inbox.
// r: the SupportRequest, as saved
function supportRequest(r) {
  const sub = r.subscription;
  const details = [
    ['From', `${r.email} (${r.userId ? 'account' : 'guest, address not confirmed'})`],
    ['Plan', PLAN_NAMES[r.plan] || r.plan],
    sub?.status && ['Subscription', `${sub.status}, ${sub.cancelAtPeriodEnd ? 'ends' : 'renews'} ${day(sub.currentPeriodEnd)}`],
    ['Owner', r.owner || 'none'],
    r.transactionId && ['Payment', String(r.transactionId)],
    r.sessionId && ['Open session', String(r.sessionId)],
    ['Browser', r.userAgent || 'unknown'],
    ['Sent', new Date(r.createdAt || Date.now()).toISOString()],
  ].filter(Boolean);
  return compose(`[${SUPPORT_TOPICS[r.topic]}] Support request ${r.ref}`, [
    { quote: r.message },
    `Reply to this email to answer: your reply goes to ${r.email}.`,
    { details },
  ], { signed: false });
}

module.exports = {
  supportRequest,
  verifyEmail,
  alreadyRegistered,
  resetPassword,
  confirmNewEmail,
  emailInUse,
  emailChanged,
  passwordChanged,
  accountDeleted,
  spendAlert,
};
