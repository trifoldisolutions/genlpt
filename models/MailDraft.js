const mongoose = require('mongoose');

const { Schema } = mongoose;

// An email an admin saved to finish later (Admin → Mail → Drafts, services/mail.js): theirs alone, until it's sent or
// discarded. Anything can be missing or not valid yet: it's checked when it's sent. Its files are in GridFS
// (mail_draft_files), since they can be larger than a document can hold.
const MailDraftFileSchema = new Schema(
  {
    id: Schema.Types.ObjectId, // the GridFS file's
    filename: String,
    contentType: String,
    size: Number,
  },
  { _id: false }
);

const MailDraftSchema = new Schema(
  {
    createdBy: { type: String, required: true }, // the admin's ADMINS address
    from: String,
    to: String,
    cc: String,
    subject: String,
    body: String, // the message, in the few tags cleanNote leaves
    text: String, // and in plain text, for the list
    opening: String, // what goes over it and under it, as chosen (plain text): config/mail.js TEMPLATES
    closing: String,
    t: String, // the thread it answers or forwards from
    answering: String,
    forwarding: String,
    attachments: [String], // what's ticked of what a forward can send along
    files: [MailDraftFileSchema],
  },
  { collection: 'mail_drafts', versionKey: false, timestamps: true }
);

MailDraftSchema.index({ createdBy: 1, updatedAt: -1 });

module.exports = mongoose.model('MailDraft', MailDraftSchema);
