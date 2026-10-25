// Gives an account a role: npm run set-role -- <email> <admin|user>
// The account must exist (signed up); its role takes effect on its next request.

require('dotenv').config({ override: true, quiet: true });
const mongoose = require('mongoose');
const User = require('../models/User');

async function main() {
  const [email, role] = process.argv.slice(2);
  if (!email || !User.ROLES.includes(role)) {
    console.error(`Usage: npm run set-role -- <email> <${User.ROLES.join('|')}>`);
    process.exitCode = 1;
    return;
  }
  await mongoose.connect(process.env.MONGO_URI, { dbName: 'genlpt' });
  try {
    const user = await User.findOneAndUpdate({ email: email.trim().toLowerCase() }, { $set: { role } }, { returnDocument: 'after' });
    if (!user) {
      console.error(`No account with the email ${email}.`);
      process.exitCode = 1;
      return;
    }
    console.log(`${user.email} is now ${role}.`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
