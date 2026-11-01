// Server-drawn pages (Admin → Mail): what the server has to say after a redirect ("Your email was sent.") comes as
// <template data-flash="ok|info|error">text</template> and shows as a toast once the page is in.
import { toast } from './toast.js';

document.querySelectorAll('template[data-flash]').forEach((note) => {
  toast(note.content.textContent.trim(), note.dataset.flash);
  note.remove();
});
