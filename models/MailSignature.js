const mongoose = require('mongoose');

const { Schema } = mongoose;

// What goes under an admin's words on mail sent from one of the mailboxes (Admin → Mail → Signatures, services/mail.js).
// A mailbox without one here signs with its name; an empty text means no signature, on purpose.
const MailSignatureSchema = new Schema(
  {
    address: { type: String, required: true, unique: true }, // one of config/mail.js's MAILBOXES
    text: { type: String, default: '' },
    updatedBy: String, // the admin who last set it (their ADMINS address)
  },
  { collection: 'mail_signatures', versionKey: false, timestamps: true }
);

module.exports = mongoose.model('MailSignature', MailSignatureSchema);
