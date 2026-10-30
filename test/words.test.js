const test = require('node:test');
const assert = require('node:assert/strict');
const { wordDepth } = require('../models/BrainstormSession');
const { EXPAND_DEPTH } = require('../config/limits');

test('a word is as deep as the expansions above it; Expand stops at EXPAND_DEPTH', () => {
  const words = [
    { _id: 'a', text: 'Network', parentId: null },
    { _id: 'b', text: 'Grid', parentId: 'a' },
    { _id: 'c', text: 'Cells', parentId: 'b' },
    { _id: 'd', text: 'Mesh', parentId: 'a' },
  ];
  assert.deepEqual(words.map((w) => wordDepth(words, w)), [0, 1, 2, 1]);
  assert.equal(EXPAND_DEPTH, 2); // Network → Grid → Cells, and Cells can't be expanded
  assert.equal(wordDepth(words, { _id: 'x', parentId: 'gone' }), 0); // a parent that isn't there: a branch word
  const loop = [{ _id: 'p', parentId: 'q' }, { _id: 'q', parentId: 'p' }];
  assert.ok(wordDepth(loop, loop[0]) <= loop.length); // bad data can't hang it
});
