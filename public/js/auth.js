// Auth page: password reveal, placeholder submit, and the acronym showcase.

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

// Accounts aren't live yet: keep native validation, then explain instead of posting
$('#auth-form').addEventListener('submit', (e) => {
  e.preventDefault();
  $('#auth-note').hidden = false;
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
