'use strict';
const crypto = require('crypto');

/** Hash password dengan scrypt: format "s1$salt$hash" */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `s1$${salt}$${hash}`;
}

function verifyPassword(pw, stored) {
  try {
    const [ver, salt, hash] = String(stored).split('$');
    if (ver !== 's1' || !salt || !hash) return false;
    const test = crypto.scryptSync(String(pw), salt, 64).toString('hex');
    const a = Buffer.from(test, 'hex');
    const b = Buffer.from(hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword };
