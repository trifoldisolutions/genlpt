// An admin's line for ADMINS (middleware/admin.js): npm run admin:password -- <email>
// Asks for the password twice, hidden as it's typed, checks it against the same rules as customers' (at least 3 of
// each kind of character), and prints "email:hash": the password itself is never shown or stored. Put the line in
// ADMINS (Railway → Variables, and .env for local use); several admins: their lines separated by spaces. Changing a
// password is the same: a new line in place of the old, which also signs that admin out everywhere.
// Without a terminal (input piped in), the first line read is the password.

const readline = require('readline');
const argon2 = require('argon2');
const { passwordProblem, normalizeEmail, emailProblem } = require('../middleware/auth');

function hiddenQuestion(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let asked = false;
    // Show the prompt, not what's typed
    rl._writeToOutput = (text) => {
      if (!asked) {
        asked = true;
        process.stdout.write(text);
      } else if (/[\r\n]/.test(text)) process.stdout.write('\n');
    };
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function readPiped() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  return input.split(/\r?\n/)[0];
}

async function main() {
  const email = normalizeEmail(process.argv[2]);
  if (!email || emailProblem(email)) {
    console.error('Usage: npm run admin:password -- <email>');
    process.exitCode = 1;
    return;
  }
  let password;
  if (process.stdin.isTTY) {
    password = await hiddenQuestion(`Password for ${email}: `);
    if ((await hiddenQuestion('Same password again: ')) !== password) {
      console.error('The two passwords differ. Nothing was made.');
      process.exitCode = 1;
      return;
    }
  } else {
    password = await readPiped();
  }
  const problem = passwordProblem(password);
  if (problem) {
    console.error(`${problem} Nothing was made.`);
    process.exitCode = 1;
    return;
  }
  const line = `${email}:${await argon2.hash(password)}`;
  console.log(`\nThe admin's line for ADMINS (Railway → Variables, and .env), without the password:\n\n${line}\n`);
  console.log('In .env, put it in single quotes: ADMINS=\'' + line + '\'');
  console.log('Several admins: their lines on one value, separated by spaces.');
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
