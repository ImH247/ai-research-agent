// 끝나면 알림 (WEB_FEATURES F4): 데스크톱 알림 · 짧은 소리(WebAudio) · 토스트, 진행 화면 머리의 종 토글.
// 설정은 store의 prefs.notify(boolean). 켜는 스위치는 작성 화면(FA)과 진행 화면 머리(여기) 두 곳에 있다.
// 알림 본문에는 주제(사용자 글)만 텍스트로 넣는다. API 키는 다루지 않는다.

import { api } from './api.js';
import { store, savePrefs } from './store.js';
import { h, toast, str, obj, truncate, ACTIVE_STATUSES } from './ui.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 이 브라우저가 데스크톱 알림을 지원하는지 */
export function notifySupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/** prefs.notify가 켜져 있고 권한도 있는지 */
export function notifyEnabled() {
  if (!notifySupported()) return false;
  const on = !!obj(store.get().prefs).notify;
  let perm = 'default';
  try { perm = Notification.permission; } catch { /* 무시 */ }
  return on && perm === 'granted';
}

// ───────────────────────── 소리 ─────────────────────────

let audioCtx = null;

function audio() {
  if (audioCtx) return audioCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  try { audioCtx = new Ctx(); } catch { audioCtx = null; }
  return audioCtx;
}

/** 사용자 동작(클릭) 안에서 불러 두면 나중에 탭이 숨겨져 있어도 소리를 낼 수 있다 */
export function unlockAudio() {
  try {
    const ctx = audio();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  } catch { /* 무시 */ }
}

/** 0.15초짜리 두 음 */
function chime() {
  const ctx = audio();
  if (!ctx) return;
  try {
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const t0 = ctx.currentTime + 0.02;
    [[880, 0], [1318.5, 0.17]].forEach(([freq, delay]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t = t0 + delay;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.12, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.16);
    });
  } catch { /* 소리는 없어도 된다 */ }
}

// ───────────────────────── 알림 ─────────────────────────

const TEXT = {
  done: { title: '조사 완료', toast: '조사가 끝났습니다', kind: 'success' },
  error: { title: '조사 중 오류', toast: '조사 중 오류가 발생했습니다', kind: 'error' },
  awaiting_plan: { title: '계획 검토 대기', toast: '조사 계획 검토를 기다리고 있습니다', kind: 'info' },
};

function runHash(runId) {
  return `#/run/${encodeURIComponent(str(runId))}`;
}

function viewingRun(runId) {
  const target = runHash(runId);
  return location.hash === target || location.hash.startsWith(`${target}/`);
}

/**
 * 실행 이벤트 알림. kind: 'done' | 'error' | 'awaiting_plan'.
 * 탭이 숨겨져 있고 prefs.notify면 데스크톱 알림 + 소리, 탭이 보이면 토스트만.
 */
export function notifyRunEvent(kind, { topic = '', runId = '' } = {}) {
  const t = TEXT[kind];
  if (!t) return;
  const name = truncate(str(topic).trim() || '제목 없는 조사', 60);
  const hidden = typeof document !== 'undefined' && document.hidden;
  if (hidden && notifyEnabled()) {
    try {
      const n = new Notification(t.title, {
        body: kind === 'awaiting_plan' ? `조사 계획을 확인해 주세요 — ${name}` : name,
        tag: `run-${str(runId)}`,
      });
      n.onclick = () => {
        try { window.focus(); } catch { /* 무시 */ }
        if (runId) location.hash = runHash(runId);
        n.close();
      };
    } catch { /* 알림을 만들 수 없는 환경(일부 모바일): 소리만 */ }
    chime();
    return;
  }
  // 보고 있는 실행의 계획 검토는 화면에 이미 크게 보인다
  if (kind === 'awaiting_plan' && viewingRun(runId)) return;
  const here = viewingRun(runId);
  const msg = kind === 'done' && here ? '조사가 끝났습니다. 보고서를 확인하세요.' : here ? `${t.toast}.` : `${t.toast}: ${name}`;
  toast(msg, t.kind, { duration: kind === 'error' ? 6000 : 4000 });
}

// ───────────────────────── 상태 추적 ─────────────────────────
// 진행 화면과 뒤쪽 감시가 같은 표를 쓰므로 같은 전환을 두 번 알리지 않는다.

const lastSeen = new Map();   // runId → 마지막으로 본 status
const watchers = new Map();   // runId → timer

