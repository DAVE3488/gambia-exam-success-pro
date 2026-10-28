'use strict';
/*
 * Document text extraction. Uses poppler (pdftotext/pdftoppm) and tesseract when installed.
 * Output is ALWAYS a draft for a human to correct: extraction is heuristic, never authoritative.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const run = promisify(execFile);

const OCR_PAGE_CAP = 40;

async function have(bin) { try { await run('which', [bin]); return true; } catch { return false; } }

async function pdfPageCount(file) {
  try { const { stdout } = await run('pdfinfo', [file], { timeout: 15000 }); const m = /Pages:\s+(\d+)/.exec(stdout); return m ? Number(m[1]) : null; } catch { return null; }
}

/** @returns {{pages:string[], method:string, warnings:string[]}} */
async function extractFile(file, mime) {
  const warnings = [];
  if (mime === 'application/pdf') {
    if (await have('pdftotext')) {
      try {
        const { stdout } = await run('pdftotext', ['-layout', file, '-'], { timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
        const pages = stdout.split('\f'); if (pages.length && !pages[pages.length - 1].trim()) pages.pop();
        const chars = pages.join('').replace(/\s/g, '').length;
        if (chars > 80 * Math.max(1, pages.length) * 0.5) return { pages, method: 'pdf-text', warnings };
        warnings.push('The PDF has little or no embedded text; trying OCR.');
      } catch (e) { warnings.push('pdftotext failed: ' + (e.killed ? 'timed out' : 'error')); }
    } else warnings.push('pdftotext is not installed.');
    if (!(await have('pdftoppm')) || !(await have('tesseract'))) {
      warnings.push('OCR is unavailable (needs pdftoppm and tesseract). Enter questions manually.');
      return { pages: [], method: 'none', warnings };
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ges-ocr-'));
    try {
      await run('pdftoppm', ['-r', '150', '-png', '-l', String(OCR_PAGE_CAP), file, path.join(dir, 'p')], { timeout: 120000 });
      const imgs = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
      const pages = [];
      for (const img of imgs) {
        const { stdout } = await run('tesseract', [path.join(dir, img), 'stdout', '-l', 'eng', '--psm', '6'], { timeout: 90000, maxBuffer: 8 * 1024 * 1024 });
        pages.push(stdout);
      }
      const total = await pdfPageCount(file);
      if (total && total > OCR_PAGE_CAP) warnings.push(`OCR covered the first ${OCR_PAGE_CAP} of ${total} pages.`);
      return { pages, method: 'ocr', warnings };
    } catch (e) { warnings.push('OCR failed.'); return { pages: [], method: 'none', warnings }; }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  if (mime.startsWith('image/')) {
    if (!(await have('tesseract'))) { warnings.push('OCR is unavailable (needs tesseract). Enter questions manually.'); return { pages: [], method: 'none', warnings }; }
    try {
      const { stdout } = await run('tesseract', [file, 'stdout', '-l', 'eng', '--psm', '6'], { timeout: 90000, maxBuffer: 8 * 1024 * 1024 });
      return { pages: [stdout], method: 'ocr', warnings };
    } catch { warnings.push('OCR failed.'); return { pages: [], method: 'none', warnings }; }
  }
  warnings.push('This file type cannot be extracted automatically.');
  return { pages: [], method: 'none', warnings };
}

const Q_START = /^\s*(?:Q(?:uestion)?\.?\s*)?(\d{1,3})\s*[.)\]:-]\s+(\S.*)$/i;
const OPT_START = /^\s*\(?([A-Ea-e])[.)]\s*(\S.*)$/;
const MARKS = /\[\s*(\d{1,2})\s*marks?\s*\]|\(\s*(\d{1,2})\s*marks?\s*\)/i;

/** Heuristic parser: numbered questions with lettered options. Returns drafts for human correction. */
function parseQuestions(pages) {
  const out = []; let cur = null; let lastOpt = null;
  const flush = () => { if (cur) { cur.text = cur.text.replace(/\s+\n/g, '\n').trim(); if (cur.text) out.push(cur); } cur = null; lastOpt = null; };
  pages.forEach((pg, pi) => {
    // options printed side by side ("A. x    B. y") become separate lines
    const expanded = String(pg).split(/\r?\n/).flatMap((l) =>
      OPT_START.test(l) ? l.split(/\s{2,}(?=\(?[A-Ea-e][.)]\s+\S)/) : [l]);
    for (const raw of expanded) {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) continue;
      if (/^\s*(page\s+\d+|\d+\s*$)/i.test(line) && line.trim().length < 12) continue; // page numbers
      const om = OPT_START.exec(line);
      const qm = Q_START.exec(line);
      if (om && cur && !(qm && !lastOpt && cur.options.length === 0 && false)) {
        const label = om[1].toUpperCase();
        // an option whose letter follows the sequence (A, then B, ...) is an option; otherwise treat as text
        const expected = String.fromCharCode(65 + cur.options.length);
        if (label === expected) { lastOpt = { label, text: om[2].trim() }; cur.options.push(lastOpt); continue; }
      }
      if (qm) {
        flush();
        cur = { number: qm[1], text: qm[2].trim(), options: [], page_ref: pi + 1, marks: null };
        const mk = MARKS.exec(cur.text); if (mk) cur.marks = Number(mk[1] || mk[2]);
        continue;
      }
      if (cur) {
        if (lastOpt) lastOpt.text += ' ' + line.trim();
        else cur.text += '\n' + line.trim();
      }
    }
  });
  flush();
  return out.map((d) => ({ ...d, type: d.options.length >= 2 ? 'objective' : 'theory', options: d.options.length >= 2 ? d.options : [] }));
}

module.exports = { extractFile, parseQuestions, pdfPageCount };
