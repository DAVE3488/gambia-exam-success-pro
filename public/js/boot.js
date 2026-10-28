'use strict';
(function (G) {
  const offline = document.getElementById('offline');
  const setOnline = () => { offline.hidden = navigator.onLine; };
  window.addEventListener('online', () => { setOnline(); G.toast('Back online.', 'ok'); });
  window.addEventListener('offline', setOnline); setOnline();

  window.addEventListener('hashchange', () => G.navigate());
  // Last-resort handler: a bug in one view must never leave a blank screen.
  window.addEventListener('unhandledrejection', (e) => { console.error(e.reason); });

  (async function start() {
    await G.loadMe();
    if (!location.hash || location.hash === '#') location.hash = G.me ? '#/' : '#/welcome';
    await G.navigate();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  })();
})(window.GES);
