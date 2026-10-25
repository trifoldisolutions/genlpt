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

module.exports = { verifyEmail, alreadyRegistered, resetPassword };