function kindFor(status) {
  if (status === 'done') return 'done';
  if (status === 'error') return 'error';
  if (status === 'awaiting_plan') return 'awaiting_plan';
  return null;
}

/** 실행 스냅샷을 보고, 진행 중 → 완료/오류/검토 대기로 바뀌었으면 알린다 */
export function trackRunStatus(runId, snap) {
  const id = str(runId);
  if (!id) return;
  const s = obj(snap);
  const now = str(s.status);
  if (!now) return;
  const prev = lastSeen.get(id);
  lastSeen.set(id, now);
  if (prev === undefined || prev === now || !ACTIVE_STATUSES.has(prev)) return;
  const kind = kindFor(now);
  if (kind) notifyRunEvent(kind, { topic: str(s.custom_title) || str(s.topic) || str(s.prompt), runId: id });
}

/**
 * 화면을 떠나도 실행이 끝나면 알릴 수 있게 가볍게 감시한다(실행이 끝나면 멈춘다).
 * 진행 화면이 이미 폴링하더라도 같은 표를 쓰므로 알림은 한 번만 간다.
 */
export function watchRun(runId, snap) {
  const id = str(runId);
  if (!id) return;
  if (snap) {
    const now = str(obj(snap).status);
    if (now && !lastSeen.has(id)) lastSeen.set(id, now);
    if (now && !ACTIVE_STATUSES.has(now)) return;
  }
  if (watchers.has(id)) return;
  const tick = async () => {
    let next = null;
    try {
      next = obj(await api.run(id));
    } catch (err) {
      if (err?.status === 404 || err?.code === 'not_found') { watchers.delete(id); return; }
    }
    if (next) {
      trackRunStatus(id, next);
      if (!ACTIVE_STATUSES.has(str(next.status))) { watchers.delete(id); return; }
    }
    watchers.set(id, setTimeout(tick, document.hidden ? 4000 : 2500));
  };
  watchers.set(id, setTimeout(tick, 2500));
}

// ───────────────────────── 켜기 · 끄기 ─────────────────────────

/** prefs.notify를 바꾼다. 켤 때 권한을 묻고, 거부되면 끈 채로 이유를 알린다. → 최종 상태 */
export async function setNotify(on) {
  if (!on) {
    savePrefs({ notify: false });
    return false;
  }
  unlockAudio();
  if (!notifySupported()) {
    toast('이 브라우저는 알림을 지원하지 않습니다.', 'error');
    savePrefs({ notify: false });
    return false;
  }
  let perm = 'default';
  try { perm = Notification.permission; } catch { /* 무시 */ }
  if (perm === 'default') {
    try { perm = await Notification.requestPermission(); } catch { perm = 'denied'; }
  }
  if (perm !== 'granted') {
    savePrefs({ notify: false });
    toast('브라우저에서 알림이 꺼져 있습니다. 주소창 옆 사이트 설정에서 알림을 허용한 뒤 다시 켜 주세요.', 'error', { duration: 7000 });
    return false;
  }
  savePrefs({ notify: true });
  toast('조사가 끝나면 알려 드립니다.', 'success');
  return true;
}

function bellIcon(on) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  const attrs = {
    viewBox: '0 0 24 24', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: `icon icon-bell${on ? '' : '-off'}`,
  };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
  const paths = ['M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9', 'M10.3 21a1.94 1.94 0 0 0 3.4 0'];
  if (!on) paths.push('M3 3l18 18');
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

/** 진행 화면 머리의 종 토글. 알림을 지원하지 않으면 null. → {el, dispose} */
export function notifyToggle() {
  if (!notifySupported()) return null;
  const btn = h('button', {
    type: 'button', class: 'btn btn-ghost btn-icon btn-sm notify-toggle', 'aria-pressed': 'false', 'aria-label': '끝나면 알림 받기',
  });
  let busy = false;
  const render = () => {
    const on = notifyEnabled();
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = on ? '끝나면 알림: 켜짐 (누르면 끕니다)' : '끝나면 알림 받기';
    btn.replaceChildren(bellIcon(on));
  };
  btn.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    try { await setNotify(!notifyEnabled()); } finally { busy = false; render(); }
  });
  const unsub = store.subscribe((s, p) => { if (s.prefs !== p.prefs) render(); });
  render();
  return { el: btn, dispose: () => unsub() };
}
