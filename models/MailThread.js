const mongoose = require('mongoose');

const { Schema } = mongoose;

// A conversation in the team's mailbox (services/mail.js): an email and the replies either way. What the list shows
// is kept here, updated with each new message, so the list is one query. The messages are in mail_messages.
const MailThreadSchema = new Schema(
  {
    mailbox: String, // the address of ours it's at; null: Other (an address of the domain that isn't a mailbox)
    subject: String, // its first message's, with Re: and Fwd: taken off
    counterpart: { name: String, address: String }, // who it's with: whom we answer
    lastAt: Date,
    snippet: String, // the start of the latest message
    lastDirection: String, // 'in' or 'out': who wrote last
    messages: { type: Number, default: 0 },
    unread: { type: Number, default: 0 }, // received messages not opened yet
    starred: { type: Boolean, default: false }, // for the whole team, like whether it's been read
    trashedAt: { type: Date, default: null }, // deleted: in Trash since then, until it's restored or written in again
  },
  { collection: 'mail_threads', versionKey: false, timestamps: true }
);

MailThreadSchema.index({ mailbox: 1, lastAt: -1 });
MailThreadSchema.index({ unread: 1 });

module.exports = mongoose.model('MailThread', MailThreadSchema);
