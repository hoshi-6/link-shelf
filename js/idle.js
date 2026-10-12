// 操作しない時間が続いたらセッションを切る(自動ログアウト)
// 最後に操作した時刻は sessionStorage に置き、同じタブで再読み込みしても引き継ぐ。

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'scroll', 'wheel', 'touchstart'];
const WRITE_INTERVAL = 5000; // 操作のたびに書き込まないよう、5 秒に 1 回まで

export function isExpired(lastActive, now, limitMs) {
  return lastActive != null && now - lastActive >= limitMs;
}

export function createIdleTimer({
  limitMs, warnBeforeMs, onWarn, onExpire, key,
  now = Date.now, storage = sessionStorage, target = window, autoCheck = true,
}) {
  let running = false;
  let warned = false;
  let timer = null;
  let lastWrite = 0;

  const read = () => {
    try { const v = Number(storage.getItem(key)); return v || null; } catch { return null; }
  };
  const write = t => { try { storage.setItem(key, String(t)); } catch { /* noop */ } };

  const touch = () => {
    if (!running) return;
    const t = now();
    if (t - lastWrite < WRITE_INTERVAL) return;
    lastWrite = t;
    warned = false;
    write(t);
  };

  function check() {
    if (!running) return;
    const idle = now() - (read() ?? now());
    if (idle >= limitMs) {
      stop();
      onExpire();
    } else if (idle >= limitMs - warnBeforeMs && !warned) {
      warned = true;
      onWarn();
    }
  }

  // スマホで別のアプリから戻ってきたときは、止まっていたタイマーの代わりにすぐ確かめる
  const onVisible = () => { if (!document.hidden) check(); };

  function start() {
    if (running) return;
    running = true;
    warned = false;
    lastWrite = 0;
    touch();
    for (const e of ACTIVITY_EVENTS) target.addEventListener(e, touch, { capture: true, passive: true });
    if (autoCheck) {
      timer = setInterval(check, 15000);
      document.addEventListener('visibilitychange', onVisible);
      window.addEventListener('focus', check);
    }
  }

  function stop() {
    running = false;
    clearInterval(timer);
    for (const e of ACTIVITY_EVENTS) target.removeEventListener(e, touch, { capture: true });
    if (autoCheck) {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', check);
    }
    try { storage.removeItem(key); } catch { /* noop */ }
  }

  return {
    start,
    stop,
    check,
    // 再読み込み直後:前回の操作から期限を過ぎていないか
    expiredAtStart: () => isExpired(read(), now(), limitMs),
  };
}
