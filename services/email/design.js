// How every email looks, the account emails (templates.js) and the team mailbox's (Admin → Mail) alike: the one place to
// change it. Email apps ignore most stylesheets, so each element carries its styles inline, from here.

const brand = require('../../config/brand');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const FONT = "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const TEXT = 'font-size:15px;line-height:1.55;color:#27272a;';
const STYLE = {
  text: TEXT,
  paragraph: `margin:0 0 16px;${TEXT}`,
  link: 'color:#c11562;text-decoration:underline;',
  list: `margin:0 0 16px;padding-left:24px;${TEXT}`,
  quote: 'white-space:pre-wrap;border-left:3px solid #e4e4e7;padding-left:12px;',
  small: 'margin:0 0 16px;font-size:13px;line-height:1.5;color:#71717a;',
  button: 'display:inline-block;background:#de247d;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:11px 20px;border-radius:6px;',
};

// The page around what an email says: the card, with the brand's name on top
function shell(body) {
  return `<!doctype html>
<html lang="en">
<body style="margin:0;padding:24px 16px;background:#fafafa;font-family:${FONT};">
<div style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #e4e4e7;border-radius:6px;padding:28px 24px;">
<p style="margin:0 0 24px;font-size:18px;font-weight:700;color:#18181b;">${esc(brand.appName)}</p>
${body}
</div>
</body>
</html>`;
}

module.exports = { esc, STYLE, shell };
