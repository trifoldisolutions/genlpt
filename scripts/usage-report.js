// Adds a usage report to dev_resources/usage_reports.md: what the AI actions since the last report cost, per step,
// per click and per plan, with window, month and price estimates (services/usageReport.js, config/pricing.js).
//   npm run usage:report -- --label "luna-pro, low reasoning"   the actions since the last report
//   npm run usage:report -- --since 3h                          or 2d, or a date: a period of your choice
//   npm run usage:report -- --print                             show it without adding it to the file

require('dotenv').config({ override: true, quiet: true });
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const mongoose = require('mongoose');
const AiAction = require('../models/AiAction');
const report = require('../services/usageReport');

const FILE = path.join(__dirname, '..', 'dev_resources', 'usage_reports.md');
const UNITS = { m: 60e3, h: 3600e3, d: 86400e3 };

// "3h", "2d", "30m" before now, or a date
function parseSince(value, now) {
  const rel = /^(\d+)([mhd])$/.exec(value);
  const date = rel ? new Date(now - Number(rel[1]) * UNITS[rel[2]]) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`--since takes 30m, 3h, 2d or a date, not "${value}"`);
  return date;
}

async function main() {
  const { values } = parseArgs({ options: { label: { type: 'string' }, since: { type: 'string' }, print: { type: 'boolean' } } });
  const until = new Date();
  const text = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : '';
  const since = values.since ? parseSince(values.since, until) : report.lastUntil(text);

  await mongoose.connect(process.env.MONGO_URI, { dbName: 'genlpt' });
  let actions;
  try {
    actions = await AiAction.find({ createdAt: { ...(since ? { $gt: since } : {}), $lte: until } }).sort({ createdAt: 1 }).lean();
  } finally {
    await mongoose.disconnect();
  }
  if (!actions.length) {
    console.log(`No AI actions recorded${since ? ` since ${since.toLocaleString()}` : ''}: nothing to report.`);
    return;
  }

  const section = report.build(actions, { label: values.label || '', since, until });
  if (values.print) {
    console.log(section);
    return;
  }
  fs.writeFileSync(FILE, report.insert(text, section));
  console.log(`Added a report of ${actions.length} AI actions to ${path.relative(process.cwd(), FILE)}.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
