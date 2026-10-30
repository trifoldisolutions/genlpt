const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeLetters, initials, cleanWordList, cleanTitle } = require('../services/acronym/normalize');
const { buildPool, groupPool, coverWord, generateEngineCandidates, candidateFromIds, pronounceability } = require('../services/acronym/engine');

const w = (id, branch, text) => ({ _id: id, branch, text });

test('normalization strips accents and keeps A–Z', () => {
  assert.equal(normalizeLetters('Équipe'), 'EQUIPE');
  assert.equal(initials('Équipe').one, 'E');
  assert.equal(initials('Flux vidéo').one, 'F');
  assert.equal(initials('Flux vidéo').two, 'FL');
  assert.equal(normalizeLetters('Œuvre'), 'OEUVRE');
});

test('initials skip leading connectors; a connector never gives the letter', () => {
  assert.equal(initials("L'Équipe").one, 'E');
  assert.equal(initials('La Tribu').one, 'T');
  assert.equal(initials('The Hub', 'en').one, 'H');
  assert.equal(initials('Del Sur', 'es').one, 'S');
  assert.equal(initials('Para', 'es').one, null);
  assert.equal(initials('Niño', 'es').two, 'NI');
  assert.equal(initials('Nan Lekòl', 'ht').one, 'L');
  assert.equal(initials('Pou', 'ht').one, null);
  assert.equal(initials('Pour', 'fr').one, null);
  assert.equal(initials('Pour', 'en').one, 'P'); // an English verb, not a connector
  assert.equal(initials('Sûr').one, 'S'); // "sûr" is not "sur"
  assert.deepEqual(buildPool([w('a', 'who', 'De'), w('b', 'who', 'Des Liens')]).map((p) => p.one), ['L']);
});

test('cleanWordList dedupes case/accent-insensitively and drops junk', () => {
  const out = cleanWordList(['équipe', 'Equipe', '  ', 'x'.repeat(61), 'Brigade', 42], new Set(['brigade']));
  assert.deepEqual(out, ['Équipe']);
  assert.deepEqual(cleanWordList(['Wear_down', 'Local_AI']), ['Wear down', 'Local AI']);
});

test('cleanTitle keeps at most 5 words and never ends on a connector or punctuation', () => {
  assert.equal(cleanTitle('« brigade d’entraide scolaire ».'), 'Brigade d’entraide scolaire');
  assert.equal(cleanTitle('Brigade de soutien scolaire pour les familles'), 'Brigade de soutien scolaire');
  assert.equal(cleanTitle('"Neighborhood Tutoring Crew!"', 'en'), 'Neighborhood Tutoring Crew');
  assert.equal(cleanTitle('Tools for the', 'en'), 'Tools');
  assert.equal(cleanTitle('  …  '), '');
  assert.equal(cleanTitle(42), '');
});

test('coverage: a word cannot be reused', () => {
  const groups = groupPool(buildPool([w('a', 'who', 'Alpha'), w('b', 'what', 'Bravo')]));
  assert.equal(coverWord('ABA', groups), null);
  assert.ok(coverWord('AB', groups));
});

test('coverage: left-to-right order is respected', () => {
  const groups = groupPool(buildPool([w('s', 'why', 'Secours'), w('e', 'who', 'Escouade'), w('r', 'what', 'Recherche')]));
  const found = coverWord('SER', groups);
  assert.deepEqual(found.parts.map((p) => p.wordId), ['s', 'e', 'r']);
  assert.deepEqual(found.parts.map((p) => p.letters), ['S', 'E', 'R']);
});

test('coverage: 2-letter chunks only when enabled', () => {
  const groups = groupPool(buildPool([w('d', 'how', 'Drone'), w('a', 'why', 'Aide')]));
  assert.equal(coverWord('DRA', groups, { allowChunks: false }), null);
  const found = coverWord('DRA', groups, { allowChunks: true });
  assert.deepEqual(found.parts.map((p) => p.letters), ['DR', 'A']);
});

test('coverage prefers the assignment covering more branches', () => {
  const words = [
    w('s1', 'who', 'Section'),
    w('a1', 'who', 'Agence'),
    w('s2', 'why', 'Secours'),
    w('a2', 'how', 'Aérien'),
  ];
  const found = coverWord('SA', groupPool(buildPool(words)));
  assert.equal(found.branchCoverage, 2);
  assert.notEqual(found.parts[0].branch, found.parts[1].branch);
});

