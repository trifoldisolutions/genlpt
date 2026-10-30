// People's names, for the page and the server alike: each word starts with a capital, as it's typed (signup,
// settings → Account) and again when saved (middleware/auth.js cleanName), for a send without the script. Only
// first letters change: the rest stays as typed (McDonald, DeVito).
// A classic script: auth.js and app.js read NameCase as a global, and the server requires it.

const NameCase = (() => {
  // A lowercase letter that starts a word: at the start, or after a space or a hyphen (Jean-Pierre)
  const capitalize = (value) => value.replace(/(^|[\s-])(\p{Ll})/gu, (_, before, letter) => before + letter.toUpperCase());

  // Capitalizes input's words as they're typed, keeping the cursor where it was
  function watch(input) {
    input.addEventListener('input', (e) => {
      if (e.isComposing) return; // mid-word in an input method: its text isn't final yet
      const value = capitalize(input.value);
      if (value === input.value) return;
      const { selectionStart, selectionEnd } = input;
      input.value = value;
      input.setSelectionRange(selectionStart, selectionEnd);
    });
  }

  return { capitalize, watch };
})();

if (typeof module !== 'undefined') module.exports = NameCase;
