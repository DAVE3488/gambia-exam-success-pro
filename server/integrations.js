'use strict';
/*
 * External integrations. Each one reports honestly whether it is configured.
 * Nothing here fabricates a result: when a provider is not configured, callers get
 * { ok:false, reason:'not_configured' } and the UI says so.
 *
 * Configure through environment variables on the server (never in front-end code):
 *   AI_API_URL, AI_API_KEY, AI_MODEL      OpenAI-compatible chat completions endpoint (many free-tier providers work)
 *   SMS_PROVIDER_URL, SMS_API_KEY         SMS gateway for +220 verification
 *   WAVE_API_KEY, WAVE_WEBHOOK_SECRET     Wave checkout + signed webhook
 *   APS_API_KEY, APS_WEBHOOK_SECRET       APS checkout + signed webhook
 */
const { execFileSync } = require('child_process');

function hasBin(name) { try { execFileSync('which', [name], { stdio: 'ignore' }); return true; } catch { return false; } }

function status() {
  return {
    ai: { configured: !!(process.env.AI_API_URL && process.env.AI_API_KEY && process.env.AI_MODEL), needs: 'AI_API_URL, AI_API_KEY, AI_MODEL' },
    sms: { configured: !!(process.env.SMS_PROVIDER_URL && process.env.SMS_API_KEY), needs: 'SMS_PROVIDER_URL, SMS_API_KEY' },
    wave: { configured: !!(process.env.WAVE_API_KEY && process.env.WAVE_WEBHOOK_SECRET), needs: 'WAVE_API_KEY, WAVE_WEBHOOK_SECRET' },
    aps: { configured: !!(process.env.APS_API_KEY && process.env.APS_WEBHOOK_SECRET), needs: 'APS_API_KEY, APS_WEBHOOK_SECRET' },
    email: { configured: false, needs: 'No email provider is wired in; password resets are issued by administrators.' },
    pdf_text: { configured: hasBin('pdftotext'), needs: 'poppler-utils (pdftotext, pdftoppm)' },
    ocr: { configured: hasBin('tesseract'), needs: 'tesseract-ocr' },
  };
}

/** OpenAI-compatible chat call. Returns {ok:false} when not configured; never invents text. */
async function chat(messages, { maxTokens = 700 } = {}) {
  if (!status().ai.configured) return { ok: false, reason: 'not_configured' };
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 45000);
    const resp = await fetch(process.env.AI_API_URL, {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.AI_API_KEY}` },
      body: JSON.stringify({ model: process.env.AI_MODEL, messages, max_tokens: maxTokens, temperature: 0.3 }),
    });
    clearTimeout(t);
    if (!resp.ok) return { ok: false, reason: 'provider_error', status: resp.status };
    const j = await resp.json();
    const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!text) return { ok: false, reason: 'empty_response' };
    return { ok: true, text: String(text) };
  } catch (e) { return { ok: false, reason: 'unreachable' }; }
}

module.exports = { status, chat };