test('engine respects the length range and only returns coverable words', () => {
  const words = [w('s', 'why', 'Secours'), w('e', 'who', 'Escouade'), w('r', 'what', 'Reconnaissance'), w('a', 'how', 'Aérien')];
  const dictionary = ['SERA', 'SE', 'ERAS', 'SERAS', 'RASE', 'ZERO'];
  const out = generateEngineCandidates({ words, dictionary, minLength: 3, maxLength: 4 });
  const letters = out.map((c) => c.letters).sort();
  assert.deepEqual(letters, ['ERAS', 'RASE', 'SERA']);
  for (const c of out) {
    assert.equal(c.parts.map((p) => p.letters).join(''), c.letters);
    assert.equal(new Set(c.parts.map((p) => p.wordId)).size, c.parts.length);
    assert.equal(c.branchCoverage, 4);
  }
});

test('LLM id validation rejects unknown and duplicate ids', () => {
  const idMap = new Map([
    ['w1', w('s', 'why', 'Secours')],
    ['w2', w('e', 'who', 'Escouade')],
    ['w3', w('r', 'what', 'Recherche')],
  ]);
  assert.equal(candidateFromIds(['w1', 'w9', 'w3'], idMap), null);
  assert.equal(candidateFromIds(['w1', 'w1', 'w3'], idMap), null);
  assert.equal(candidateFromIds(['w1', 'w2'], idMap, { minLength: 3, maxLength: 6 }), null);
  const ok = candidateFromIds(['w1', 'w2', 'w3'], idMap);
  assert.equal(ok.letters, 'SER');
  assert.equal(ok.branchCoverage, 3);
});

test('maxPerBranch: never two words from the same branch', () => {
  const words = [
    w('e', 'who', 'Escadre'),
    w('t', 'who', 'Troupe'),
    w('o', 'what', 'Observation'),
    w('r', 'what', 'Repérage'),
    w('a', 'how', 'Aérien'),
  ];
  const groups = groupPool(buildPool(words));
  assert.equal(coverWord('ETA', groups, { maxPerBranch: 1 }), null); // E + T both "who"
  assert.equal(coverWord('ORA', groups, { maxPerBranch: 1 }), null); // O + R both "what"
  assert.ok(coverWord('ETA', groups, { maxPerBranch: 2 }));
  const ok = coverWord('ORE', groups, { maxPerBranch: 1 });
  assert.equal(ok, null);
  const out = generateEngineCandidates({ words, dictionary: ['ETA', 'OTA', 'TOA', 'ROTA'], minLength: 3, maxLength: 4, maxPerBranch: 1 });
  assert.deepEqual(out.map((c) => c.letters).sort(), ['OTA', 'TOA']);
  for (const c of out) assert.equal(new Set(c.parts.map((p) => p.branch)).size, c.parts.length);
});

test('maxPerBranch: LLM ids from the same branch are rejected', () => {
  const idMap = new Map([
    ['w1', w('e', 'who', 'Escadre')],
    ['w2', w('t', 'who', 'Troupe')],
    ['w3', w('a', 'how', 'Aérien')],
  ]);
  assert.equal(candidateFromIds(['w1', 'w2', 'w3'], idMap, { maxPerBranch: 1 }), null);
  assert.ok(candidateFromIds(['w1', 'w2', 'w3'], idMap, { maxPerBranch: 2 }));
});

test('the same word from two branches is used once per acronym', () => {
  const words = [w('l1', 'who', 'Lien'), w('o', 'what', 'Outil'), w('l2', 'how', 'Lien'), w('r', 'why', 'Rappel')];
  const out = generateEngineCandidates({ words, dictionary: ['LOL', 'LOR'], minLength: 3, maxLength: 3 });
  assert.deepEqual(out.map((c) => c.letters), ['LOR']);
  const idMap = new Map(words.map((x, i) => [`w${i + 1}`, x]));
  assert.equal(candidateFromIds(['w1', 'w2', 'w3'], idMap), null);
});

test('pronounceability favours alternation', () => {
  assert.ok(pronounceability('SERA') > pronounceability('SRTX'));
});
