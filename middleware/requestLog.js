const morgan = require('morgan');

// One log line per request; static files are served before it, so they stay out of the log.
// Development: method, path, status and time, in color. Production adds the date and the visitor's IP
// (the real one behind a proxy, once TRUST_PROXY is set).

// Query values that must never reach the logs: the tokens in verify and reset links, and email addresses
const PRIVATE_PARAMS = /([?&](?:token|email)=)[^&#]*/gi;
const redactUrl = (url) => url.replace(PRIVATE_PARAMS, '$1***');

// Replaces morgan's own :url, so every format logs the redacted one
morgan.token('url', (req) => redactUrl(req.originalUrl || req.url));

const PRODUCTION_FORMAT = ':date[iso] :remote-addr :method :url :status :res[content-length] - :response-time ms';

const requestLog = ({ production = process.env.NODE_ENV === 'production', stream } = {}) =>
  morgan(production ? PRODUCTION_FORMAT : 'dev', stream ? { stream } : {});

module.exports = { requestLog, redactUrl };
