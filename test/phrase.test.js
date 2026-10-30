const test = require('node:test');
const assert = require('node:assert/strict');
const { phraseParts, phraseText } = require('../services/acronym/phrase');
const { isConnector, splitTokens } = require('../services/acronym/normalize');
const { CONNECTOR_EXAMPLES } = require('../services/llm/prompts');

const parts = (...list) => list.map(([letters, text]) => ({ wordId: text, branch: 'who', text, letters }));
const RATP = parts(['R', 'Régie'], ['A', 'Autonomie'], ['T', 'Transport'], ['P', 'Paris']);
const OPUS = parts(['O', 'Outil'], ['P', 'Partage'], ['U', 'Unité'], ['S', 'Simplicité']);

test('a grammatical name keeps each word, reshaped, with connectors before it', () => {
  const out = phraseParts(RATP, 'Régie Autonome des Transports Parisiens');
  assert.deepEqual(out.map((p) => p.form), ['Régie', 'Autonome', 'Transports', 'Parisiens']);
  assert.deepEqual(out.map((p) => p.lead), ['', '', 'des', '']);
  assert.deepEqual(out.map((p) => p.letters), ['R', 'A', 'T', 'P']);
  assert.equal(out[1].text, 'Autonomie'); // the graph word is kept alongside its form
});

test('English name: FBI', () => {
  const FBI = parts(['F', 'Federation'], ['B', 'Bureau'], ['I', 'Investigate']);
  const out = phraseParts(FBI, 'Federal Bureau of Investigation', 'en');
  assert.deepEqual(out.map((p) => `${p.lead}|${p.form}`), ['|Federal', '|Bureau', 'of|Investigation']);
});

test('Spanish names: ONCE, MERCOSUR in chunks; a list or an enumeration is not a name', () => {
  const ONCE = parts(['O', 'Organización'], ['N', 'Nación'], ['C', 'Ciego'], ['E', 'España']);
  const out = phraseParts(ONCE, 'Organización Nacional de Ciegos Españoles', 'es');
  assert.deepEqual(out.map((p) => `${p.lead}|${p.form}`), ['|Organización', '|Nacional', 'de|Ciegos', '|Españoles']);
  const MERCOSUR = parts(['MER', 'Mercado'], ['CO', 'Común'], ['SUR', 'Sur']);
  assert.deepEqual(phraseParts(MERCOSUR, 'Mercado Común del Sur', 'es').map((p) => p.lead), ['', '', 'del']);
  assert.equal(phraseParts(ONCE, 'Organización Nacional Ciegos Españoles', 'es'), null);
  assert.equal(phraseParts(ONCE, 'Organización, Nación, Ciegos y España', 'es'), null);
  // "Para" is a connector: it can't carry the P
  assert.equal(phraseParts(parts(['O', 'Organización'], ['P', 'Proximidad']), 'Organización Para', 'es'), null);
});

test('Haitian Creole names: a noun chain is grammatical, an enumeration is not', () => {
  const AKA = parts(['A', 'Akademi'], ['K', 'Kreyòl'], ['A', 'Ayiti']);
  assert.deepEqual(phraseParts(AKA, 'Akademi Kreyòl Ayisyen', 'ht').map((p) => p.form), ['Akademi', 'Kreyòl', 'Ayisyen']);
  const KLEF = parts(['K', 'Kilti'], ['L', 'Lekti'], ['E', 'Echanj'], ['F', 'Fanmi']);
  assert.deepEqual(phraseParts(KLEF, 'Kilti Lekti ak Echanj nan Fanmi', 'ht').map((p) => p.lead), ['', '', 'ak', 'nan']);
  // A possessor follows its noun with no linking word: four nouns in a row pass in Creole, not in French
  assert.ok(phraseParts(KLEF, 'Kilti Lekti Echanj Fanmi', 'ht'));
  assert.equal(phraseParts(KLEF, 'Kilti Lekti Echanj Fanmi', 'fr'), null);
  assert.equal(phraseParts(KLEF, 'Kilti, Lekti, Echanj ak Fanmi', 'ht'), null);
  // "Men" (hand) and "San" (blood) are nouns too, so they can carry a letter
  assert.ok(phraseParts(parts(['M', 'Men'], ['S', 'San']), 'Men San', 'ht'));
});

test('a connector can never carry a letter', () => {
  // "Organisation Pour l'Unité Sociale": "Pour" would carry the P
  const withPour = parts(['O', 'Organisation'], ['P', 'Proximité'], ['U', 'Unité'], ['S', 'Social']);
  assert.equal(phraseParts(withPour, "Organisation Pour l'Unité Sociale"), null);
  const withOf = parts(['F', 'Federation'], ['O', 'Openness'], ['B', 'Bureau']);
  assert.equal(phraseParts(withOf, 'Federal of Bureau', 'en'), null);
});

test('elisions are connectors: only the word after carries the letter', () => {
  const out = phraseParts(OPUS, "Outil de Partage, d'Unité et de Simplicité");
  assert.deepEqual(out.map((p) => p.lead), ['', 'de', "d'", 'et de']);
  assert.equal(out[2].form, 'Unité');
  assert.equal(phraseText(out), "Outil de Partage, d'Unité et de Simplicité");
});

