// 처음 화면 (#/) — FRONTEND 4절 + WEB_FEATURES F1(처음 사용 안내), F2(주제 다듬기), F4(알림 스위치), F5(비용 한도).
// 배치는 LAYOUT_V2 3절: 가운데 열(안내·제목 → 아래쪽에 기록·프롬프트) + 오른쪽 조사 설정 패널(좁은 화면에서는 시트).

import { api } from '../api.js';
import { store, getApiKey, saveDraft, savePrefs, takePrefill, getPref } from '../store.js';
import {
  h, icon, button, setBusy, toast, autosize, fmtCost, fmtInt, str, arr, obj, num, uid, badge, skeleton,
} from '../ui.js';
import { navigate, refreshRuns, openKeyDialog } from '../main.js';
import { composeOnboarding } from '../onboarding.js';
import { mountHistory } from '../history.js';

const NARROW_QUERY = '(max-width: 1099px)'; // 이 폭 이하에서 조사 설정 패널은 오른쪽 시트가 된다(home.css와 같은 값)
const promptMaxHeight = () => Math.max(160, Math.round(window.innerHeight * 0.4));

const DEFAULT_MAX_PROMPT = 4000;
const REFINE_MIN = 10;
const COST_STEP = 0.5;
const NOTIFY_SUPPORTED = typeof window !== 'undefined' && 'Notification' in window;
const PLACEHOLDER = '연구 주제나 궁금한 점을 적어 주세요. 범위·기간·강조할 점을 함께 적어도 됩니다.';
const FALLBACK_LIMITS = {
  min_subq: [2, 8], max_subq: [2, 8], max_reflection_rounds: [0, 4], max_tool_steps: [1, 6],
  results_per_search: [3, 10], verify_sample: [0, 30], parallelism: [1, 6], year_from: [1900, new Date().getFullYear()],
};
const FALLBACK_DEFAULTS = {
  max_reflection_rounds: 2, max_tool_steps: 4, results_per_search: 6, verify_sample: 10, parallelism: 3,
};
const ADVANCED = [
  { key: 'max_reflection_rounds', label: '재조사 횟수', hint: '자기 비판 뒤 추가 조사를 반복하는 최대 횟수', unit: '회' },
  { key: 'max_tool_steps', label: '하위 질문당 검색 라운드', hint: '하위 질문 하나에 검색 도구를 부르는 최대 라운드', unit: '라운드' },
  { key: 'results_per_search', label: '검색 1회당 문헌 수', hint: '검색 한 번에 가져오는 문헌 수', unit: '건' },
  { key: 'verify_sample', label: '인용 검증 문장 수', hint: '원문과 대조해 검증할 인용 문장 수(0이면 생략)', unit: '문장' },
  { key: 'parallelism', label: '병렬 실행 수', hint: '동시에 보내는 LLM 호출 수(1이면 순차 실행)', unit: '개' },
];
const FORMAT_GROUPS = [
  { id: 'report', label: '보고서', groups: ['report'] },
  { id: 'slides', label: '발표', groups: ['slides'] },
  { id: 'refs', label: '참고문헌·데이터', groups: ['refs', 'data'] },
];
const LANGS = [['auto', '자동'], ['ko', '한국어'], ['en', '영어']];
const YEAR_MODES = [['agent', '에이전트가 결정'], ['none', '제한 없음'], ['custom', '직접 입력']];

