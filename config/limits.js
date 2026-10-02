// Answer length limits for the four "Describe" questions (shared with the client via <body> data attributes).
// min counts characters excluding whitespace; max counts every character (matches the textarea maxlength).
const ANSWER_MIN_CHARS = 100;
const ANSWER_MAX_CHARS = 500;

const answerLength = (value) => String(value || '').replace(/\s/g, '').length;

module.exports = { ANSWER_MIN_CHARS, ANSWER_MAX_CHARS, answerLength };
