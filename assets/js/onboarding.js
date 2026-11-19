// 처음 사용 안내 카드와 데모 바로 보기 (WEB_FEATURES F1·F9).
// 작성 화면 맨 위 카드, 사이드바 "도움말"(작성 화면이면 카드를 다시 보이고, 아니면 모달), 키 창의 "키 없이 데모로 보기"가 함께 쓴다.

import { api } from './api.js';
import { store, getApiKey, setOnboardingDismissed, demoSpeedPref, savePrefs } from './store.js';
import { h, icon, button, setBusy, toast, modal, str, arr, obj, uid } from './ui.js';
import { navigate, refreshRuns, openKeyDialog } from './main.js';

const COST_HINT = "표준 깊이 + Claude Opus 5.5 기준 약 12~24분, 약 $4(본인 키로 과금). 처음에는 '빠르게' + Claude Haiku 5.5로 시험해 보세요.";
let demoBusy = false;

/** 데모로 재생할 샘플의 주제·모델. 기록 목록(샘플 포함)에서 찾고, 없으면 예시 주제를 쓴다. */
async function demoSample() {
  const cfg = obj(store.get().config);
  let runs = store.get().runs;
  if (!Array.isArray(runs) || !runs.length) {
    try { runs = arr((await api.listRuns())?.runs); } catch { runs = []; }
  }
  const samples = arr(runs).filter((r) => r && r.sample);
  const pick = samples.find((r) => r.id === cfg.demo_sample) || samples[0] || null;
  const prompt = str(pick?.prompt).trim() || str(pick?.topic).trim() || str(arr(cfg.examples)[0]).trim() || '생성형 AI가 대학원생의 연구 생산성에 미치는 영향';
  const ids = arr(cfg.models).map((m) => m && m.id).filter(Boolean);
  const def = (arr(cfg.models).find((m) => m && m.default) || {}).id || ids[0];
  const model = ids.includes(str(pick?.model)) ? pick.model : def;
  return { prompt, model };
}

/**
 * 키 없이 데모 실행을 시작하고 진행 화면으로 이동한다.
 * speed: 1(약 45초) | 5(약 10초). 생략하면 prefs.demoSpeed. 작성 중인 글(draft)은 건드리지 않는다.
 */
export async function startDemo(speed = demoSpeedPref(), btn = null) {
  if (demoBusy) return false;
  demoBusy = true;
  const sp = Number(speed) === 5 ? 5 : 1;
  if (btn) setBusy(btn, true, '시작하는 중…');
  try {
    const sample = await demoSample();
    savePrefs({ demoSpeed: sp });
    const res = await api.createRun({
      prompt: sample.prompt, model: sample.model, depth: 'standard', language: 'auto',
      human_in_the_loop: false, formats: ['md'], demo: true, demo_speed: sp,
    });
    const id = str(res?.id);
    if (!id) throw new Error('데모 실행을 만들지 못했습니다.');
    refreshRuns();
    navigate(`#/run/${encodeURIComponent(id)}`);
    return true;
  } catch (err) {
    toast(str(err?.message, '데모를 시작하지 못했습니다.'), 'error', { duration: 6000 });
    return false;
  } finally {
    demoBusy = false;
    if (btn && btn.isConnected) setBusy(btn, false);
  }
}

function keyStepState() {
  const ks = obj(store.get().keyStatus);
  if (!getApiKey()) return { done: false, text: '키가 없어도 데모는 볼 수 있습니다.' };
  if (ks.state === 'ok') return { done: true, text: '등록됨' };
  if (ks.state === 'error') return { done: false, text: str(ks.message, '키를 확인하지 못했습니다.') };
  return { done: false, text: ks.checking ? '확인하는 중…' : '등록했지만 아직 확인하지 않았습니다.' };
}

/**
 * 안내 카드. opts: {onClose()(×), onDismiss()("다시 보지 않기"), beforeDemo()(모달이면 닫기)}
 * 돌려주는 요소에 .cleanup()이 있다(키 상태 구독 해제).
 */
