// New passwords, for the page and the server alike: the rules one must meet (config/limits.js PASSWORD_MIN_EACH;
// middleware/auth.js passwordProblem enforces them), and how strong it looks once it does, for the bar under a new
// password's field (signup, reset, settings → Account). The strength is a guide only: length counts most, and a
// common password, the person's own name or email, or mostly keyboard or alphabet runs is weak.
// A classic script: auth.js and app.js read PasswordStrength as a global, and the server and tests require() it
// (they never call watch, the only part that needs a page).

const PasswordStrength = (() => {
  // The kinds of characters the rules count (any alphabet's letters); symbol: punctuation and symbols, not spaces
  const KINDS = {
    lower: /\p{Ll}/gu,
    upper: /\p{Lu}/gu,
    digit: /\p{Nd}/gu,
    symbol: /[^\p{L}\p{N}\s]/gu,
  };
  // Found in every leaked-password list (English and French), or this app's own name
  const COMMON = ['password', 'passw0rd', 'motdepasse', 'azerty', 'qwerty', 'letmein', 'welcome', 'bienvenue', 'iloveyou',
    'jetaime', 'admin', 'monkey', 'dragon', 'football', 'soleil', 'abc123', '123456', '111111', 'genlpt'];
  // Neighbors on a keyboard row (QWERTY and AZERTY), or in counting order
  const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', 'azertyuiop', 'qsdfghjklm', 'wxcvbn', '1234567890', 'abcdefghijklmnopqrstuvwxyz'];

  const count = (password, kind) => (password.match(KINDS[kind]) || []).length;

  // Each rule, in order: { rule: a kind, need, have, met }. No length rule: the kinds don't overlap, so meeting them
  // all makes the length (3 of each of the 4 kinds: 12 characters at least)
  function rules(password, { each }) {
    return Object.entries(each).map(([kind, need]) => {
      const have = count(password, kind);
      return { rule: kind, need, have, met: have >= need };
    });
  }

  const neighbors = (a, b) => a === b || ROWS.some((row) => {
    const i = row.indexOf(a);
    return i > -1 && (row[i + 1] === b || row[i - 1] === b);
  });

  // Share of characters that only repeat or continue the one before (aaaa, 1234, qwerty, dcba)
  function predictable(lower) {
    let n = 0;
    for (let i = 1; i < lower.length; i++) if (neighbors(lower[i - 1], lower[i])) n++;
    return lower.length > 1 ? n / (lower.length - 1) : 0;
  }

  // The words of someone's name and email address that a password shouldn't contain (3 letters or more). Of an
  // email, only what's before the @: the domain's words (gmail, com) are everyone's.
  function personalWords(...values) {
    return values
      .flatMap((v) => String(v || '').toLowerCase().split('@')[0].split(/[^\p{L}\p{N}]+/u))
      .filter((w) => w.length >= 3);
  }

  // null for nothing typed; 0 while a rule isn't met; then 1 weak, 2 fair, 3 good, 4 strong
  function strength(password, { each, personal = [] }) {
    if (!password) return null;
    if (rules(password, { each }).some((r) => !r.met)) return 0;
    const lower = password.toLowerCase();
    if (COMMON.some((word) => lower.includes(word)) || personal.some((word) => lower.includes(word))) return 1;
    if (predictable(lower) >= 0.5) return 1;
    let level = password.length >= 20 ? 4 : password.length >= 16 ? 3 : 2;
    if (Object.keys(KINDS).every((kind) => count(password, kind))) level += 1;
    if (new Set(password).size <= password.length / 3) level -= 2; // the same few characters over and over
    return Math.max(1, Math.min(4, level));
  }

  const FILL = [null, 'bg-red-500', 'bg-amber-500', 'bg-emerald-500', 'bg-emerald-600'];
  const TEXT = [null, 'text-red-700', 'text-amber-700', 'text-emerald-700', 'text-emerald-700'];

  // A new password's live checks (views/app/auth/_password-checks.ejs) as it's typed into input: each rule ticks once
  // met, and the form's submit button stays disabled until they all are; then a bar shows how strong it looks, with a
  // tip while it's weak or fair. The form's name and email (or username) fields count against it. Returns the update,
  // to run again after the field is changed by a script.
  function watch(checks, input) {
    const { form } = input;
    const submit = form.querySelector('button[type="submit"]');
    const options = { each: JSON.parse(checks.dataset.each) };
    const labels = JSON.parse(checks.dataset.labels);
    const items = Object.fromEntries([...checks.querySelectorAll('[data-rule]')].map((li) => [li.dataset.rule, li]));
    const bar = checks.querySelector('[data-strength]');
    const segments = [...bar.querySelectorAll('[aria-hidden] > span')];
    const label = checks.querySelector('[data-strength-label]');
    const tip = checks.querySelector('[data-strength-tip]');
    const field = (name) => form.elements.namedItem(name)?.value;

    const update = () => {
      const all = rules(input.value, options);
      // Each rule ticks once met; on the way there it shows how many so far (2/3), so every key counts visibly
      for (const { rule, need, have, met } of all) {
        items[rule].classList.toggle('text-emerald-700', met);
        items[rule].querySelector('iconify-icon').setAttribute('icon', met ? 'boxicons:check-circle' : 'boxicons:circle');
        const counter = items[rule].querySelector('[data-count]');
        counter.hidden = met || !have;
        counter.textContent = `${have}/${need}`;
      }
      const allMet = all.every((r) => r.met);
      submit.disabled = !allMet;
      // The browser's own check holds the form too, for a send that skips the button (signup's bot check sends it itself)
      input.setCustomValidity(input.value && !allMet ? checks.dataset.unmet : '');
      const personal = personalWords(field('name'), field('email') || field('username'));
      const level = strength(input.value, { ...options, personal });
      bar.hidden = !level;
      tip.hidden = !(level === 1 || level === 2);
      if (!level) return;
      segments.forEach((s, i) => { s.className = `h-1 rounded-full ${i < level ? FILL[level] : 'bg-zinc-200'}`; });
      label.className = `w-16 shrink-0 text-right text-sm font-medium ${TEXT[level]}`;
      label.textContent = labels[level];
    };

    checks.querySelectorAll('[data-rule] iconify-icon').forEach((icon) => { icon.hidden = false; });
    input.addEventListener('input', update);
    ['name', 'email'].forEach((name) => form.elements.namedItem(name)?.addEventListener('input', update));
    // Back to the page from the next one: auth.js's data-busy re-enables the button first, so this runs after it
    window.addEventListener('pageshow', (e) => { if (e.persisted) setTimeout(update); });
    update();
    return update;
  }

  return { rules, strength, personalWords, watch };
})();

if (typeof module !== 'undefined') module.exports = PasswordStrength;
