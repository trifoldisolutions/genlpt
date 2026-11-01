// Single source of truth for the product name.
// GenLPT = Generator of Logical Phrases from Terms, read "Gen-LPT" (like ChatGPT).
module.exports = {
  appName: 'GenLPT',
  tagline: 'Acronym Maker Tool',
  // The studio that built GenLPT. It doesn't run it: GenLPT does (operator).
  company: { name: 'Trifoldi Solutions', url: 'https://trifoldi.com' },
  // GenLPT runs itself, as a U.S. business not yet incorporated: the "we" of the privacy policy and terms.
  // state: the U.S. state it's based in (the terms' governing law), in English and in French with its preposition,
  // which changes with the state (de Floride, du Texas); address: its postal address (the legal notice). Either one
  // left null is left out of the pages.
  operator: {
    state: { en: 'Florida', fr: 'de Floride' },
    address: '7901 4th St N #10823, St. Petersburg, FL 33702',
  },
  // Shown to people (Settings → Help center, the account pages). Help center's form doesn't send here: it sends to
  // SUPPORT_INBOX (services/support.js)
  supportEmail: 'support@genlpt.com',
  // Privacy requests and the person in charge of personal information (the privacy policy)
  privacyEmail: 'privacy@genlpt.com',
};
