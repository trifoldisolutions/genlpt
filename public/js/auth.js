// Account pages: password reveal, busy submit buttons, "Forgot password?" link, and the acronym showcase.

const $ = (sel, root = document) => root.querySelector(sel);

document.querySelectorAll('[data-reveal]').forEach((btn) => {
  const input = document.getElementById(btn.getAttribute('aria-controls'));
  btn.addEventListener('click', () => {
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    btn.setAttribute('aria-pressed', String(reveal));
    btn.querySelector('iconify-icon').setAttribute('icon', reveal ? 'boxicons:eye-slash' : 'boxicons:eye');
  });
});

// Forms with data-busy post normally; meanwhile the submit button shows a spinner and can't be pressed twice.
// The spinner takes the button's icon's place, or goes before its label when it has none.
document.querySelectorAll('form[data-busy]').forEach((form) => {
  const submit = $('button[type="submit"]', form);
  const submitIcon = $('iconify-icon', submit);
  const busySpinner = Object.assign(document.createElement('span'), {
    className: 'inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent',
  });
  busySpinner.setAttribute('aria-hidden', 'true');

  const setBusy = (busy) => {
    submit.disabled = busy;
    submit.setAttribute('aria-busy', String(busy));
    if (submitIcon) (busy ? submitIcon : busySpinner).replaceWith(busy ? busySpinner : submitIcon);
    else if (busy) submit.prepend(busySpinner);
    else busySpinner.remove();
  };

  form.addEventListener('submit', () => setBusy(true));
  // Coming back with the Back button restores the page as it was left: busy
  window.addEventListener('pageshow', (e) => { if (e.persisted && submit.disabled) setBusy(false); });
});

// "Continue with Google" isn't built yet: it only says so
$('[data-google]')?.addEventListener('click', () => { $('#google-note').hidden = false; });

// "Forgot password?" brings along the email typed so far
$('[data-forgot]')?.addEventListener('click', (e) => {
  const email = $('input[name="email"]')?.value.trim();
  if (email) e.currentTarget.href = `/app/forgot?email=${encodeURIComponent(email)}`;
});

// Showcase: cycle the example acronyms, replaying the CSS entrance each time
const showcase = $('#showcase');
const examples = JSON.parse(showcase.dataset.examples);
const words = [...showcase.querySelectorAll('[data-word]')];
const letters = [...showcase.querySelectorAll('[data-letter]')];
const expansion = $('[data-expansion]', showcase);
const HOLD = 4800;
const LEAVE = 400;
let current = 0;

function fill(example) {
  example.forEach((word, i) => {
    const [initial, rest] = words[i].children;
    initial.textContent = word[0];
    rest.textContent = word.slice(1);
    letters[i].textContent = word[0];
  });
  expansion.textContent = example.join(' ');
}

setInterval(() => {
  showcase.classList.add('leaving');
  setTimeout(() => {
    current = (current + 1) % examples.length;
    fill(examples[current]);
    showcase.classList.remove('leaving', 'play');
    void showcase.offsetWidth; // restart the animations
    showcase.classList.add('play');
  }, LEAVE);
}, HOLD);
