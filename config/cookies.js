// Attributes shared by every cookie the app sets (guest, login), so setting and clearing one always match.
const cookieOptions = () => ({ httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });

module.exports = { cookieOptions };
