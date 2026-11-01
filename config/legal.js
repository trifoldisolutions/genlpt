// The privacy policy and terms of service (views/public/legal/<doc>.<lang>.ejs), in English and French. The numbers
// they quote come from config/limits.js and the models, so the pages follow them; these are the rest.

module.exports = {
  // The date both documents show, in each language: change it with any change to what they say
  UPDATED: '2026-11-01',
  // Who may use GenLPT (the terms): GDPR's default age of consent, above Québec's 14, so no parent's consent is needed
  MIN_AGE: 16,
  // How long Railway keeps the server logs (IP addresses). Its docs say 30 days on Pro; its staff say logs are
  // deleted after 90 on every plan. The policy says the longer one.
  SERVER_LOG_DAYS: 90,
  // Each document's address, by language. The footer, signup and Help center link to these.
  PATHS: {
    privacy: { en: '/privacy', fr: '/fr/confidentialite' },
    terms: { en: '/terms', fr: '/fr/conditions' },
  },
  TITLES: {
    privacy: { en: 'Privacy policy', fr: 'Politique de confidentialité' },
    terms: { en: 'Terms of service', fr: 'Conditions d’utilisation' },
  },
};
