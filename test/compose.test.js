const test = require('node:test');
const assert = require('node:assert/strict');
const { candidateFromName, splitAcronym, chunkSource } = require('../services/acronym/compose');
const { conceptKey, cleanWordList } = require('../services/acronym/normalize');
const { candidateFromIds } = require('../services/acronym/engine');
const { composeNames } = require('../services/llm/prompts');

const w = (id, branch, text) => ({ _id: id, branch, text });
const idMap = new Map([
  ['w1', w('a', 'who', 'App')],
  ['w2', w('b', 'what', 'Acronyms')],
  ['w3', w('c', 'how', 'Keywords')],
  ['w4', w('d', 'why', 'Full Names')],
  ['w5', w('e', 'who', 'Tool')],
  ['w6', w('f', 'how', 'Mind Map')],
]);
const opts = { language: 'en', minLength: 2, maxLength: 8, maxPerBranch: 1 };

test('conceptKey: singular and plural are the same idea', () => {
  assert.equal(conceptKey('Acronyms'), conceptKey('Acronym'));
  assert.equal(conceptKey('Full Names'), conceptKey('Full Name'));
  assert.equal(conceptKey('Process'), 'process');
  assert.deepEqual(cleanWordList(['Acronyms', 'Keyword', 'Keywords'], new Set([conceptKey('Acronym')])), ['Keyword']);
  // an acronym can't use "Acronym" and "Acronyms" as two of its words
  const twins = new Map([['w1', w('a', 'who', 'Acronym')], ['w2', w('b', 'what', 'Acronyms')], ['w3', w('c', 'how', 'Tool')]]);
  assert.equal(candidateFromIds(['w1', 'w2', 'w3'], twins, { language: 'en', minLength: 1 }), null);
});

test('splitAcronym reads letters as the starts of the words, in order', () => {
  assert.deepEqual(splitAcronym('ACROKEY', ['ACRONYMS', 'KEYWORDS']), ['ACRO', 'KEY']);
  assert.deepEqual(splitAcronym('AK', ['ACRONYMS', 'KEYWORDS']), ['A', 'K']);
  assert.deepEqual(splitAcronym('NAMAP', ['NAMING', 'MAP']), ['NA', 'MAP']); // NAM + AP fails, so it backtracks
  assert.equal(splitAcronym('AKX', ['ACRONYMS', 'KEYWORDS']), null); // a letter no word gives
  assert.equal(splitAcronym('KA', ['ACRONYMS', 'KEYWORDS']), null); // wrong order
  assert.equal(chunkSource('Mind Maps'), 'MIND');
  assert.equal(chunkSource('Mots-clés'), 'MOTS');
});

test('a composed name becomes a candidate: initials by default', () => {
  const c = candidateFromName({ fullName: 'Acronyms from Keywords', ids: ['w2', 'w3'], acronym: 'ACROKEY' }, idMap, opts);
  assert.equal(c.letters, 'AK'); // chunks not allowed: the model's acronym is ignored
  assert.deepEqual(c.parts.map((p) => `${p.lead}|${p.form}|${p.letters}`), ['|Acronyms|A', 'from|Keywords|K']);
  assert.equal(c.source, 'llm');
});

test('with chunks allowed, the model\'s acronym is used when it splits into the words', () => {
  const allow = { ...opts, allowChunks: true };
  const c = candidateFromName({ fullName: 'Acronyms from Keywords', ids: ['w2', 'w3'], acronym: 'ACROKEY' }, idMap, allow);
  assert.equal(c.letters, 'ACROKEY');
  assert.deepEqual(c.parts.map((p) => p.letters), ['ACRO', 'KEY']);
  const bad = candidateFromName({ fullName: 'Acronyms from Keywords', ids: ['w2', 'w3'], acronym: 'AXK' }, idMap, allow);
  assert.equal(bad.letters, 'AK'); // an acronym that doesn't fit falls back to the initials
  const tooLong = candidateFromName({ fullName: 'Acronyms from Keywords', ids: ['w2', 'w3'], acronym: 'ACRONYMSKEY' }, idMap, allow);
  assert.equal(tooLong.letters, 'AK'); // 11 letters > maxLength 8: back to the initials
});

test('ids listed out of order are put in the order of the name', () => {
  const c = candidateFromName({ fullName: 'Tool for Full Names from Keywords', ids: ['w3', 'w5', 'w4'] }, idMap, opts);
  assert.equal(c.letters, 'TFK');
  assert.deepEqual(c.parts.map((p) => p.text), ['Tool', 'Full Names', 'Keywords']);
});

test('the phrase rules still apply to composed names', () => {
  const pick = (fullName, ids) => candidateFromName({ fullName, ids }, idMap, opts);
  assert.ok(pick('Mind Map of Acronyms for Full Names', ['w6', 'w2', 'w4']));
  assert.equal(pick('Mind Map Acronyms Full Names Tool', ['w6', 'w2', 'w4', 'w5']), null); // keyword list
  assert.equal(pick('App for Smart Keywords', ['w1', 'w3']), null); // "Smart" is not a selected word
  assert.equal(pick('App', ['w1']), null); // one word is not an acronym
  assert.equal(pick('App and Tool for Keywords', ['w1', 'w5', 'w3']), null); // two [Who] words with maxPerBranch 1
  assert.equal(pick('Keywords for the App', ['w3', 'w9']), null); // unknown id
});

test('the compose prompt asks for the words added since the last run, unless every word is new', () => {
  const base = { language: 'en', answers: {}, minLength: 3, maxLength: 6 };
  const idWords = [
    { id: 'w1', branch: 'who', text: 'App' },
    { id: 'w2', branch: 'what', text: 'Acronyms', fresh: true },
    { id: 'w3', branch: 'how', text: 'Keywords', fresh: true },
  ];
  const prompt = (words, language = 'en') => composeNames({ ...base, language, idWords: words }).user;
  assert.match(prompt(idWords), /Words w2, w3 were just added/);
  assert.match(prompt(idWords, 'fr'), /Les mots w2, w3 viennent/);
  assert.match(prompt(idWords, 'es'), /Las palabras w2, w3 se acaban/);
  assert.match(prompt(idWords, 'ht'), /Words w2, w3 were just added/);
  assert.match(prompt(idWords, 'ht'), /Haitian Creole phrase/);
  assert.doesNotMatch(prompt(idWords.map((w) => ({ ...w, fresh: false }))), /just added/); // no run yet, or nothing new
  assert.doesNotMatch(prompt(idWords.map((w) => ({ ...w, fresh: true }))), /just added/); // all new: every name uses them anyway
});