export function onboardingCard({ onClose, onDismiss, beforeDemo } = {}) {
  const titleId = uid('onb-title');
  const demoBtn1 = button('데모 실행 (약 45초)', { kind: 'primary', size: 'sm', icon: 'play' });
  const demoBtn5 = button('빠르게 (약 10초)', { kind: 'secondary', size: 'sm' });
  const run = (sp, b) => { if (beforeDemo) beforeDemo(); startDemo(sp, b); };
  demoBtn1.addEventListener('click', () => run(1, demoBtn1));
  demoBtn5.addEventListener('click', () => run(5, demoBtn5));

  const keyMark = h('span', { class: 'onb-num' });
  const keyText = h('span', { class: 'onb-status' });
  const keyBtn = button('API 키 등록', { kind: 'secondary', size: 'sm', icon: 'key', onClick: () => openKeyDialog() });
  const renderKey = () => {
    const s = keyStepState();
    keyMark.classList.toggle('is-done', s.done);
    keyMark.replaceChildren(s.done ? icon('check', 14) : '2');
    keyText.replaceChildren(s.done ? icon('check', 12) : null, s.text);
    keyText.classList.toggle('is-done', s.done);
    keyBtn.querySelector('.btn-label').textContent = s.done ? '키 바꾸기' : 'API 키 등록';
  };
  renderKey();
  const unsub = store.subscribe((st, p) => { if (st.keyStatus !== p.keyStatus) renderKey(); });

  const head = h('div', { class: 'onb-head' },
    h('h2', { class: 'onb-title', id: titleId }, '처음 사용하시나요?'),
    h('div', { class: 'onb-head-actions' },
      onDismiss ? h('button', { type: 'button', class: 'link-btn', onClick: () => onDismiss() }, '다시 보지 않기') : null,
      onClose ? h('button', { type: 'button', class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': '안내 닫기', onClick: () => onClose() }, icon('x', 16)) : null));

  const card = h('section', { class: 'card onb-card', 'aria-labelledby': titleId },
    head,
    h('ol', { class: 'onb-steps' },
      h('li', { class: 'onb-step' },
        h('span', { class: 'onb-num' }, '1'),
        h('div', { class: 'onb-body' },
          h('div', { class: 'onb-step-title' }, '데모로 둘러보기'),
          h('p', { class: 'onb-text' }, '키 없이 기록된 실제 조사를 재생합니다. API를 호출하지 않아 비용이 들지 않습니다.'),
          h('div', { class: 'onb-actions' }, demoBtn1, demoBtn5))),
      h('li', { class: 'onb-step' },
        keyMark,
        h('div', { class: 'onb-body' },
          h('div', { class: 'onb-step-title' }, 'API 키 등록'),
          h('p', { class: 'onb-text' }, keyText),
          h('div', { class: 'onb-actions' }, keyBtn))),
      h('li', { class: 'onb-step' },
        h('span', { class: 'onb-num' }, '3'),
        h('div', { class: 'onb-body' },
          h('div', { class: 'onb-step-title' }, '주제를 적고 조사 시작'),
          h('p', { class: 'onb-text' }, COST_HINT)))));
  card.cleanup = unsub;
  return card;
}

/** 사이드바 "도움말": 작성 화면이면 카드를 다시 보이고, 다른 화면이면 모달로 띄운다 */
export function openHelp() {
  if (document.querySelector('.page.compose')) {
    store.set({ helpRequest: (Number(store.get().helpRequest) || 0) + 1 });
    return;
  }
  let dlg = null;
  const card = onboardingCard({ beforeDemo: () => dlg?.close() });
  card.classList.add('onb-in-modal');
  dlg = modal({
    title: '도움말',
    body: card,
    size: 'wide',
    onClose: () => card.cleanup?.(),
    actions: [{ label: '닫기', kind: 'secondary' }],
  });
}

/** 작성 화면 맨 위에 붙일 카드(조건에 맞을 때만). 결과: {el, destroy} */
export function composeOnboarding(container) {
  let hidden = false;
  let card = null;
  const slot = h('div', { class: 'onb-slot' });
  const render = (force = false) => {
    card?.cleanup?.();
    card = null;
    const show = force || (!hidden && !store.get().onboardingDismissed);
    if (!show) { slot.replaceChildren(); return; }
    card = onboardingCard({
      onClose: () => { hidden = true; render(); },
      onDismiss: () => { hidden = true; setOnboardingDismissed(true); render(); toast("안내를 숨겼습니다. 사이드바의 '도움말'로 다시 볼 수 있습니다.", 'info'); },
    });
    slot.replaceChildren(card);
    if (force) {
      requestAnimationFrame(() => {
        card?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        card?.querySelector('button')?.focus({ preventScroll: true });
      });
    }
  };
  render();
  const unsub = store.subscribe((s, p) => {
    if (s.helpRequest !== p.helpRequest) { hidden = false; render(true); }
  });
  if (container) container.append(slot);
  return { el: slot, destroy: () => { unsub(); card?.cleanup?.(); } };
}
