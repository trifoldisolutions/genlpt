const test = require('node:test');
const assert = require('node:assert/strict');
const { rules, strength, personalWords } = require('../public/js/password');
const { PASSWORD_MIN_EACH } = require('../config/limits');

const options = { each: PASSWORD_MIN_EACH };
const unmet = (pw) => rules(pw, options).filter((r) => !r.met).map((r) => r.rule);

test('new passwords: 3 each of lowercase, uppercase, numbers and special characters', () => {
  assert.deepEqual(PASSWORD_MIN_EACH, { lower: 3, upper: 3, digit: 3, symbol: 3 });
  assert.deepEqual(unmet(''), ['lower', 'upper', 'digit', 'symbol']);
  assert.deepEqual(unmet('Pebble-Rug-CANYON-742!'), []);
  assert.deepEqual(unmet('pebble rug canyon'), ['upper', 'digit', 'symbol'], 'spaces aren’t special characters');
  assert.deepEqual(unmet('Ab!c@d#12E3xyz'), ['upper'], '2 uppercase is one short');
  assert.deepEqual(unmet('Éléphant!ÉTÉ#2026$'), [], 'accented letters count as letters, in their case');
  assert.deepEqual(rules('Ab1!', options)[0], { rule: 'lower', need: 3, have: 1, met: false });
});

test('new passwords: the kinds don’t overlap, so meeting them all makes 12 characters', () => {
  const shortest = 'abcABC123!@#';
  assert.deepEqual(unmet(shortest), []);
  assert.equal(shortest.length, Object.values(PASSWORD_MIN_EACH).reduce((a, b) => a + b));
  for (let i = 0; i < shortest.length; i++) {
    assert.notDeepEqual(unmet(shortest.slice(0, i) + shortest.slice(i + 1)), [], 'one character fewer breaks a rule');
  }
});

test('password strength: nothing until it meets the rules, then length counts most', () => {
  assert.equal(strength('', options), null);
  assert.equal(strength('Ab1!', options), 0);
  assert.equal(strength('Rug!Can#YON$742', options), 3, '15: good');
  assert.equal(strength('Pebble-Rug-CANYON-742!', options), 4, '22: strong');
});

test('password strength: common passwords, runs and repeats are weak, even when they meet the rules', () => {
  for (const pw of ['Password!!!123ABC', 'Motdepasse#2026XYZ!!', 'QWErty!!!123', 'ABCdef!!!789', 'ABCabc123!@#']) {
    assert.deepEqual(unmet(pw), [], `${pw} meets the rules`);
    assert.equal(strength(pw, options), 1, pw);
  }
  assert.equal(strength('aB3$aB3$aB3$', options), 1, 'the same four characters over and over');
});

test('password strength: the person’s own name or email is weak; their email’s domain isn’t theirs', () => {
  const personal = personalWords('Ada Lovelace', 'ada.lovelace@example.com');
  assert.deepEqual(personal, ['ada', 'lovelace', 'ada', 'lovelace']);
  assert.equal(strength('LOVElace!!!2026', { ...options, personal }), 1);
  assert.equal(strength('Rug!Can#YON$742', { ...options, personal }), 3);
  assert.deepEqual(personalWords('Jo', '', undefined), [], 'too short to matter');
});
