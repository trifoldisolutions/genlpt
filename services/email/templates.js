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
// secondary links. The text version turns every link into "label: url".
function compose(subject, blocks) {
  const text = [
    ...blocks.map((b) => {
      if (typeof b === 'string') return b;
      if (b.button) return `${b.button}: ${b.url}`;
      return b.links.map(([label, url]) => `${label}: ${url}`).join('\n');
    }),
    `The ${appName} team`,
  ].join('\n\n');

  const body = blocks.map((b) => {
    if (typeof b === 'string') return `<p style="${P}">${esc(b)}</p>`;
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
<p style="margin:24px 0 0;font-size:15px;line-height:1.55;color:#27272a;">The ${esc(appName)} team</p>
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
// of DAILY_SPEND (config/limits.js). line: 'warning', 'guest' or 'free'.
function spendAlert({ line, cost, byPlan, limits }) {
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
  return compose(subject, [
    `Today's AI spend is ${usd(cost)} since midnight UTC. ${next}`,
    `By plan: guests ${usd(byPlan.guest)}, free accounts ${usd(byPlan.free)}, paid accounts ${usd(byPlan.paid)}.`,
    'These lines are DAILY_SPEND in config/limits.js.',
  ]);
}

module.exports = {
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
