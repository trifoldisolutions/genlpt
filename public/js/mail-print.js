// The page to print an email from (views/admin/mail-print.ejs): the browser's print dialog, once its font is in
addEventListener('load', () => document.fonts.ready.then(() => print()));