export function mountCompose(container) {
  const cfg = obj(store.get().config);
  const models = arr(cfg.models).filter((m) => m && m.id);
  const depths = arr(cfg.depths).filter((d) => d && d.id);
  const formats = arr(cfg.formats).filter((f) => f && f.id);
  const limits = { ...FALLBACK_LIMITS, ...obj(cfg.limits) };
  const defaults = { ...FALLBACK_DEFAULTS, ...obj(cfg.defaults) };
  const MAX_PROMPT = num(cfg.max_prompt) || DEFAULT_MAX_PROMPT;
  const cleanups = [];
  let busy = false;

  // ── 상태 초기화: 미리 채우기 > 마지막 설정 > 서버 기본값 ──
  const prefs = obj(store.get().prefs);
  const prefill = takePrefill();
  const pcfg = obj(prefill?.config);
  const defaultModel = (models.find((m) => m.default) || models[0] || {}).id || '';
  const pick = (list, id) => (list.some((x) => x.id === id) ? id : null);
  const st = {
    prompt: prefill ? str(prefill.prompt) : str(store.get().draft),
    model: pick(models, pcfg.model) || pick(models, prefs.model) || defaultModel,
    depth: pick(depths, pcfg.depth) || pick(depths, prefs.depth) || pick(depths, cfg.default_depth) || (depths[0] || {}).id || 'standard',
    formats: new Set(),
    hitl: false,
    language: 'auto',
    yearMode: 'agent',
    year: '',
    adv: {},
    overrides: new Set(),
    maxCost: null,        // 비용 한도(USD, 0.5 단위)
    noCap: false,         // "한도 없음"
    costTouched: false,   // 사용자가 한도를 직접 바꿨는지(아니면 모델·깊이에 따라 다시 계산)
    notify: NOTIFY_SUPPORTED && getPref('notify', false) === true && Notification.permission !== 'denied',
  };
  const fmtIds = new Set(formats.map((f) => f.id));
  const initFormats = arr(prefill ? pcfg.formats : prefs.formats).filter((f) => fmtIds.has(f));
  (initFormats.length ? initFormats : arr(defaults.formats).filter((f) => fmtIds.has(f))).forEach((f) => st.formats.add(f));
  if (!st.formats.size && formats.length) st.formats.add(fmtIds.has('md') ? 'md' : formats[0].id);

  // 웹 검색(서버 도구)은 기본으로 켜져 있다. 이전 실행에서 끈 경우만 끈 채로 이어 간다.
  st.webSearch = !(prefill && pcfg.web_search === false);

  // 비용 한도: 미리 채우기 > 사용자가 직접 정한 값(prefs.maxCost) > 예상 비용 × 1.5
  // 데모·보고서 다시 쓰기 실행은 한도를 강제로 비워 두므로(null) 그 값은 사용자의 선택이 아니다 → 무시한다
  const forcedCap = !!(prefill && (prefill.demo || prefill.rewrite || pcfg.demo === true));
  if (prefill && !forcedCap && Object.hasOwn(pcfg, 'max_cost_usd')) {
    const v = num(Number(pcfg.max_cost_usd));
    if (pcfg.max_cost_usd === null || pcfg.max_cost_usd === '' || v === null) { st.noCap = true; st.costTouched = true; } else { st.maxCost = v; st.costTouched = true; }
  } else if (Object.hasOwn(prefs, 'maxCost')) {
    if (prefs.maxCost === null) { st.noCap = true; st.costTouched = true; } else if (num(prefs.maxCost) !== null) { st.maxCost = prefs.maxCost; st.costTouched = true; }
  }

  if (prefill) {
    st.hitl = !!pcfg.human_in_the_loop;
    st.language = LANGS.some(([id]) => id === pcfg.language) ? pcfg.language : 'auto';
    const y = pcfg.year_from;
    if (y === null || y === undefined) st.yearMode = 'agent';
    else if (Number(y) === 0) st.yearMode = 'none';
    else { st.yearMode = 'custom'; st.year = String(y); }
  } else {
    st.hitl = !!prefs.hitl;
    st.language = LANGS.some(([id]) => id === prefs.language) ? prefs.language : 'auto';
    st.yearMode = YEAR_MODES.some(([id]) => id === prefs.yearMode) ? prefs.yearMode : 'agent';
    st.year = prefs.year ? String(prefs.year) : '';
  }

  const depthObj = () => depths.find((d) => d.id === st.depth) || {};
  const modelObj = () => models.find((m) => m.id === st.model) || null;
  const bounds = (key) => {
    const b = limits[key];
    return Array.isArray(b) && b.length === 2 ? [Number(b[0]), Number(b[1])] : FALLBACK_LIMITS[key] || [0, 99];
  };
  const clamp = (key, v) => {
    const [lo, hi] = bounds(key);
    return Math.min(hi, Math.max(lo, Math.round(v)));
  };
  const presetValue = (key) => {
    const dc = obj(depthObj().config);
    const v = num(dc[key]) ?? num(defaults[key]) ?? FALLBACK_DEFAULTS[key] ?? bounds(key)[0];
    return clamp(key, v);
  };
  // 고급 설정 값: 미리 채우기/저장된 직접 설정 값 → 그 외는 프리셋
  const savedOverrides = prefill ? null : obj(prefs.overrides);
  for (const { key } of ADVANCED) {
    const preset = presetValue(key);
    let v = preset;
    if (prefill && num(pcfg[key]) !== null) v = clamp(key, pcfg[key]);
    else if (savedOverrides && num(savedOverrides[key]) !== null) v = clamp(key, savedOverrides[key]);
    st.adv[key] = v;
    if (v !== preset) st.overrides.add(key);
  }

  // 조사 설정 패널(조립 단계에서 만든다). 오류 표시가 패널을 열 수 있게 먼저 선언해 둔다.
  let panel = null;
  let revealInPanel = () => {};

  // ── 오류 표시 칸 ──
  const errSlots = {};
  const errSlot = (key) => {
    errSlots[key] = h('div', { class: 'field-error', role: 'alert', hidden: true });
    return errSlots[key];
  };
  function showError(key, message, action) {
    const slot = errSlots[key] || errSlots.run;
    slot.replaceChildren(icon('alert-triangle', 14), h('span', null, str(message)), action || null);
    slot.hidden = false;
    // 오류 칸이 조사 설정 패널 안에 있으면 패널을 열고(좁은 화면) 그 칸이 보이게 패널 안에서 스크롤한다
    if (panel && panel.contains(slot)) revealInPanel(slot);
  }
  function clearError(key) {
    const keys = key ? [key] : Object.keys(errSlots);
    for (const k of keys) if (errSlots[k]) { errSlots[k].hidden = true; errSlots[k].replaceChildren(); }
  }

  // ───────────────── 1. 프롬프트 ─────────────────
  const promptId = uid('prompt');
  const ta = h('textarea', {
    id: promptId, class: 'prompt-input', rows: 2, placeholder: PLACEHOLDER, spellcheck: 'false',
    'aria-label': '연구 주제', 'aria-describedby': `${promptId}-count`,
  });
  ta.value = st.prompt;
  const counter = h('span', { class: 'prompt-count num', id: `${promptId}-count`, 'aria-live': 'off' });
  let draftTimer = 0;
  const updateCounter = () => {
    const n = ta.value.length;
    counter.textContent = `${fmtInt(n)} / ${fmtInt(MAX_PROMPT)}`;
    counter.classList.toggle('is-warn', n > MAX_PROMPT * 0.9 && n <= MAX_PROMPT);
    counter.classList.toggle('is-over', n > MAX_PROMPT);
    promptCard.classList.toggle('is-invalid', n > MAX_PROMPT);
  };
  // 미리 채운 주제를 고치지 않았으면 떠날 때 원래 임시 저장 글을 덮어쓰지 않는다
  let draftDirty = !prefill;
  ta.addEventListener('input', () => {
    draftDirty = true;
    st.prompt = ta.value;
    autosize(ta, promptMaxHeight());
    updateCounter();
    updateRefineBtn();
    if (ta.value.trim()) clearError('prompt');
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => saveDraft(ta.value), 400);
  });
  cleanups.push(() => { clearTimeout(draftTimer); if (draftDirty) saveDraft(ta.value); });

  const examples = arr(cfg.examples).map(str).filter(Boolean);
  const exampleRow = examples.length ? h('div', { class: 'examples', role: 'group', 'aria-label': '예시 주제' },
    h('span', { class: 'examples-label' }, '예시'),
    examples.map((ex) => h('button', {
      type: 'button', class: 'chip chip-example', title: ex,
      onClick: () => {
        ta.value = ex;
        ta.dispatchEvent(new Event('input'));
        ta.focus();
        ta.setSelectionRange(ex.length, ex.length);
      },
    }, h('span', { class: 'chip-text' }, ex)))) : h('span');

  // ── 주제 다듬기 (F2) ──
  let refining = false;
  const refineBtn = h('button', {
    type: 'button', class: 'btn btn-ghost btn-sm refine-btn', onClick: () => refine(),
  }, icon('wand', 14), h('span', { class: 'btn-label' }, '주제 다듬기'));
  const refinePanel = h('div', { class: 'refine-slot', 'aria-live': 'polite' });
  function refineBlock() {
    if (ta.value.trim().length < REFINE_MIN) return { reason: `주제를 ${REFINE_MIN}자 이상 적으면 다듬을 수 있습니다.`, key: false };
    if (!getApiKey()) return { reason: 'API 키가 있어야 다듬을 수 있습니다. 누르면 키 창이 열립니다.', key: true };
    return null;
  }
  function updateRefineBtn() {
    const b = refineBlock();
    refineBtn.setAttribute('aria-disabled', b ? 'true' : 'false');
    refineBtn.classList.toggle('is-disabled', !!b);
    refineBtn.title = b ? b.reason : '에이전트가 이해하기 좋게 주제를 세 가지 방향으로 다듬어 제안합니다.';
  }
  function closeRefine() { refinePanel.replaceChildren(); }
  /** 제안 패널이 아래에 붙은 프롬프트 입력 뒤로 가려지면, 가려진 만큼 화면을 내려 전부 보이게 한다 */
  function revealRefine() {
    const box = refinePanel.firstElementChild;
    const composerEl = container.querySelector('.composer');
    if (!box || !composerEl) return;
    const hidden = box.getBoundingClientRect().bottom - composerEl.getBoundingClientRect().top;
    if (hidden > -8) window.scrollBy({ top: hidden + 8, behavior: reducedMotion() ? 'auto' : 'smooth' });
  }
  function refineShell(...content) {
    return h('section', { class: 'card refine-panel', 'aria-label': '주제 다듬기 제안' },
      h('div', { class: 'refine-head' },
        h('div', { class: 'refine-head-text' },
          h('h2', { class: 'card-title' }, '주제 다듬기'),
          h('span', { class: 'refine-note' }, 'Claude Haiku 5.5로 다듬습니다(비용은 거의 없습니다).')),
        h('button', { type: 'button', class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': '제안 닫기', onClick: closeRefine }, icon('x', 16))),
      ...content);
  }
  function applySuggestion(text, mode) {
    const prev = ta.value;
    const next = mode === 'replace' ? text : `${prev.trimEnd()}\n\n${text}`;
    ta.value = next;
    ta.dispatchEvent(new Event('input'));
    ta.focus();
    toast(mode === 'replace' ? '다듬은 주제로 바꿨습니다.' : '제안을 아래에 덧붙였습니다.', 'success', {
      duration: 8000,
      action: { label: '되돌리기', onClick: () => { ta.value = prev; ta.dispatchEvent(new Event('input')); ta.focus(); } },
    });
  }
  function renderSuggestions(res) {
    const suggestions = arr(res?.suggestions).filter((x) => x && str(x.prompt).trim());
    const questions = arr(res?.questions).map((q) => str(q).trim()).filter(Boolean);
    if (!suggestions.length) {
      refinePanel.replaceChildren(refineShell(h('p', { class: 'field-error' }, icon('alert-triangle', 14), h('span', null, '제안을 받지 못했습니다. 다시 시도해 주세요.'))));
      return;
    }
    refinePanel.replaceChildren(refineShell(
      h('div', { class: 'refine-grid' }, suggestions.map((sg) => h('article', { class: 'refine-card' },
        str(sg.focus).trim() ? badge(str(sg.focus).trim(), 'accent') : null,
        h('p', { class: 'refine-prompt' }, str(sg.prompt).trim()),
        str(sg.why).trim() ? h('p', { class: 'refine-why' }, str(sg.why).trim()) : null,
        h('div', { class: 'refine-actions' },
          button('이걸로 바꾸기', { kind: 'primary', size: 'sm', onClick: () => applySuggestion(str(sg.prompt).trim(), 'replace') }),
          button('아래에 덧붙이기', { kind: 'secondary', size: 'sm', onClick: () => applySuggestion(str(sg.prompt).trim(), 'append') }))))),
      questions.length ? h('div', { class: 'refine-questions' },
        h('div', { class: 'refine-q-title' }, '정해 두면 좋은 점'),
        h('ul', null, questions.map((q) => h('li', null, q)))) : null));
  }
  async function refine() {
    if (refining) return;
    const b = refineBlock();
    if (b) {
      if (b.key) openKeyDialog();
      else ta.focus();
      return;
    }
    refining = true;
    setBusy(refineBtn, true, '다듬는 중…');
    refinePanel.replaceChildren(refineShell(h('div', { class: 'refine-loading' }, skeleton(3))));
    revealRefine();
    try {
      const res = await api.refinePrompt({ api_key: getApiKey(), prompt: ta.value.trim(), language: st.language });
      if (refineBtn.isConnected) { renderSuggestions(res); revealRefine(); }
    } catch (err) {
      if (!refineBtn.isConnected) return;
      const keyIssue = ['no_api_key', 'auth'].includes(str(err?.code));
      refinePanel.replaceChildren(refineShell(h('div', { class: 'field-error', role: 'alert' }, icon('alert-triangle', 14),
        h('span', null, str(err?.message, '주제를 다듬지 못했습니다. 잠시 후 다시 시도해 주세요.')),
        keyIssue ? button('API 키 확인', { kind: 'secondary', size: 'sm', icon: 'key', onClick: () => openKeyDialog() }) : null)));
    } finally {
      refining = false;
      if (refineBtn.isConnected) { setBusy(refineBtn, false); updateRefineBtn(); }
    }
  }

  const promptCard = h('div', { class: 'prompt-card', onClick: (e) => { if (e.target === promptCard) ta.focus(); } },
    ta,
    h('div', { class: 'prompt-foot' }, exampleRow, h('div', { class: 'prompt-foot-end' }, refineBtn, counter)));

  // ───────────────── 2. 모델 ─────────────────
  const modelName = uid('model');
  const modelGrid = h('div', { class: 'sel-rows', role: 'radiogroup', 'aria-label': '모델' });
  const modelNote = h('div', { class: 'section-note', hidden: true });

  function modelAvailability() {
    const ks = store.get().keyStatus || {};
    if (ks.state === 'ok' && Array.isArray(ks.models)) {
      // 키 확인이 돌려준 ID가 설정 ID와 같거나 "설정 ID-날짜" 꼴이면 같은 모델로 본다
      const returned = ks.models.map((x) => str(x)).filter(Boolean);
      const has = (id) => returned.some((r) => r === id || r.startsWith(`${id}-`));
      // 설정한 모델이 하나도 맞지 않으면 ID 체계가 다른 것이므로 알 수 없음으로 두고 막지 않는다
      if (!models.some((m) => has(m.id))) return () => true;
      return has;
    }
    return () => true;
  }

  function renderModels() {
    const ok = modelAvailability();
    if (!ok(st.model)) {
      const first = models.find((m) => ok(m.id));
      const prev = modelObj();
      if (first) {
        st.model = first.id;
        modelNote.replaceChildren(icon('info', 14), h('span', null, `${str(prev?.label, '선택한 모델')}은 이 키로 사용할 수 없어 ${str(first.label)}로 바꿨습니다.`));
        modelNote.hidden = false;
      }
    }
    // 다시 그려도 방향키로 고르던 초점이 사라지지 않게 선택된 칸으로 돌려준다
    const hadFocus = modelGrid.contains(document.activeElement);
    // 패널이 좁으므로 세로 라디오 줄: 이름 · 배지 · 가격, 아래 작은 설명
    modelGrid.replaceChildren(...models.map((m) => {
      const available = ok(m.id);
      const selected = st.model === m.id;
      const ip = num(m.input_per_mtok);
      const op = num(m.output_per_mtok);
      const input = h('input', {
        type: 'radio', name: modelName, value: m.id, class: 'sr-only', checked: selected, disabled: !available,
        onChange: () => { st.model = m.id; modelNote.hidden = true; clearError('model'); renderModels(); renderEstimate(); },
      });
      return h('label', {
        class: ['sel-row', selected ? 'is-selected' : '', available ? '' : 'is-disabled'],
        title: str(m.description) || null,
      },
      input,
      h('span', { class: 'sel-dot', 'aria-hidden': 'true' }),
      h('span', { class: 'sel-row-main' },
        h('span', { class: 'sel-row-head' },
          h('span', { class: 'sel-title' }, str(m.label, m.id)),
          str(m.badge) ? h('span', { class: 'badge badge-accent' }, m.badge) : null,
          h('span', { class: 'sel-row-meta num' },
            ip !== null && op !== null ? `입력 $${trimNum(ip)} · 출력 $${trimNum(op)}` : '가격 정보 없음')),
        str(m.tagline) ? h('span', { class: 'sel-desc' }, str(m.tagline)) : null,
        available ? null : h('span', { class: 'sel-unavail' }, icon('x', 12), '이 키로 사용 불가')));
    }));
    if (hadFocus) modelGrid.querySelector('input:checked')?.focus();
  }

  // ───────────────── 3. 깊이 ─────────────────
  const depthName = uid('depth');
  const depthGrid = h('div', { class: 'sel-rows', role: 'radiogroup', 'aria-label': '조사 깊이' });
  function renderDepths() {
    const hadFocus = depthGrid.contains(document.activeElement);
    depthGrid.replaceChildren(...depths.map((d) => {
      const selected = st.depth === d.id;
      const mins = arr(obj(d.estimate).minutes);
      return h('label', { class: ['sel-row', selected ? 'is-selected' : ''] },
        h('input', {
          type: 'radio', name: depthName, value: d.id, class: 'sr-only', checked: selected,
          onChange: () => { setDepth(d.id); },
        }),
        h('span', { class: 'sel-dot', 'aria-hidden': 'true' }),
        h('span', { class: 'sel-row-main' },
          h('span', { class: 'sel-row-head' },
            h('span', { class: 'sel-title' }, str(d.label, d.id)),
            mins.length === 2 ? h('span', { class: 'sel-row-meta' }, icon('clock', 12), h('span', { class: 'num' }, `약 ${mins[0]}~${mins[1]}분`)) : null),
          str(d.description) ? h('span', { class: 'sel-desc' }, str(d.description)) : null));
    }));
    if (hadFocus) depthGrid.querySelector('input:checked')?.focus();
  }
  function setDepth(id) {
    st.depth = id;
    // 직접 고치지 않은 값만 새 프리셋으로 바꾼다
    for (const { key } of ADVANCED) {
      if (!st.overrides.has(key)) st.adv[key] = presetValue(key);
      else if (st.adv[key] === presetValue(key)) st.overrides.delete(key);
    }
    renderDepths();
    renderAdvanced();
    renderEstimate();
  }

  // ───────────────── 4. 결과물 ─────────────────
  const formatWrap = h('div', { class: 'format-groups' });
  function renderFormats() {
    formatWrap.replaceChildren(...FORMAT_GROUPS.map((g) => {
      const items = formats.filter((f) => g.groups.includes(f.group));
      if (!items.length) return null;
      const notes = items.filter((f) => f.available === false);
      return h('div', { class: 'format-group', role: 'group', 'aria-label': g.label },
        h('div', { class: 'format-group-label' }, g.label),
        h('div', { class: 'chips' }, items.map((f) => {
          const on = st.formats.has(f.id);
          return h('label', { class: ['chip', 'chip-select', on ? 'is-selected' : '', f.available === false ? 'is-limited' : ''], title: str(f.description) || null },
            h('input', {
              type: 'checkbox', class: 'sr-only', checked: on,
              onChange: (e) => {
                if (!e.target.checked && st.formats.size <= 1) {
                  e.target.checked = true;
                  showError('formats', '결과물은 최소 1개를 골라야 합니다.');
                  return;
                }
                if (e.target.checked) st.formats.add(f.id); else st.formats.delete(f.id);
                clearError('formats');
                renderFormats();
                formatWrap.querySelector(`input[data-id="${f.id}"]`)?.focus();
              },
              dataset: { id: f.id },
            }),
            h('span', { class: 'chip-check', 'aria-hidden': 'true' }, icon(on ? 'check' : 'plus', 12)),
            h('span', { class: 'chip-text' }, str(f.label, f.id)),
            f.available === false ? icon('info', 12, 'chip-flag') : null);
        })),
        notes.map((f) => h('p', { class: 'format-note' }, icon('info', 12),
          h('span', null, `${str(f.label, f.id)}: ${str(f.note, '지금은 만들 수 없습니다.')}${f.id === 'pdf' ? ' 선택하면 인쇄 창에서 PDF로 저장할 수 있게 안내합니다.' : ''}`))));
    }));
  }

  // ───────────────── 5. 옵션 ─────────────────
  const hitlId = uid('hitl');
  const hitlSwitch = h('button', {
    type: 'button', role: 'switch', id: hitlId, class: 'switch', 'aria-checked': st.hitl ? 'true' : 'false',
    'aria-labelledby': `${hitlId}-label`, 'aria-describedby': `${hitlId}-desc`,
    onClick: () => {
      st.hitl = !st.hitl;
      hitlSwitch.setAttribute('aria-checked', st.hitl ? 'true' : 'false');
    },
  }, h('span', { class: 'switch-thumb' }));
  const hitlRow = h('div', { class: 'option-row' },
    h('div', { class: 'option-text' },
      h('label', { class: 'option-title', id: `${hitlId}-label`, htmlFor: hitlId }, '조사 계획을 먼저 검토하기'),
      h('p', { class: 'option-desc', id: `${hitlId}-desc` }, '에이전트가 세운 하위 질문을 확인하고 고친 뒤에 검색을 시작합니다. 검토하는 동안 조사는 멈춰 있습니다.')),
    hitlSwitch);

  // 끝나면 알림 받기 (F4) — prefs.notify. 알림을 지원하지 않는 브라우저에서는 숨긴다.
  const notifyId = uid('notify');
  const notifySwitch = h('button', {
    type: 'button', role: 'switch', id: notifyId, class: 'switch', 'aria-checked': st.notify ? 'true' : 'false',
    'aria-labelledby': `${notifyId}-label`, 'aria-describedby': `${notifyId}-desc`,
    onClick: () => toggleNotify(),
  }, h('span', { class: 'switch-thumb' }));
  function setNotify(on) {
    st.notify = !!on;
    notifySwitch.setAttribute('aria-checked', st.notify ? 'true' : 'false');
    savePrefs({ notify: st.notify });
  }
  async function toggleNotify() {
    if (st.notify) { setNotify(false); return; }
    let perm = Notification.permission;
    if (perm === 'default') {
      try {
        perm = await new Promise((resolve) => {
          const r = Notification.requestPermission((v) => resolve(v));
          if (r && typeof r.then === 'function') r.then(resolve, () => resolve('denied'));
        });
      } catch { perm = 'denied'; }
    }
    if (perm === 'granted') {
      setNotify(true);
      toast('조사가 끝나거나 검토가 필요하면 알려 드립니다.', 'success');
    } else {
      setNotify(false);
      toast(perm === 'denied'
        ? '브라우저에서 이 사이트의 알림이 차단되어 있습니다. 주소창의 사이트 설정에서 알림을 허용한 뒤 다시 켜 주세요.'
        : '알림을 허용하지 않아 스위치를 껐습니다.', 'info', { duration: 7000 });
    }
  }
  const notifyRow = NOTIFY_SUPPORTED ? h('div', { class: 'option-row' },
    h('div', { class: 'option-text' },
      h('label', { class: 'option-title', id: `${notifyId}-label`, htmlFor: notifyId }, '끝나면 알림 받기'),
      h('p', { class: 'option-desc', id: `${notifyId}-desc` }, '다른 탭을 보고 있어도 조사가 끝나거나 계획 검토가 필요할 때 데스크톱 알림과 짧은 소리로 알려 드립니다.')),
    notifySwitch) : null;

  // 검색 시작 연도
  const yearName = uid('year');
  const [yLo, yHi] = bounds('year_from');
  const yearInput = h('input', {
    type: 'number', class: 'input input-num num', min: yLo, max: yHi, step: 1, inputmode: 'numeric',
    'aria-label': '검색 시작 연도', placeholder: String(yHi - 4),
  });
  yearInput.value = st.year;
  yearInput.addEventListener('input', () => { st.year = yearInput.value; clearError('year'); });
  yearInput.addEventListener('blur', () => {
    const v = Number(yearInput.value);
    if (yearInput.value && Number.isFinite(v)) { st.year = String(Math.min(yHi, Math.max(yLo, Math.round(v)))); yearInput.value = st.year; }
  });
  const yearSeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': '검색 시작 연도' });
  function renderYear() {
    yearSeg.replaceChildren(...YEAR_MODES.map(([id, label]) => h('label', { class: ['seg-btn', st.yearMode === id ? 'is-on' : ''] },
      h('input', {
        type: 'radio', name: yearName, class: 'sr-only', value: id, checked: st.yearMode === id,
        onChange: () => {
          st.yearMode = id;
          if (id === 'custom' && !st.year) { st.year = String(yHi - 4); yearInput.value = st.year; }
          renderYear();
          if (id === 'custom') yearInput.focus();
          clearError('year');
        },
      }), label)));
    yearInput.hidden = st.yearMode !== 'custom';
    yearUnit.hidden = st.yearMode !== 'custom';
  }
  const yearUnit = h('span', { class: 'field-unit' }, '년 이후');

  // 보고서 언어
  const langName = uid('lang');
  const langSeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': '보고서 언어' });
  function renderLang() {
    langSeg.replaceChildren(...LANGS.map(([id, label]) => h('label', { class: ['seg-btn', st.language === id ? 'is-on' : ''] },
      h('input', {
        type: 'radio', name: langName, class: 'sr-only', value: id, checked: st.language === id,
        onChange: () => { st.language = id; renderLang(); },
      }), label)));
  }

  // 비용 한도 (F5): 0.5 단위, 0~100, "한도 없음". 기본값 = 예상 비용 × 1.5를 0.5 단위로 올림.
  const [costLo, costHi] = (() => {
    const b = limits.max_cost_usd;
    return Array.isArray(b) && b.length === 2 ? [Number(b[0]) || 0, Number(b[1]) || 100] : [0, 100];
  })();
  const roundCost = (v) => Math.min(costHi, Math.max(costLo, Math.round(v / COST_STEP) * COST_STEP));
  const costId = uid('maxcost');
  const costInput = h('input', {
    id: costId, type: 'number', class: 'input input-num input-cost num', min: costLo, max: costHi, step: COST_STEP, inputmode: 'decimal',
    'aria-describedby': `${costId}-hint`,
  });
  const noCapBox = h('input', { type: 'checkbox', class: 'checkbox', checked: st.noCap });
  const costReset = h('button', { type: 'button', class: 'link-btn', hidden: true, onClick: () => { st.costTouched = false; st.noCap = false; noCapBox.checked = false; syncCost(); renderEstimate(); } }, '예상치에 맞추기');
  const costTag = h('span', { class: 'tag tag-accent', hidden: true }, '직접 설정');
  function defaultCost() {
    const c = estimateCost();
    return c === null ? null : Math.min(costHi, Math.max(costLo, Math.ceil((c * 1.5) / COST_STEP) * COST_STEP));
  }
  function capValue() {
    if (st.noCap) return null;
    if (!st.costTouched || num(st.maxCost) === null) st.maxCost = defaultCost();
    return num(st.maxCost);
  }
  function syncCost(force = false) {
    const v = capValue();
    if (force || document.activeElement !== costInput) costInput.value = v === null ? '' : trimNum(v);
    costInput.disabled = st.noCap;
    costTag.hidden = !st.costTouched;
    costReset.hidden = !st.costTouched;
  }
  costInput.addEventListener('change', () => {
    const v = Number(costInput.value);
    if (costInput.value === '' || !Number.isFinite(v)) { st.costTouched = false; }
    else { st.maxCost = roundCost(v); st.costTouched = true; }
    syncCost(true);
    renderEstimate();
  });
  costInput.addEventListener('blur', () => syncCost());
  // "한도 없음"을 켜기 전의 직접 설정 여부를 기억해 두었다가 끌 때 되돌린다
  let touchedBeforeNoCap = st.noCap ? false : st.costTouched;
  noCapBox.addEventListener('change', () => {
    if (noCapBox.checked) {
      touchedBeforeNoCap = st.costTouched && !st.noCap;
      st.noCap = true;
      st.costTouched = true;
    } else {
      st.noCap = false;
      st.costTouched = touchedBeforeNoCap;
      if (!touchedBeforeNoCap) st.maxCost = null; // 예상치를 다시 따라가게 한다
    }
    syncCost();
    renderEstimate();
    if (!st.noCap) costInput.focus();
  });
  const costField = h('div', { class: 'adv-field adv-field-wide adv-cost' },
    h('div', { class: 'adv-field-head' },
      h('label', { class: 'field-label', htmlFor: costId }, '최대 비용(USD)'), costTag, costReset),
    h('div', { class: 'adv-cost-row' },
      h('span', { class: 'stepper-input' }, h('span', { class: 'field-unit' }, '$'), costInput),
      h('label', { class: 'check-row check-inline' }, noCapBox, h('span', { class: 'check-title' }, '한도 없음'))),
    h('p', { class: 'field-hint', id: `${costId}-hint` }, `한도에 닿으면 추가 조사를 멈추고 그때까지 모은 근거로 보고서를 씁니다. ${trimNum(costLo)}~${trimNum(costHi)}달러, ${COST_STEP}달러 단위. 웹 검색 요금(1,000회에 $10)도 포함해 계산합니다.`));

  // 숫자 설정: "이름 — 스테퍼" 한 줄씩, 설명은 아래 작은 글씨 한 줄
  const advRows = h('div', { class: 'adv-grid' });
  function numberField(def) {
    const { key, label, hint, unit } = def;
    const [lo, hi] = bounds(key);
    const id = uid(key);
    const input = h('input', {
      id, type: 'number', class: 'input input-num num', min: lo, max: hi, step: 1, inputmode: 'numeric',
      'aria-describedby': `${id}-hint`,
    });
    input.value = String(st.adv[key]);
    const commit = (v) => {
      if (!Number.isFinite(v)) v = presetValue(key);
      st.adv[key] = clamp(key, v);
      if (st.adv[key] === presetValue(key)) st.overrides.delete(key); else st.overrides.add(key);
      renderAdvanced();
      renderEstimate();
    };
    input.addEventListener('change', () => commit(Number(input.value)));
    const dec = h('button', { type: 'button', class: 'step-btn', 'aria-label': `${label} 줄이기`, disabled: st.adv[key] <= lo, onClick: () => { commit(st.adv[key] - 1); advRows.querySelector(`#${id}`)?.focus(); } }, icon('minus', 14));
    const inc = h('button', { type: 'button', class: 'step-btn', 'aria-label': `${label} 늘리기`, disabled: st.adv[key] >= hi, onClick: () => { commit(st.adv[key] + 1); advRows.querySelector(`#${id}`)?.focus(); } }, icon('plus', 14));
    const custom = st.overrides.has(key);
    return h('div', { class: ['adv-field', 'adv-num', custom ? 'is-custom' : ''] },
      h('div', { class: 'adv-num-row' },
        h('div', { class: 'adv-field-head' },
          h('label', { class: 'field-label', htmlFor: id }, label),
          custom ? h('span', { class: 'tag tag-accent' }, '직접 설정') : null,
          custom ? h('button', {
            type: 'button', class: 'link-btn', onClick: () => { commit(presetValue(key)); },
            title: `깊이 프리셋 값(${presetValue(key)})으로 되돌리기`,
          }, '되돌리기') : null),
        h('div', { class: 'stepper-input' }, dec, input, inc, h('span', { class: 'field-unit' }, unit))),
      h('p', { class: 'field-hint', id: `${id}-hint` }, `${hint} · ${lo}~${hi}`));
  }
  function renderAdvanced() {
    const focusedId = document.activeElement && advRows.contains(document.activeElement) ? document.activeElement.id : null;
    advRows.replaceChildren(...ADVANCED.map(numberField));
    if (focusedId) advRows.querySelector(`#${focusedId}`)?.focus();
  }

  // 고급 설정: 접지 않고 패널 안에 항상 펼쳐 둔다(LAYOUT_V2 3절)
  const advancedBody = h('div', { class: 'sp-adv' },
    h('div', { class: 'adv-field adv-field-wide' },
      h('div', { class: 'adv-field-head' }, h('span', { class: 'field-label' }, '검색 시작 연도')),
      h('div', { class: 'adv-year' }, yearSeg, h('span', { class: 'adv-year-input' }, yearInput, yearUnit)),
      errSlot('year'),
      h('p', { class: 'field-hint' }, '에이전트가 결정하면 주제에 맞는 시작 연도와 그 이유를 함께 기록합니다.')),
    h('div', { class: 'adv-field' },
      h('div', { class: 'adv-field-head' }, h('span', { class: 'field-label' }, '보고서 언어')),
      langSeg,
      h('p', { class: 'field-hint' }, '자동이면 입력한 주제의 언어를 따릅니다.')),
    costField,
    advRows);

  // ───────────────── 6. 예상치 ─────────────────
  // 자세한 예상치는 패널 아래(.sp-foot), 한 줄 요약은 프롬프트 아래(.composer-est). renderEstimate()가 둘 다 고친다.
  const estMain = h('div', { class: 'estimate-main' });
  const estSub = h('div', { class: 'estimate-sub' });
  const estLine = h('div', { class: 'composer-est num', 'aria-live': 'polite' });
  const toggleSum = h('span', { class: 'panel-toggle-sum' });
  function renderToggleSummary() {
    const m = modelObj();
    const model = m ? str(m.label, m.id).replace(/^Claude\s+/, '') : '';
    toggleSum.textContent = [model, str(depthObj().label)].filter(Boolean).join(' · ');
  }
  function estimateCost() {
    const est = obj(depthObj().estimate);
    const m = modelObj();
    if (m && num(est.input_tokens) !== null && num(est.output_tokens) !== null && num(m.input_per_mtok) !== null && num(m.output_per_mtok) !== null) {
      let cost = (est.input_tokens * m.input_per_mtok + est.output_tokens * m.output_per_mtok) / 1e6;
      // 웹 검색 요금(검색 횟수는 대략치). 둘 중 하나라도 없으면 더하지 않는다.
      const searches = num(est.web_searches);
      const perSearch = num(cfg.web_search_usd);
      if (st.webSearch && searches !== null && perSearch !== null) cost += searches * perSearch;
      return cost;
    }
    return null;
  }
  function renderEstimate() {
    const d = depthObj();
    const est = obj(d.estimate);
    const calls = num(est.llm_calls);
    const mins = arr(est.minutes);
    const cost = estimateCost();
    syncCost();
    const cap = capValue();
    const parts = [];
    if (calls !== null) parts.push(h('span', null, 'LLM 호출 약 ', h('b', { class: 'num' }, fmtInt(calls)), '회'));
    if (mins.length === 2) parts.push(h('span', null, h('b', { class: 'num' }, `${mins[0]}~${mins[1]}`), '분'));
    parts.push(h('span', null, '예상 비용 약 ', h('b', { class: 'num' }, fmtCost(cost))));
    parts.push(h('span', { class: 'estimate-cap' }, st.noCap || cap === null ? '한도 없음' : h('span', null, '한도 ', h('b', { class: 'num' }, `$${trimNum(cap)}`))));
    estMain.replaceChildren(...parts.flatMap((p, i) => (i ? [h('span', { class: 'dot-sep', 'aria-hidden': 'true' }, '·'), p] : [p])));
    const sub = [];
    sub.push(est.measured ? '실제 실행 2회 평균 기준' : '추정');
    if (st.overrides.size) sub.push('고급 설정을 바꾸면 달라질 수 있음');
    if (str(cfg.pricing_as_of)) sub.push(`가격 기준일 ${cfg.pricing_as_of}`);
    estSub.textContent = sub.join(' · ');
    // 한 줄 요약: "약 $4.45 · 12~24분 · 한도 $7"
    const line = [`약 ${fmtCost(cost)}`];
    if (mins.length === 2) line.push(`${mins[0]}~${mins[1]}분`);
    line.push(st.noCap || cap === null ? '한도 없음' : `한도 $${trimNum(cap)}`);
    estLine.textContent = line.join(' · ');
    renderToggleSummary();
  }

  const startBtn = h('button', { type: 'button', class: 'btn btn-primary btn-lg btn-start', onClick: () => start() },
    icon('play', 16), h('span', { class: 'btn-label' }, '조사 시작'));

  // ───────────────── 조립 ─────────────────
  // 키 확인 실패 안내: 키 상태가 바뀔 때마다 다시 그린다
  const keyNote = h('div', { class: 'section-note is-error', hidden: true });
  function renderKeyNote() {
    const ks = store.get().keyStatus || {};
    keyNote.hidden = ks.state !== 'error';
    keyNote.replaceChildren(...(ks.state === 'error'
      ? [icon('alert-triangle', 14), h('span', null, `API 키 확인 실패: ${str(ks.message, '알 수 없는 오류')}`)]
      : []));
  }
  // 패널 구역: 제목 + 작은 설명 한 줄
  const spSec = (title, note, ...body) => {
    const id = uid('sp-sec');
    return h('section', { class: 'sp-sec', 'aria-labelledby': id },
      h('div', { class: 'sp-sec-head' },
        h('h3', { class: 'sp-sec-title', id }, title),
        note ? h('p', { class: 'sp-sec-note' }, note) : null),
      ...body);
  };

  const onboarding = composeOnboarding(null);
  cleanups.push(() => onboarding.destroy());
  const history = mountHistory();
  cleanups.push(() => history.destroy());

  // ── 조사 설정 패널 (넓은 화면: 오른쪽 열 / 좁은 화면: 오른쪽 시트) ──
  const panelId = uid('settings');
  const spTitle = h('h2', { class: 'sp-title', tabindex: '-1' }, '조사 설정');
  const spClose = h('button', {
    type: 'button', class: 'btn btn-ghost btn-icon btn-sm sp-close', 'aria-label': '조사 설정 닫기', onClick: () => closePanel(),
  }, icon('x', 16));
  const spBody = h('div', { class: 'sp-body' },
    spSec('모델', str(cfg.pricing_as_of) ? `100만 토큰당 가격 · ${cfg.pricing_as_of} 기준` : '100만 토큰당 가격',
      keyNote, modelGrid, modelNote, errSlot('model')),
    spSec('조사 깊이', '깊을수록 오래 걸리고 비용이 늘어납니다', depthGrid),
    spSec('결과물', '조사가 끝나면 자동으로 만듭니다. 다른 형식은 나중에도 받을 수 있습니다', formatWrap, errSlot('formats')),
    spSec('옵션', null, h('div', { class: 'sp-options' }, hitlRow, notifyRow)),
    spSec('고급 설정', null, advancedBody));
  panel = h('aside', { class: 'settings-panel', id: panelId, 'aria-label': '조사 설정' },
    h('div', { class: 'sp-head' }, spTitle, spClose),
    spBody,
    h('div', { class: 'sp-foot' },
      h('div', { class: 'sp-foot-label' }, '예상치'),
      h('div', { class: 'estimate' }, estMain, estSub)));
  const scrim = h('div', { class: 'sp-scrim', 'aria-hidden': 'true', onClick: () => closePanel() });

  const panelToggle = h('button', {
    type: 'button', class: 'btn btn-secondary btn-sm panel-toggle', 'aria-expanded': 'false', 'aria-controls': panelId,
    onClick: () => (panelOpen ? closePanel() : openPanel()),
  }, icon('sliders', 16), h('span', { class: 'btn-label' }, '조사 설정'), toggleSum);

  // ── 프롬프트 입력(아래쪽에 붙음) ──
  const composer = h('div', { class: 'composer' },
    promptCard,
    errSlot('prompt'),
    errSlot('run'),
    h('div', { class: 'composer-foot' },
      panelToggle,
      estLine,
      h('span', { class: 'kbd-hint', 'aria-hidden': 'true' }, h('kbd', null, 'Ctrl'), '+', h('kbd', null, 'Enter')),
      startBtn));

  const home = h('div', { class: 'home' },
    h('div', { class: 'home-main' },
      h('div', { class: 'home-top' },
        onboarding.el,
        h('header', { class: 'page-head' },
          h('h1', { class: 'page-title' }, '무엇을 조사할까요?'),
          h('p', { class: 'page-sub' }, '주제를 적으면 에이전트가 하위 질문을 세우고 학술 문헌을 찾아 읽은 뒤, 인용을 검증한 보고서를 씁니다.')),
        prefill ? h('div', { class: 'note note-info home-note' }, icon('refresh', 16), h('span', null, '이전 조사의 주제와 설정을 불러왔습니다. 고칠 부분을 고친 뒤 시작하세요.')) : null),
      h('div', { class: 'home-bottom' },
        history.el,
        refinePanel,
        composer)),
    scrim,
    panel);
  container.append(home);

  // ── 좁은 화면(≤1099px): 패널 시트 열고 닫기 (LAYOUT_V2 3.1) ──
  const mq = window.matchMedia(NARROW_QUERY);
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let panelOpen = false;
  /** 시트가 열려 있는 동안 가림막 뒤(가운데 열·왼쪽 레일·위쪽 띠)는 초점과 보조 기술에서 빠진다 */
  function setBackgroundInert(on) {
    const homeMain = home.querySelector('.home-main');
    if (homeMain) homeMain.inert = on;
    for (const sel of ['.rail', '.banners']) document.querySelector(sel)?.toggleAttribute('inert', on);
  }
  function setPanel(open) {
    panelOpen = open;
    home.classList.toggle('is-panel-open', open);
    panelToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    const sheet = open && mq.matches;
    document.body.classList.toggle('has-sheet', sheet);
    setBackgroundInert(sheet);
  }
  function openPanel({ focus = true } = {}) {
    if (!mq.matches) return; // 넓은 화면에서는 늘 보인다
    setPanel(true);
    if (focus) spTitle.focus({ preventScroll: true });
  }
  function closePanel() {
    if (!panelOpen) return;
    setPanel(false);
    if (mq.matches) panelToggle.focus();
  }
  revealInPanel = (el) => {
    if (mq.matches && !panelOpen) openPanel({ focus: false });
    requestAnimationFrame(() => {
      if (!el.isConnected) return;
      // 시트가 막 열렸고 초점이 아직 바깥(시작 버튼 등)에 있으면 패널 제목으로 옮긴다
      if (mq.matches && panelOpen && !panel.contains(document.activeElement)) spTitle.focus({ preventScroll: true });
      const target = el.closest('.adv-field') || el.closest('.sp-sec') || el;
      const t = target.getBoundingClientRect();
      const e = el.getBoundingClientRect();
      const b = spBody.getBoundingClientRect();
      if (t.top < b.top || e.bottom > b.bottom) {
        spBody.scrollTo({ top: Math.max(0, spBody.scrollTop + (t.top - b.top) - 12), behavior: reducedMotion() ? 'auto' : 'smooth' });
      }
    });
  };
  const onMq = () => {
    if (!mq.matches) setPanel(false); // 넓어지면 시트 상태를 풀고 오른쪽 열로 돌아간다
    else { document.body.classList.toggle('has-sheet', panelOpen); setBackgroundInert(panelOpen); }
  };
  if (mq.addEventListener) mq.addEventListener('change', onMq); else mq.addListener(onMq);
  cleanups.push(() => {
    if (mq.removeEventListener) mq.removeEventListener('change', onMq); else mq.removeListener(onMq);
    document.body.classList.remove('has-sheet');
    setBackgroundInert(false);
  });

  // 프롬프트 칸 높이(토스트 위치)와 위쪽 띠 높이(처음 화면 최소 높이)를 CSS 변수로 알려 준다
  // 아래에 붙은 프롬프트 칸 뒤로 초점이 숨지 않도록, 그 높이만큼을 문서 스크롤의 아래 여백으로 잡는다
  // (키보드로 기록 카드나 다듬기 제안에 초점이 가면 브라우저가 프롬프트 칸 위로 올려 보여 준다).
  if (typeof ResizeObserver === 'function') {
    const banners = document.querySelector('.banners');
    const measure = () => {
      if (!composer.isConnected) return;
      const ch = Math.round(composer.offsetHeight);
      document.body.style.setProperty('--composer-h', `${ch}px`);
      document.documentElement.style.scrollPaddingBottom = `${ch + 24}px`;
      home.style.setProperty('--banner-h', `${banners && banners.isConnected ? Math.round(banners.offsetHeight) : 0}px`);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(composer);
    if (banners) ro.observe(banners);
    measure(); // 첫 화면부터 맞는 값으로(관찰 콜백은 다음 프레임에 온다)
    cleanups.push(() => {
      ro.disconnect();
      document.body.style.removeProperty('--composer-h');
      document.documentElement.style.removeProperty('scroll-padding-bottom');
    });
  }

  renderKeyNote();
  renderModels();
  renderDepths();
  renderFormats();
  renderYear();
  renderLang();
  renderAdvanced();
  renderEstimate();
  updateCounter();
  updateRefineBtn();
  requestAnimationFrame(() => {
    autosize(ta, promptMaxHeight());
    if (!st.prompt) ta.focus({ preventScroll: true });
  });

  // 키 확인 결과가 바뀌면 모델 가용성을 다시 그린다
  cleanups.push(store.subscribe((s, p) => {
    if (s.keyStatus !== p.keyStatus) { renderKeyNote(); renderModels(); renderEstimate(); updateRefineBtn(); }
  }));

  // Ctrl+Enter로 시작 · Esc로 (좁은 화면의) 조사 설정 시트 닫기
  const onKey = (e) => {
    if (e.key === 'Escape' && panelOpen && mq.matches && !e.defaultPrevented && !document.querySelector('.modal-root')) {
      e.preventDefault();
      closePanel();
      return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !document.querySelector('.modal-root')) {
      e.preventDefault();
      start();
    }
  };
  document.addEventListener('keydown', onKey);
  cleanups.push(() => document.removeEventListener('keydown', onKey));
  // 아래에 붙은 프롬프트 입력 위로 토스트를 올린다(토스트 위치 규칙 재사용)
  document.body.classList.add('has-runbar');
  cleanups.push(() => document.body.classList.remove('has-runbar'));

  // ── 시작 ──
  function validate() {
    clearError();
    const prompt = ta.value.trim();
    if (!prompt) {
      showError('prompt', '조사할 주제나 질문을 적어 주세요.');
      ta.focus();
      return false;
    }
    if (prompt.length > MAX_PROMPT) {
      showError('prompt', `주제는 ${fmtInt(MAX_PROMPT)}자까지 적을 수 있습니다. 지금 ${fmtInt(prompt.length)}자입니다.`);
      ta.focus();
      return false;
    }
    if (!st.model) {
      showError('model', '모델을 골라 주세요.');
      return false;
    }
    if (!modelAvailability()(st.model)) {
      showError('model', '이 키로는 선택한 모델을 쓸 수 없습니다. 다른 모델을 골라 주세요.');
      return false;
    }
    if (!st.formats.size) {
      showError('formats', '결과물은 최소 1개를 골라야 합니다.');
      return false;
    }
    if (st.yearMode === 'custom') {
      const y = Number(st.year);
      if (!st.year || !Number.isFinite(y) || y < yLo || y > yHi) {
        showError('year', `시작 연도는 ${yLo}~${yHi} 사이로 적어 주세요.`);
        yearInput.focus();
        return false;
      }
    }
    if (!getApiKey()) {
      // 키가 없으면 키 창을 열고, 그 안에서 키 없이 데모로 볼 수도 있게 한다(F1). 적은 주제는 그대로 둔다.
      showError('run', 'Anthropic API 키가 필요합니다. 키 없이 둘러보려면 데모를 실행하세요.',
        button('API 키 입력', { kind: 'secondary', size: 'sm', icon: 'key', onClick: () => openKeyDialog({ offerDemo: true }) }));
      saveDraft(ta.value);
      openKeyDialog({ offerDemo: true });
      return false;
    }
    // 키 확인이 이미 인증·권한 오류로 끝났으면 곧 실패할 실행을 만들지 않는다
    const kst = store.get().keyStatus || {};
    if (kst.state === 'error' && ['auth', 'permission'].includes(str(kst.code))) {
      showError('run', str(kst.message, 'API 키가 올바르지 않습니다.'),
        button('API 키 입력', { kind: 'secondary', size: 'sm', icon: 'key', onClick: () => openKeyDialog() }));
      return false;
    }
    return true;
  }

  function mapServerError(err) {
    const code = str(err?.code);
    const msg = str(err?.message, '조사를 시작하지 못했습니다.');
    if (code === 'empty_prompt' || code === 'prompt_too_long') { showError('prompt', msg); ta.focus(); return; }
    if (code === 'no_api_key' || code === 'auth' || code.includes('key')) {
      showError('run', msg, button('API 키 입력', { kind: 'secondary', size: 'sm', icon: 'key', onClick: () => openKeyDialog() }));
      return;
    }
    if (code.includes('model')) { showError('model', msg); return; }
    if (code.includes('format')) { showError('formats', msg); return; }
    if (code.includes('year')) { showError('year', msg); return; }
    if (code === 'too_many_runs') {
      showError('run', msg, button('기록 보기', { kind: 'secondary', size: 'sm', onClick: () => document.querySelector('.hist-item')?.focus() }));
      return;
    }
    showError('run', msg);
  }

  async function start() {
    if (busy) return;
    // Ctrl+Enter로 바로 시작해도 입력 중인 숫자 칸 값이 반영되게 먼저 확정한다(두 처리 함수 모두 동기)
    const a = document.activeElement;
    if (a instanceof HTMLInputElement && a.type === 'number' && container.contains(a)) a.dispatchEvent(new Event('change'));
    if (!validate()) return;
    busy = true;
    setBusy(startBtn, true, '시작하는 중…');
    const yearFrom = st.yearMode === 'agent' ? null : st.yearMode === 'none' ? 0 : Number(st.year);
    const options = {};
    for (const { key } of ADVANCED) options[key] = st.adv[key];
    if (!st.webSearch) options.web_search = false;
    const dc = obj(depthObj().config);
    if (num(dc.min_subq) !== null) options.min_subq = dc.min_subq;
    if (num(dc.max_subq) !== null) options.max_subq = dc.max_subq;
    const body = {
      prompt: ta.value.trim(),
      model: st.model,
      depth: st.depth,
      options,
      language: st.language,
      year_from: yearFrom,
      human_in_the_loop: st.hitl,
      formats: formats.map((f) => f.id).filter((id) => st.formats.has(id)),
      max_cost_usd: st.noCap ? null : capValue(),
    };
    const key = getApiKey();
    if (key) body.api_key = key;
    try {
      const res = await api.createRun(body);
      const id = str(res?.id);
      if (!id) throw new Error('실행을 만들지 못했습니다. 다시 시도해 주세요.');
      const overrides = {};
      for (const k of st.overrides) overrides[k] = st.adv[k];
      savePrefs({
        model: st.model, depth: st.depth, formats: body.formats, hitl: st.hitl,
        language: st.language, yearMode: st.yearMode, year: st.year, overrides,
        // 사용자가 직접 정한 한도만 기억한다(null = 한도 없음, undefined = 예상치에 맞춤)
        maxCost: st.costTouched ? (st.noCap ? null : capValue()) : undefined,
      });
      clearTimeout(draftTimer);
      ta.value = '';
      saveDraft('');
      refreshRuns();
      navigate(`#/run/${encodeURIComponent(id)}`);
    } catch (err) {
      mapServerError(err);
    } finally {
      busy = false;
      if (startBtn.isConnected) setBusy(startBtn, false);
    }
  }

  return () => {
    for (const fn of cleanups.splice(0)) {
      try { fn(); } catch (err) { console.error(err); }
    }
  };
}

function trimNum(n) {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}
