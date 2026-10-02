const mongoose = require('mongoose');
const { ANSWER_MAX_CHARS } = require('../config/limits');

const { Schema } = mongoose;

const BRANCHES = ['who', 'what', 'how', 'why'];
// Who set the title: 'auto' (derived from the "who" answer), 'ai' (suggested on Generate words), 'user'.
const TITLE_SOURCES = ['auto', 'ai', 'user'];
const MAX_WORDS = 400;
const MAX_ACRONYMS = 500;

const WordSchema = new Schema(
  {
    branch: { type: String, enum: BRANCHES, required: true },
    text: { type: String, required: true, trim: true, maxlength: 60 },
    selected: { type: Boolean, default: true },
    source: { type: String, enum: ['llm', 'user'], default: 'llm' },
    parentId: { type: Schema.Types.ObjectId, default: null }, // another word's _id, for expanded child words
  },
  { timestamps: true }
);

const AcronymPartSchema = new Schema(
  {
    wordId: { type: Schema.Types.ObjectId, required: true },
    text: String, // snapshot of the word text at generation time
    branch: String,
    letters: String, // the letter(s) this word contributes, e.g. "S" or "DR"
    lead: { type: String, default: '' }, // connectors before the word in the expansion, e.g. "des"
    form: { type: String, default: '' }, // the word as written in the expansion, e.g. "Autonome" for "Autonomie"
  },
  { _id: false }
);

const AcronymSchema = new Schema(
  {
    letters: { type: String, required: true }, // normalized uppercase, e.g. "SERA"
    parts: [AcronymPartSchema],
    isRealWord: { type: Boolean, default: false },
    branchCoverage: { type: Number, default: 0 }, // distinct branches used, 1–4
    engineScore: Number, // deterministic score from code
    score: { type: Number, default: null }, // LLM score 0–100 (null if LLM unavailable)
    rationale: String,
    tagline: String,
    source: { type: String, enum: ['engine', 'llm'], required: true },
    favorite: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const BrainstormSessionSchema = new Schema(
  {
    title: { type: String, default: '', trim: true, maxlength: 120 },
    titleSource: { type: String, enum: TITLE_SOURCES, default: 'auto' },
    aiTitle: { type: String, default: '', trim: true, maxlength: 120 }, // the AI suggestion, made once per session and kept
    language: { type: String, enum: ['fr', 'en'], default: 'fr' },
    model: { type: String, default: '' },
    answers: {
      who: { type: String, default: '', maxlength: ANSWER_MAX_CHARS },
      what: { type: String, default: '', maxlength: ANSWER_MAX_CHARS },
      how: { type: String, default: '', maxlength: ANSWER_MAX_CHARS },
      why: { type: String, default: '', maxlength: ANSWER_MAX_CHARS },
    },
    words: [WordSchema],
    acronyms: [AcronymSchema],
  },
  { timestamps: true, collection: 'brainstorm_sessions' }
);

const BrainstormSession = mongoose.model('BrainstormSession', BrainstormSessionSchema);

module.exports = BrainstormSession;
module.exports.BRANCHES = BRANCHES;
module.exports.TITLE_SOURCES = TITLE_SOURCES;
module.exports.MAX_WORDS = MAX_WORDS;
module.exports.MAX_ACRONYMS = MAX_ACRONYMS;
