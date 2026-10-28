#!/usr/bin/env node
'use strict';
// Usage:  CHIEF_PASSWORD='a-strong-password1' node scripts/provision-chief.js
//         CHIEF_PASSWORD='new-password1' node scripts/provision-chief.js --reset
const auth = require('../server/auth');
const pw = process.env.CHIEF_PASSWORD;
if (!pw) { console.error('Set CHIEF_PASSWORD in the environment (not on the command line, so it stays out of shell history).'); process.exit(1); }
try {
  if (process.argv.includes('--reset')) { auth.resetChiefPassword(pw); console.log('Chief Administrator password reset. All their sessions were revoked.'); }
  else { const id = auth.provisionChief(pw); console.log('Chief Administrator created (user id ' + id + ') for jprothereal@gmail.com.'); }
} catch (e) { console.error('Failed: ' + e.message); process.exit(1); }