test('a keyword list or an enumeration is not a name', () => {
  assert.equal(phraseParts(OPUS, 'Outil Partage Unité Simplicité'), null);
  assert.equal(phraseParts(OPUS, 'Outil, Partage, Unité et Simplicité'), null);
  const HOME = parts(['H', 'Harmonie'], ['O', 'Outil'], ['M', 'Mission'], ['E', 'Événements']);
  assert.equal(phraseParts(HOME, 'Harmonie, Outil de Mission et Événements'), null); // "X, Y" enumeration
  assert.ok(phraseParts(HOME, "Harmonie de l'Outil pour Missions et Événements"));
  // two words can be a noun and its adjective; English stacks up to three nouns
  assert.ok(phraseParts(parts(['R', 'Régie'], ['A', 'Autonomie']), 'Régie Autonome'));
  assert.ok(phraseParts(parts(['I', 'International'], ['B', 'Business'], ['M', 'Machine']), 'International Business Machines', 'en'));
});

test('no word may be added or swapped in', () => {
  const ORIG = parts(['O', 'Origine'], ['P', 'Proximité'], ['U', 'Unicité'], ['S', 'Synthèse']);
  assert.ok(phraseParts(ORIG, "Origine Proche de l'Unicité Synthétique"));
  assert.equal(phraseParts(ORIG, 'Outil de Proximité Unique et Synthétique'), null); // Outil is not Origine
  assert.equal(phraseParts(OPUS, 'Outil de Partage Total, d’Unité et de Simplicité'), null); // extra word
  assert.equal(phraseParts(RATP, 'Régie Autonome des Transports'), null); // missing word
});

test('the name cannot end on a connector; quotes and a leading acronym are ignored', () => {
  assert.equal(phraseParts(RATP, 'Régie Autonome des Transports Parisiens de'), null);
  assert.equal(phraseParts(RATP, ['Régie', 'Autonome', 'des Transports', 'Parisiens']), null);
  const out = phraseParts(RATP, 'RATP : « Régie Autonome des Transports Parisiens »');
  assert.deepEqual(out.map((p) => p.lead), ['', '', 'des', '']);
});

test('a reshaped word must be spelled right; graph words used as is are not checked', () => {
  const dict = new Set(['BENEVOLES', 'LIEU', 'ORGANISATION']);
  const isWord = (w) => dict.has(w.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase());
  const LOB = parts(['L', 'Lieu'], ['O', 'Organisation'], ['B', 'Bénévole']);
  assert.ok(phraseParts(LOB, "Lieu d'Organisation des Bénévoles", 'fr', isWord));
  assert.equal(phraseParts(LOB, "Lieu d'Organisation des Bénovoles", 'fr', isWord), null);
  assert.ok(phraseParts(parts(['Z', 'Zorblax'], ['A', 'Aide']), "Zorblax d'Aide", 'fr', () => false));
});

test('multi-word graph words and 2-letter chunks', () => {
  const SNCF = parts(['S', 'Société'], ['N', 'Nation'], ['C', 'Chemin de fer'], ['F', 'France']);
  const out = phraseParts(SNCF, 'Société Nationale des Chemins de fer Français');
  assert.equal(out[2].form, 'Chemins de fer');
  assert.equal(out[2].lead, 'des');
  const chunk = parts(['DR', 'Drone'], ['A', 'Aide']);
  assert.ok(phraseParts(chunk, "Drones d'Aide"));
  assert.equal(phraseParts(chunk, "Dynamique d'Aide"), null);
});

test('connector lists: prompt examples are all accepted connectors, accents matter', () => {
  for (const [language, list] of Object.entries(CONNECTOR_EXAMPLES)) {
    for (const c of list.split(', ')) assert.ok(isConnector(c, language), `${language}: ${c}`);
  }
  assert.equal(isConnector('Sûr'), false);
  assert.equal(isConnector('Sur'), true);
  assert.deepEqual(splitTokens("l’Unité d'Aide"), ['l’', 'Unité', "d'", 'Aide']);
  assert.deepEqual(splitTokens("People's Hub", 'en'), ["People's", 'Hub']);
});

test('every session language has connectors and prompts; the client mirrors which ones have a word list', () => {
  const fs = require('fs');
  const path = require('path');
  const { LANGUAGES } = require('../models/BrainstormSession');
  const { QUESTIONS } = require('../services/llm/prompts');
  const { CONNECTORS } = require('../services/acronym/normalize');
  const dictionary = require('../services/acronym/dictionary');
  for (const l of LANGUAGES) assert.ok(CONNECTORS[l] && CONNECTOR_EXAMPLES[l] && QUESTIONS[l], l);
  const app = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  const mirrored = JSON.parse(app.match(/DICTIONARY_LANGUAGES = new Set\((\[.*?\])\)/)[1].replace(/'/g, '"'));
  assert.deepEqual(mirrored, LANGUAGES.filter(dictionary.has));
  assert.equal(dictionary.has('ht'), false);
});
