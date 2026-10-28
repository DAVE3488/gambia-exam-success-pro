'use strict';
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');

module.exports = {
  ROOT,
  DATA,
  DB_FILE: path.join(DATA, 'app.db'),
  PRIVATE_DIR: path.join(DATA, 'private'),   // original papers + materials. Never served statically.
  AVATAR_DIR: path.join(DATA, 'avatars'),    // profile pictures. Never served statically.
  PUBLIC_DIR: path.join(ROOT, 'public'),
  PORT: Number(process.env.PORT) || 3000,
  HOST: process.env.HOST || '0.0.0.0',
  // Reserved address of the Chief Administrator. Registering with it NEVER grants a role.
  CHIEF_EMAIL: 'jprothereal@gmail.com',
  SECURE_COOKIES: process.env.SECURE_COOKIES === '1',
  COOKIE_NAME: 'ges_sid',
  STAFF_IDLE_MS: 5 * 60 * 60 * 1000,                 // supervisors + administrators: 5 hours of inactivity
  STUDENT_SESSION_MS: 400 * 24 * 60 * 60 * 1000,     // students + teachers: until logout (cookie lifetime cap)
  MAX_UPLOAD_BYTES: 30 * 1024 * 1024,
  MAX_AVATAR_BYTES: 2 * 1024 * 1024,
  MAX_BODY_BYTES: 64 * 1024 * 1024,
  LIMITS: { MAIN_ADMINS: 5, SUPERVISORS: 200, SUPERVISOR_SUBJECTS: 4, TEACHERS: 5000 },
  YEAR_MIN: 2000,
  YEAR_MAX: 2026,
  DONATION_AMOUNTS: [10, 20, 30, 40, 50],
  BRAND: {
    name: 'Gambia Exam Success',
    slogan: 'Learn today. Succeed tomorrow.',
    tagline: 'A brighter future for Gambian students',
    mark: '~j pro',
  },
};
