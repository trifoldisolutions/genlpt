const mongoose = require('mongoose');

const { Schema } = mongoose;

// One email in the team's mailbox (Admin → Mail, services/mail.js): received at an address of the domain ('in',
// from Resend's Receiving API) or sent from one of the mailboxes ('out'). Resend keeps emails 30 days; this copy
// is the one that lasts. Attachments stay at Resend: only what they are is kept here.
const DIRECTIONS = ['in', 'out'];

const AddressSchema = new Schema({ name: String, address: String }, { _id: false });

const AttachmentSchema = new Schema(
  {
    id: String, // Resend's, to ask it for a download link; none on one we forwarded: only its name and size are kept
    filename: String,
    contentType: String,
    size: Number,
    contentId: String, // an inline image's, referred to as cid: in the HTML
    disposition: String, // 'inline' or 'attachment'
  },
  { _id: false }
);

const MailMessageSchema = new Schema(
  {
    direction: { type: String, enum: DIRECTIONS, required: true },
    resendId: String, // Resend's id for it, received or sent
    threadId: { type: Schema.Types.ObjectId, required: true },
    mailbox: String, // our address it came to (in) or went from (out); null: an address of the domain that isn't a mailbox
    messageId: String, // its Message-ID header, <…>: replies name it in In-Reply-To and References
    inReplyTo: String,
    references: [String],
    from: AddressSchema,
    to: [String],
    cc: [String],
    replyTo: [String],
    subject: String,
    text: String,
    html: String, // shown only in a sandboxed frame (views/admin/mail.ejs): it's whatever the sender wrote
    attachments: [AttachmentSchema],
    authentication: { spf: String, dkim: String, dmarc: String }, // in: what the receiving server found
    date: { type: Date, required: true }, // when it was received or sent
    read: Boolean, // in only
    sentBy: String, // out: the admin who sent it (their ADMINS address)
    searchText: { type: String, select: false }, // what search looks through (services/mail.js), left out of reads
  },
  { collection: 'mail_messages', versionKey: false, timestamps: true }
);

// A webhook sent twice, or one that crosses a sync, saves the email once
MailMessageSchema.index({ resendId: 1 }, { unique: true, partialFilterExpression: { resendId: { $type: 'string' } } });
MailMessageSchema.index({ threadId: 1, date: 1 });
MailMessageSchema.index({ messageId: 1 });

module.exports = mongoose.model('MailMessage', MailMessageSchema);
module.exports.DIRECTIONS = DIRECTIONS;
