// The message box of the mailbox's form (views/admin/mail.ejs): a small editor over the <textarea>, which stays what's
// sent, holding the editor's HTML. The server keeps only a few plain tags of it and makes the plain-text version
// (cleanNote in services/mail.js). What's pasted comes in as plain text, so what's copied from elsewhere brings nothing
// hidden along. execCommand is the browsers' only editing command for this, and all of them keep it.

const WEB_OR_MAIL = /^(https?:|mailto:)/i;
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

// What was typed as a link's address: where it goes, or null if it's nowhere a link can go
function linkTarget(typed) {
  const value = typed.trim();
  if (WEB_OR_MAIL.test(value)) return value;
  if (ANY_SCHEME.test(value)) return null;
  return /^[^\s/@]+@[^\s/@]+\.[^\s/@]+$/.test(value) ? `mailto:${value}` : `https://${value}`;
}

export function messageEditor({ textarea, format, box, editor, onFiles, onChange }) {
  const linkRow = box.querySelector('[data-link-row]');
  const linkInput = linkRow.querySelector('input');
  const linkRemove = linkRow.querySelector('[data-link-remove]');
  const linkButton = box.querySelector('[data-link]');
  let savedRange = null;
  let savedLink = null;

  // The script's here: the editor takes over from the plain box, and says what it's sending
  format.value = 'html';
  textarea.hidden = true;
  textarea.required = false;
  box.hidden = false;
  document.execCommand('defaultParagraphSeparator', false, 'div');
  document.execCommand('styleWithCSS', false, false);

  const isEmpty = () => !editor.textContent.trim();
  const sync = () => {
    textarea.value = isEmpty() ? '' : editor.innerHTML;
    onChange();
  };

  function set(html) {
    editor.innerHTML = html || '';
    sync();
  }

  function caretAtEnd() {
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function focus() {
    editor.focus();
    caretAtEnd();
  }

  const inEditor = (node) => !!node && editor.contains(node);
  const linkAt = (node) => {
    const el = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    const link = el?.closest?.('a');
    return link && editor.contains(link) ? link : null;
  };

  // Each button shows whether what's selected already has it
  function showState() {
    box.querySelectorAll('[data-format]').forEach((button) => {
      button.setAttribute('aria-pressed', String(document.queryCommandState(button.dataset.format)));
    });
    linkButton.setAttribute('aria-pressed', String(!!linkAt(getSelection().anchorNode)));
  }
  // Where the caret was last in it, to go back to (resume)
  let lastRange = null;
  document.addEventListener('selectionchange', () => {
    const selection = getSelection();
    if (!inEditor(selection.anchorNode)) return;
    showState();
    if (selection.rangeCount) lastRange = selection.getRangeAt(0).cloneRange();
  });

  // The buttons don't take the focus, so what's selected stays selected
  box.querySelectorAll('[data-format], [data-link]').forEach((button) => {
    button.addEventListener('mousedown', (e) => e.preventDefault());
  });
  box.querySelectorAll('[data-format]').forEach((button) => {
    button.addEventListener('click', () => {
      if (!inEditor(getSelection().anchorNode)) focus();
      document.execCommand(button.dataset.format);
      showState();
    });
  });

  function closeLinkRow() {
    linkRow.hidden = true;
    linkInput.classList.remove('border-red-500');
    linkInput.value = '';
    savedRange = null;
    savedLink = null;
  }

  function restoreSelection() {
    editor.focus();
    const selection = getSelection();
    selection.removeAllRanges();
    if (savedRange) selection.addRange(savedRange);
    else caretAtEnd();
  }

  linkButton.addEventListener('click', () => {
    if (!linkRow.hidden) return closeLinkRow();
    const selection = getSelection();
    const inside = selection.rangeCount && inEditor(selection.anchorNode);
    savedRange = inside ? selection.getRangeAt(0).cloneRange() : null;
    savedLink = inside ? linkAt(selection.anchorNode) : null;
    linkInput.value = savedLink?.getAttribute('href') || '';
    linkRemove.hidden = !savedLink;
    linkRow.hidden = false;
    linkInput.focus();
  });

  function applyLink() {
    const target = linkTarget(linkInput.value);
    if (!linkInput.value.trim()) return closeLinkRow();
    if (!target) {
      linkInput.classList.add('border-red-500');
      return linkInput.focus();
    }
    restoreSelection();
    const selection = getSelection();
    if (savedLink) {
      // Changing a link: all of it, wherever the caret was in it
      const range = document.createRange();
      range.selectNodeContents(savedLink);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('createLink', false, target);
    } else if (selection.isCollapsed) {
      // Nothing selected: the address is what it says
      const link = document.createElement('a');
      link.href = target;
      link.textContent = target.replace(/^mailto:/i, '');
      document.execCommand('insertHTML', false, link.outerHTML);
    } else {
      document.execCommand('createLink', false, target);
    }
    closeLinkRow();
    showState();
  }

  function removeLink() {
    restoreSelection();
    if (savedLink) {
      const range = document.createRange();
      range.selectNodeContents(savedLink);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    document.execCommand('unlink');
    closeLinkRow();
    showState();
  }

  linkRow.querySelector('[data-link-apply]').addEventListener('click', applyLink);
  linkRemove.addEventListener('click', removeLink);
  linkRow.querySelector('[data-link-cancel]').addEventListener('click', () => {
    restoreSelection();
    closeLinkRow();
  });
  linkInput.addEventListener('input', () => linkInput.classList.remove('border-red-500'));
  linkInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault(); // not the form's Send
      applyLink();
    } else if (e.key === 'Escape') {
      restoreSelection();
      closeLinkRow();
    }
  });

  editor.addEventListener('input', sync);
  // A pasted file attaches; anything else comes in as plain text
  editor.addEventListener('paste', (e) => {
    e.preventDefault();
    if (e.clipboardData.files.length) return onFiles(e.clipboardData.files);
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  });

  // Back to writing where the caret was, after the quote button's rows (mail-templates.js); at the end when what it was
  // in is gone
  function resume() {
    if (document.activeElement === editor) return;
    editor.focus();
    if (!lastRange || !editor.contains(lastRange.startContainer)) return caretAtEnd();
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(lastRange);
  }

  return { set, focus, isEmpty, resume };
}
