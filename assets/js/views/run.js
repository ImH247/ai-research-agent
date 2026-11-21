// 실행 컨트롤러 (#/run/<id>) — 상태에 따라 진행 화면(FRONTEND 5절) 또는 결과 화면(result.js)을 띄운다.

import { api } from '../api.js';
import { store, getApiKey } from '../store.js';
import {
  h, icon, button, setBusy, toast, confirmDialog, emptyState, skeleton, badge, strengthBadge, autosize,
  fmtInt, fmtCompact, fmtCost, fmtDuration, fmtTime, truncate, stageLabel, str, arr, obj, num,
  STATUS_LABEL, STRENGTH_LABEL, ACTIVE_STATUSES, DEFAULT_STAGES,
} from '../ui.js';
import { navigate, refreshRuns, openKeyDialog } from '../main.js';
import { notifyToggle, trackRunStatus, watchRun, unlockAudio } from '../notify.js';

const MAX_ROWS = 250;          // 활동 기록 DOM 최대 줄 수
const MAX_EVENTS = 6000;       // 메모리에 두는 이벤트 수
const MAX_PLAN_Q = 8;

// 남은 시간 추정용 단계 가중치(합 100). 재조사 라운드의 ③~⑥은 '비판·재조사' 20 안에서 센다.
const STAGE_WEIGHT = { understand: 2, plan: 2, act: 25, evaluate: 25, synthesize: 10, reflect: 20, report: 12, verify: 4 };
const STAGE_ORDER = Object.keys(STAGE_WEIGHT);
const LOOP_STAGES = ['act', 'evaluate', 'synthesize', 'reflect'];
const REWRITE_BASE = 84;       // 다시 쓰기 실행은 ⑦⑧(12 + 4)만 진행한다
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩';

/** 단계·진행률로 전체 완료 비율(0~1)을 추정한다 */
function stageFraction(status) {
  const sg = str(status.stage);
  if (sg === 'export' || sg === 'done') return 1;
  const i = STAGE_ORDER.indexOf(sg);
  if (i < 0) return 0;
  const prog = obj(status.progress);
  const pt = num(prog.total);
  const inStage = pt ? Math.min(1, Math.max(0, (num(prog.done) ?? 0) / pt)) : 0.3;
  const round = num(status.round) ?? 1;
  let done;
  if (round >= 2 && LOOP_STAGES.includes(sg)) {
    const before = STAGE_ORDER.slice(0, STAGE_ORDER.indexOf('reflect')).reduce((a, k) => a + STAGE_WEIGHT[k], 0);
    done = before + STAGE_WEIGHT.reflect * ((LOOP_STAGES.indexOf(sg) + inStage) / LOOP_STAGES.length);
  } else {
    done = STAGE_ORDER.slice(0, i).reduce((a, k) => a + STAGE_WEIGHT[k], 0) + STAGE_WEIGHT[sg] * inStage;
  }
  return done / 100;
}

// 실행별 커서·이벤트 캐시: 다시 들어와도 같은 이벤트를 두 번 그리지 않는다
const cache = new Map();

function getCache(runId) {
  let c = cache.get(runId);
  if (!c) {
    c = {
      // previewPos: 백엔드 단위(유니코드 코드 포인트)로 센 미리보기 커서. preview.length(UTF-16)와 다를 수 있다
      events: [], next: 0, lastSeq: 0, preview: '', previewPos: 0, previewTotal: null,
      items: [],            // 활동 기록 묶음(시간순)
      subq: {},             // 하위 질문별 상태
      added: new Set(),     // 재계획으로 추가된 하위 질문
      reflections: [],
      planEvent: null,
      lastWaitingSeq: 0,
      itemSeq: 0,
      budget: null,         // 비용 한도 도달 이벤트의 data {cap, cost}
    };
    cache.set(runId, c);
  }
  return c;
}

const truthy = (v) => v === true || v === 'true' || v === 'True' || v === 1;

/** 이벤트 하나를 캐시의 파생 상태에 반영한다. 바뀐 활동 기록 묶음을 돌려준다. */
function ingest(c, ev) {
  const kind = str(ev.kind);
  const d = obj(ev.data);
  const seq = num(ev.seq) ?? 0;
  const sq = str(d.subq).trim();
  if (sq && ['tool', 'tool_error', 'subq_done', 'synthesis'].includes(kind)) {
    const s = c.subq[sq] || (c.subq[sq] = { last: '', found: null, n: null, strength: '', synthesized: false, seq: 0 });
    s.last = kind;
    s.seq = seq;
    if (kind === 'subq_done') s.found = num(d.found);
    if (kind === 'synthesis') { s.synthesized = true; s.n = num(d.n); s.strength = str(d.strength); }
  }
  if (kind === 'replan' && sq) c.added.add(sq);
  if (kind === 'reflection') c.reflections.push({ ...d, ts: ev.ts, msg: ev.msg });
  if (kind === 'plan' && Array.isArray(d.sub_questions)) c.planEvent = d;
  if (kind === 'plan_review' && d.action === 'waiting') c.lastWaitingSeq = seq;
  if (kind === 'budget') c.budget = { cap: num(d.cap), cost: num(d.cost), msg: str(ev.msg) };

  // 활동 기록 묶음
  if (kind === 'stage' && d.status !== 'start') return null;
  const last = c.items[c.items.length - 1];
  if (kind === 'tool' && last && last.type === 'tools' && last.subq === sq) {
    last.events.push(ev);
    last.rev += 1;
    return last;
  }
  c.itemSeq += 1;
  const item = kind === 'tool'
    ? { key: c.itemSeq, type: 'tools', subq: sq, events: [ev], rev: 0, open: false }
    : { key: c.itemSeq, type: 'event', ev, rev: 0 };
  c.items.push(item);
  if (c.items.length > MAX_ROWS * 2) c.items.splice(0, c.items.length - MAX_ROWS);
  return item;
}

// ───────────────────────── 컨트롤러 ─────────────────────────

export function mountRun(container, { runId, tab } = {}) {
  let disposed = false;
  let child = null;       // 현재 하위 뷰의 해제 함수
  let childKind = '';     // 'live' | 'result' | ''
  let tabNow = tab || null;

  function showLoading() {
    container.replaceChildren(h('div', { class: 'page run' },
      h('div', { class: 'run-head' }, h('div', { class: 'skel skel-title' }), h('div', { class: 'skel skel-line', style: { width: '40%' } })),
      h('div', { class: 'card' }, skeleton(2)),
      h('div', { class: 'run-grid' }, h('div', { class: 'card' }, skeleton(5)), h('div', { class: 'card' }, skeleton(4)))));
  }

  function showLoadError(err) {
    const notFound = err?.status === 404 || err?.code === 'not_found';
    container.replaceChildren(h('div', { class: 'page run' }, emptyState(notFound
      ? {
        icon: 'search', title: '이 조사 기록을 찾을 수 없습니다', text: '삭제되었거나 주소가 잘못되었습니다. 새 조사를 시작하거나 기록에서 다른 항목을 고르세요.',
        action: button('새 조사', { kind: 'primary', icon: 'plus', onClick: () => navigate('#/') }),
      }
      : {
        icon: 'alert-triangle', title: '조사 정보를 불러오지 못했습니다', text: str(err?.message),
        action: button('다시 시도', { kind: 'primary', icon: 'refresh', onClick: () => { showLoading(); load(); } }),
      })));
  }

  async function mountResultView(status, { fromLive = false } = {}) {
    if (child) { try { child(); } catch (e) { console.error(e); } }
    child = null;
    childKind = '';
    try {
      const mod = await import('./result.js');
      if (disposed) return;
      container.replaceChildren();
      // 진행 화면에서 넘어오면 결과를 맨 위(제목)부터 보이게 한다
      if (fromLive) window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
      child = mod.mountResult(container, { runId, tab: tabNow, status, fromLive }) || null;
      childKind = 'result';
    } catch (err) {
      console.error(err);
      if (disposed) return;
      container.replaceChildren(h('div', { class: 'page run' }, emptyState({
        icon: 'alert-triangle', title: '결과 화면을 열지 못했습니다', text: str(err?.message),
        action: button('다시 시도', { kind: 'primary', icon: 'refresh', onClick: () => mountResultView(status) }),
      })));
    }
  }

  function routeBy(snap) {
    if (disposed) return;
    if (str(snap?.status) === 'done') {
      mountResultView(snap);
      return;
    }
    container.replaceChildren();
    child = mountLive(container, runId, snap, {
      onDone: (status) => {
        const topic = str(status?.topic) || str(status?.prompt);
        document.title = `조사 완료 — ${truncate(topic, 40)}`;
        mountResultView(status, { fromLive: true });
      },
    });
    childKind = 'live';
  }

  async function load() {
    try {
      const snap = await api.run(runId);
      routeBy(obj(snap));
    } catch (err) {
      if (!disposed) showLoadError(err);
    }
  }

  showLoading();
  load();

  const unmount = () => {
    disposed = true;
    if (child) { try { child(); } catch (e) { console.error(e); } }
    child = null;
  };
  // 같은 실행 안에서 탭만 바뀔 때 main.js가 부른다
  unmount.update = ({ tab: t } = {}) => {
    tabNow = t || null;
    if (childKind === 'result') {
      if (child && typeof child.update === 'function') return child.update({ runId, tab: tabNow });
      return false;
    }
    return true;
  };
  return unmount;
}

// ───────────────────────── 진행 화면 ─────────────────────────

function mountLive(container, runId, initial, { onDone }) {
  const cfg = obj(store.get().config);
  const stages = arr(cfg.stages).filter((s) => s && s.id).length ? arr(cfg.stages).filter((s) => s && s.id) : DEFAULT_STAGES;
  const c = getCache(runId);
  let status = obj(initial);
  let statusAt = performance.now();
  let disposed = false;
  let pollTimer = 0;
  let clockTimer = 0;
  let inflight = false;
  let failures = 0;
  let shownElapsed = 0;
  let review = null;           // 계획 검토 편집 상태
  let reviewKey = '';
  let finished = false;
  let lost = false;            // 백엔드가 이 실행을 모른다(404): 폴링을 끝낸다
  const rowNodes = new Map();  // item → li
  const tileValues = {};
  let fracMax = 0;             // 완료 비율은 뒤로 가지 않게(재조사로 단계가 돌아가도)
  let etaSmooth = null;        // 남은 시간(초) 부드럽게 한 값
  let etaAt = 0;
  let etaText = '';
  let etaChangedAt = 0;
  let budgetAt = 0;            // 비용 막대를 마지막으로 그린 시각(1초에 한 번까지)
  let resuming = false;

  const isLive = () => !lost && ACTIVE_STATUSES.has(str(status.status));
  const topicText = () => str(status.topic).trim() || str(status.prompt).trim() || '제목 없는 조사';

  // ── 머리 ──
  const titleEl = h('h1', { class: 'run-title' });
  const statusBadge = h('span', { class: 'run-status' });
  const timerEl = h('span', { class: 'run-timer num', 'aria-label': '경과 시간' });
  const connEl = h('span', { class: 'run-conn', hidden: true, role: 'status' }, icon('alert-triangle', 14), '진행 상황을 다시 불러오는 중…');
  const etaEl = h('span', { class: 'run-eta num', hidden: true, 'aria-live': 'off' });
  const metaEl = h('div', { class: 'run-meta' });
  const cancelBtn = button('중단', { kind: 'secondary', icon: 'stop', cls: 'btn-cancel', onClick: () => cancelRun() });
  // 지금 마무리: 추가 검색·재조사를 멈추고 모은 근거로 보고서를 쓴다
  const finishBtn = button('지금 마무리', { kind: 'secondary', icon: 'file-text', onClick: () => finishEarly() });
  finishBtn.hidden = true;
  const finishChip = h('span', { class: 'chip chip-static', hidden: true, role: 'status' }, icon('check', 12), '마무리 요청됨');
  const bell = notifyToggle();
  const head = h('header', { class: 'run-head' },
    h('div', { class: 'run-head-main' }, titleEl, metaEl),
    h('div', { class: 'run-head-side' }, connEl, bell ? bell.el : null, finishChip, finishBtn, cancelBtn));
  const noticeEl = h('p', { class: 'run-notice', hidden: true },
    icon('info', 14), h('span', null, '이 탭을 닫거나 새로고침하면 조사가 멈춥니다. 단계마다 저장되므로 나중에 이어서 진행할 수 있습니다.'));
  // 비용 한도에 닿았을 때의 경고 카드
  const budgetNote = h('div', { class: 'note note-warn budget-note', hidden: true, role: 'status' });

  // ── 종료 · 검토 안내 ──
  const endSlot = h('div', { class: 'run-end-slot' });
  const reviewBanner = h('div', { class: 'note note-accent review-banner', hidden: true, role: 'status' },
    icon('edit', 16),
    h('span', null, h('b', null, '조사 계획 검토를 기다리고 있습니다. '), '하위 질문을 고치거나 지우고, 승인하면 검색을 시작합니다.'));

  // ── 단계 표시 ──
  const stepList = h('ol', { class: 'stepper' });
  const loopEl = h('div', { class: 'loop', 'aria-hidden': 'true' });
  const stepperCard = h('section', { class: 'card stepper-card', 'aria-label': '진행 단계', style: { '--steps': stages.length } }, stepList, loopEl);

  // ── 카운터 · 지금 하는 일 · 자기 비판 ──
  const TILES = [
    ['collected', '수집'], ['included', '채택'], ['merged', '중복 병합'],
    ['calls', 'LLM 호출'], ['tokens', '토큰 (입력/출력)'], ['cost', '예상 비용'],
  ];
  const tileEls = {};
  const tiles = h('div', { class: 'tiles' }, TILES.map(([k, label]) => {
    tileEls[k] = h('span', { class: 'tile-value num' }, '—');
    return h('div', { class: 'tile', dataset: { k } }, h('span', { class: 'tile-label' }, label), tileEls[k]);
  }));
  const nowBody = h('div', { class: 'now-body' });
  // 비용 막대(현재 / 한도). 자리를 미리 잡아 두어 값이 바뀌어도 높이가 그대로다
  const capValue = h('span', { class: 'cost-cap-value num' });
  const capFill = h('i');
  const capBar = h('div', { class: 'bar cost-cap-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': '비용 한도 사용률' }, capFill);
  const capEl = h('div', { class: 'cost-cap', hidden: true },
    h('div', { class: 'cost-cap-head' }, h('span', { class: 'cost-cap-label' }, '비용 한도'), capValue),
    capBar);
  const reflectList = h('div', { class: 'reflect-list' });
  const reflectCard = h('section', { class: 'card side-card', hidden: true },
    h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, '자기 비판'), h('span', { class: 'card-aside' }, '라운드별 품질 점수')),
    reflectList);

  // ── 보고서 미리보기 ──
  const previewBody = h('div', { class: 'preview-body', tabindex: '0', 'aria-label': '보고서 미리보기' });
  const previewTitle = h('h2', { class: 'card-title' });
  const previewAside = h('span', { class: 'card-aside num' });
  const previewCard = h('section', { class: 'card preview-card', hidden: true, 'aria-live': 'off' },
    h('div', { class: 'card-head' }, h('span', { class: 'preview-title-wrap' }, h('span', { class: 'pulse-dot' }), previewTitle), previewAside),
    previewBody);
  let previewLines = 0;

  // ── 조사 계획 ──
  const planBody = h('div', { class: 'plan-body' });
  const planAside = h('span', { class: 'card-aside' });
  const planCard = h('section', { class: 'card plan-card' },
    h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, '조사 계획'), planAside),
    planBody);

  // ── 활동 기록 ──
  const feedList = h('ol', { class: 'feed', 'aria-label': '활동 기록 (최신순)' });
  const feedAside = h('span', { class: 'card-aside num' });
  const feedCard = h('section', { class: 'card feed-card' },
    h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, '활동 기록'), feedAside),
    feedList);

  container.append(h('div', { class: 'page run' },
    head, noticeEl, endSlot, reviewBanner, budgetNote, stepperCard,
    h('div', { class: 'run-grid' },
      h('div', { class: 'run-main' }, previewCard, planCard, feedCard),
      h('aside', { class: 'run-side', 'aria-label': '진행 요약' },
        h('section', { class: 'card side-card' },
          h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, '현황')), tiles, capEl),
        h('section', { class: 'card side-card now-card' },
          h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, '지금 하는 일')), nowBody),
        reflectCard))));

  // ───────────────── 렌더 ─────────────────

  function renderHead() {
    titleEl.textContent = topicText();
    titleEl.title = topicText();
    const st = str(status.status, 'queued');
    const depth = arr(cfg.depths).find((d) => d && d.id === obj(status.config).depth);
    statusBadge.replaceChildren(
      isLive() ? h('span', { class: ['pulse-dot', st === 'awaiting_plan' ? 'is-wait' : ''] }) : icon(st === 'error' ? 'alert-triangle' : 'stop', 12),
      STATUS_LABEL[st] || st);
    statusBadge.className = `run-status badge st-badge-${st}`;
    metaEl.replaceChildren(
      statusBadge,
      h('span', { class: 'chip chip-static' }, str(status.model_label) || str(status.model) || '모델 미상'),
      depth ? h('span', { class: 'chip chip-static' }, `깊이 ${str(depth.label)}`) : null,
      num(status.round) >= 2 ? badge(`재조사 ${status.round - 1}회차`, 'accent', 'refresh') : null,
      h('span', { class: 'run-timer-wrap' }, icon('clock', 14), timerEl),
      status.demo ? h('span', { class: 'tag' }, '데모') : null,
      status.parent_id ? h('span', { class: 'tag' }, '보고서 다시 쓰기') : null,
      etaEl);
    cancelBtn.hidden = !isLive();
    renderFinish();
    if (bell) bell.el.hidden = !isLive();
    noticeEl.hidden = !isLive();
    tickClock();
    updateEta();
    document.title = tabTitle();
  }

  /** '지금 마무리' 버튼 · '마무리 요청됨' 칩 */
  function renderFinish() {
    const live = isLive() && str(status.status) !== 'awaiting_plan';
    const requested = status.finish_requested === true;
    const allowed = live && !status.demo && !status.parent_id && !isRewrite() && LOOP_STAGES.includes(str(status.stage));
    finishBtn.hidden = !allowed || requested;
    finishChip.hidden = !(isLive() && requested);
  }

  // ── 탭 제목 · 완료 비율 · 남은 시간 ──
  const isRewrite = () => !!status.parent_id && !!status.rewrite;

  /** 이 실행 기준의 완료 비율(0~1, 뒤로 가지 않음) */
  function runFraction() {
    let f = stageFraction(status);
    if (isRewrite()) f = Math.max(0, (f * 100 - REWRITE_BASE) / (100 - REWRITE_BASE));
    fracMax = Math.max(fracMax, Math.min(1, f));
    return fracMax;
  }

  function tabTitle() {
    const st = str(status.status, 'queued');
    const t = truncate(topicText(), 40);
    if (st === 'awaiting_plan') return `검토 대기 — ${t}`;
    if (st === 'done') return `조사 완료 — ${t}`;
    if (st === 'queued') return `대기 중 — ${t}`;
    if (isLive()) {
      const pct = Math.min(99, Math.round(runFraction() * 100));
      const i = stageIndex();
      const name = i >= 0 && i < stages.length
        ? `${CIRCLED[i] || ''} ${str(stages[i].label, stages[i].id)}`.trim()
        : stageLabel(status.stage, cfg);
      return `(${pct}%) ${name} — ${t}`;
    }
    return `${STATUS_LABEL[st] || st} — ${t}`;
  }

  /** 깊이 프리셋의 예상 시간 중간값(초). 데모는 재생 속도로, 다시 쓰기는 ⑦⑧ 몫만 */
  function presetSeconds() {
    if (status.demo) return 45 / Math.max(0.25, num(status.demo_speed) || 1);
    const conf = obj(status.config);
    const depths = arr(cfg.depths);
    const depth = depths.find((d) => d && d.id === conf.depth) || depths.find((d) => d && d.id === cfg.default_depth);
    const mins = arr(obj(depth?.estimate).minutes).map(num).filter((v) => v !== null);
    if (!mins.length) return null;
    const mid = mins.length > 1 ? (mins[0] + mins[1]) / 2 : mins[0];
    return mid * 60 * (isRewrite() ? (100 - REWRITE_BASE) / 100 : 1);
  }

  /** "약 N분 남음". 1초에 한 번(시계와 함께) 부른다. 값은 부드럽게, 글자는 천천히 바꾼다 */
  function updateEta() {
    const st = str(status.status);
    let text = '';
    if (isLive() && st === 'awaiting_plan') {
      text = '검토를 기다리는 중';
      etaSmooth = null;
    } else if (isLive() && st !== 'queued') {
      const f = runFraction();
      // 계획 검토를 기다린 시간(wait_s)은 작업 시간이 아니므로 빼고 센다(시계는 실제 경과 시간 그대로)
      const el = Math.max(0, shownElapsed - (num(status.wait_s) ?? 0));
      let raw = null;
      if (f >= 0.995) raw = 0;
      else {
        const preset = presetSeconds();
        const presetLeft = preset !== null ? Math.max(0, preset * (1 - f)) : null;
        const measured = f >= 0.02 && el > 0 ? el / f - el : null;
        // 처음 1분은 프리셋, 그 뒤 4분 동안 실제 속도 쪽으로 천천히 넘어간다
        let w = 0;
        if (measured !== null) w = presetLeft === null ? 1 : Math.min(1, Math.max(0, (el - 60) / 240));
        if (w >= 1) raw = measured;
        else if (w <= 0) raw = presetLeft;
        else raw = (1 - w) * presetLeft + w * measured;
      }
      if (raw !== null && Number.isFinite(raw)) {
        raw = Math.min(Math.max(0, raw), 6 * 3600);
        const t = performance.now();
        if (etaSmooth === null) etaSmooth = raw;
        else {
          const pred = Math.max(0, etaSmooth - (t - etaAt) / 1000);
          etaSmooth = pred + 0.12 * (raw - pred);
        }
        etaAt = t;
        const next = etaSmooth < 45 ? '곧 끝납니다' : `약 ${Math.max(1, Math.round(etaSmooth / 60))}분 남음`;
        // 숫자가 자주 바뀌지 않게: 처음 한 번 뒤로는 5초에 한 번까지만 바꾼다
        const stale = !etaText || etaText === '검토를 기다리는 중' || t - etaChangedAt >= 5000;
        text = stale || next === '곧 끝납니다' ? next : etaText;
      }
    }
    if (text !== etaText) {
      etaText = text;
      etaChangedAt = performance.now();
      etaEl.textContent = text;
    }
    etaEl.hidden = !text;
  }

  /** 비용 막대: 1초에 한 번까지만 다시 그린다(force는 상태가 끝났을 때) */
  function renderBudget(force = false) {
    const t = performance.now();
    if (!force && t - budgetAt < 1000) return;
    budgetAt = t;
    if (status.demo) { capEl.hidden = true; return; }
    const cap = num(obj(status.config).max_cost_usd);
    const cost = num(obj(status.usage).cost_usd);
    capEl.hidden = false;
    if (cap === null) {
      capValue.textContent = '없음';
      capBar.hidden = true;
      capEl.classList.remove('is-near', 'is-hit');
      return;
    }
    capBar.hidden = false;
    const pct = cap > 0 ? Math.min(100, Math.max(0, ((cost ?? 0) / cap) * 100)) : (cost ? 100 : 0);
    capValue.textContent = `${fmtCost(cost ?? 0)} / ${fmtCost(cap)}`;
    capFill.style.width = `${pct}%`;
    capBar.setAttribute('aria-valuenow', String(Math.round(pct)));
    const hit = pct >= 100 || !!c.budget;
    capEl.classList.toggle('is-hit', hit);
    capEl.classList.toggle('is-near', !hit && pct >= 80);
  }

  function renderBudgetNote() {
    const b = c.budget;
    if (!b) { budgetNote.hidden = true; return; }
    budgetNote.hidden = false;
    const spent = b.cost !== null && b.cap !== null ? ` (한도 ${fmtCost(b.cap)} · 사용 ${fmtCost(b.cost)})` : '';
    budgetNote.replaceChildren(icon('alert-triangle', 16),
      h('span', null, h('b', null, `비용 한도에 도달했습니다${spent}. `), '추가 조사를 멈추고 지금까지 모은 근거로 보고서를 씁니다.'));
  }

  /** 1초마다: 경과 시간, 남은 시간, 비용 막대, 탭 제목 */
  function tick() {
    tickClock();
    updateEta();
    renderBudget();
  }

  function tickClock() {
    let el = num(status.elapsed_s) ?? 0;
    if (isLive() && str(status.status) !== 'queued') {
      el += (performance.now() - statusAt) / 1000;
      el = Math.max(el, shownElapsed);
    }
    shownElapsed = el;
    timerEl.textContent = fmtDuration(el);
  }

  function stageIndex() {
    const sg = str(status.stage);
    if (sg === 'done' || sg === 'export') return stages.length;
    return stages.findIndex((s) => s.id === sg);
  }

  function renderStepper() {
    const cur = stageIndex();
    const st = str(status.status);
    const live = isLive();
    const waiting = st === 'awaiting_plan';
    const prog = obj(status.progress);
    const pDone = num(prog.done);
    const pTotal = num(prog.total);
    stepList.replaceChildren(...stages.map((s, i) => {
      let state = 'pending';
      if (i < cur) state = 'done';
      else if (i === cur) state = live ? (waiting ? 'waiting' : 'active') : st === 'done' ? 'done' : 'stopped';
      const dot = state === 'done' ? icon('check', 14)
        : state === 'active' ? h('span', { class: 'step-pulse' })
          : state === 'stopped' ? icon('x', 14)
            : state === 'waiting' ? icon('edit', 13)
              : h('span', { class: 'step-num num' }, i + 1);
      const sub = state === 'waiting'
        ? h('span', { class: 'step-sub' }, '검토 대기')
        : state === 'active' && pTotal
          ? h('span', { class: 'step-progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': pTotal, 'aria-valuenow': pDone ?? 0, 'aria-label': str(prog.label, '진행률'), title: `${str(prog.label)} ${pDone ?? 0}/${pTotal}` },
            h('i', { style: { width: `${Math.min(100, Math.max(0, ((pDone ?? 0) / pTotal) * 100))}%` } }))
          : null;
      return h('li', {
        class: ['step', `is-${state}`], 'aria-current': i === cur && live ? 'step' : null,
        title: str(s.description) || null,
      },
      h('span', { class: 'step-dot' }, dot),
      h('span', { class: 'step-name' }, str(s.label, s.id)),
      sub,
      h('span', { class: 'sr-only' }, { done: ' 완료', active: ' 진행 중', pending: ' 대기', stopped: ' 멈춤', waiting: ' 검토 대기' }[state]));
    }));

    // ⑥ → ③ 되돌아가는 흐름
    const a = stages.findIndex((s) => s.id === 'act');
    const r = stages.findIndex((s) => s.id === 'reflect');
    if (a < 0 || r <= a) { loopEl.hidden = true; return; }
    loopEl.hidden = false;
    const round = num(status.round) ?? 1;
    const reRunning = round >= 2 && live && cur >= a && cur <= r;
    loopEl.className = ['loop', round >= 2 ? 'is-used' : '', reRunning ? 'is-active' : ''].filter(Boolean).join(' ');
    loopEl.style.gridColumn = `${a + 1} / ${r + 2}`;
    loopEl.style.setProperty('--span', String(r - a + 1));
    loopEl.replaceChildren(
      h('span', { class: 'loop-line' }, h('span', { class: 'loop-arrow' })),
      h('span', { class: 'loop-label' },
        icon('refresh', 12),
        h('span', { class: 'loop-text' }, '근거가 부족하면 재조사'),
        round >= 2 ? h('span', { class: 'badge badge-accent' }, `재조사 ${round - 1}회차`) : null));
  }

  function setTile(k, text) {
    const el = tileEls[k];
    if (!el) return;
    if (tileValues[k] !== undefined && tileValues[k] !== text) {
      const tile = el.parentElement;
      tile.classList.remove('is-flash');
      void tile.offsetWidth;
      tile.classList.add('is-flash');
    }
    tileValues[k] = text;
    el.textContent = text;
  }

  function renderTiles() {
    const ct = obj(status.counts);
    const us = obj(status.usage);
    setTile('collected', fmtInt(ct.collected));
    setTile('included', fmtInt(ct.included));
    setTile('merged', fmtInt(ct.merged));
    setTile('calls', fmtInt(us.calls));
    setTile('tokens', `${fmtCompact(us.input_tokens)} / ${fmtCompact(us.output_tokens)}`);
    setTile('cost', fmtCost(us.cost_usd));
    tileEls.tokens.title = `입력 ${fmtInt(us.input_tokens)} · 출력 ${fmtInt(us.output_tokens)}`;
  }

  function renderNow() {
    const st = str(status.status);
    const stg = stages.find((s) => s.id === status.stage);
    const prog = obj(status.progress);
    const lastEv = c.events.length ? c.events[c.events.length - 1] : null;
    const rows = [];
    if (st === 'queued') {
      rows.push(h('div', { class: 'now-title' }, '시작을 기다리는 중'), h('p', { class: 'now-desc' }, '앞선 조사가 끝나면 바로 시작합니다.'));
    } else if (st === 'awaiting_plan') {
      rows.push(h('div', { class: 'now-title' }, '계획 검토 대기'), h('p', { class: 'now-desc' }, '왼쪽 조사 계획을 확인한 뒤 승인하거나 의견을 남겨 주세요.'));
    } else if (!isLive()) {
      rows.push(h('div', { class: 'now-title' }, STATUS_LABEL[st] || st), h('p', { class: 'now-desc' }, `${stageLabel(status.stage, cfg)} 단계에서 멈췄습니다.`));
    } else {
      rows.push(h('div', { class: 'now-title' }, stageLabel(status.stage, cfg)));
      if (str(stg?.description)) rows.push(h('p', { class: 'now-desc' }, stg.description));
      const pTotal = num(prog.total);
      if (pTotal) {
        const pDone = num(prog.done) ?? 0;
        rows.push(h('div', { class: 'now-progress' },
          h('div', { class: 'now-progress-head' }, h('span', null, str(prog.label, '진행')), h('span', { class: 'num' }, `${pDone} / ${pTotal}`)),
          h('div', { class: 'bar' }, h('i', { style: { width: `${Math.min(100, (pDone / pTotal) * 100)}%` } }))));
      }
    }
    if (lastEv && str(lastEv.msg)) {
      rows.push(h('div', { class: 'now-last' },
        h('span', { class: 'mono now-time' }, fmtTime(lastEv.ts)),
        h('span', { class: 'now-msg', title: str(lastEv.msg) }, truncate(lastEv.msg, 160))));
    }
    nowBody.replaceChildren(...rows);
  }

  function renderReflections() {
    reflectCard.hidden = !c.reflections.length;
    reflectList.replaceChildren(...c.reflections.map((r) => reflectionCard(r, { compact: true })));
  }

  // ── 보고서 미리보기 ──
  function previewLine(line) {
    const t = line.replace(/\s+$/, '');
    const m = t.match(/^(#{1,6})\s+(.*)$/);
    if (m) return h('div', { class: `pv-h pv-h${Math.min(m[1].length, 3)}` }, m[2]);
    const li = t.match(/^(\s*)[-*]\s+(.*)$/);
    if (li) return h('div', { class: 'pv-li', style: { '--pv-indent': `${Math.min(4, Math.floor(li[1].length / 2)) * 16}px` } }, li[2]);
    if (!t.trim()) return h('div', { class: 'pv-gap' });
    return h('div', { class: 'pv-p' }, t);
  }

  function renderPreview() {
    const text = c.preview;
    const inReport = str(status.stage) === 'report' && isLive();
    previewCard.hidden = !text && !inReport;
    if (previewCard.hidden) return;
    previewCard.classList.toggle('is-writing', inReport);
    previewTitle.textContent = inReport ? '보고서 작성 중' : '보고서 초안';
    previewAside.textContent = text ? `${fmtInt(c.previewPos)}자${num(c.previewTotal) ? ` / ${fmtInt(c.previewTotal)}자` : ''}` : '';
    if (!text) {
      previewBody.replaceChildren(h('p', { class: 'preview-wait' }, '근거를 정리해 보고서 초안을 쓰기 시작합니다…'));
      previewLines = 0;
      return;
    }
    const nearBottom = previewBody.scrollHeight - previewBody.scrollTop - previewBody.clientHeight < 48;
    const lines = text.split('\n');
    if (!previewLines || previewBody.querySelector('.preview-wait')) { previewBody.replaceChildren(); previewLines = 0; }
    // 마지막 줄(쓰는 중이던 줄)부터 다시 그린다
    if (previewLines > 0) { previewBody.lastElementChild?.remove(); previewLines -= 1; }
    for (let i = previewLines; i < lines.length; i += 1) previewBody.append(previewLine(lines[i]));
    previewLines = lines.length;
    if (nearBottom || inReport) previewBody.scrollTop = previewBody.scrollHeight;
  }

  // ── 조사 계획 ──
  function planQuestions() {
    const fromStatus = arr(obj(status.plan).sub_questions);
    const list = fromStatus.length ? fromStatus : arr(c.planEvent?.sub_questions);
    return list.filter((q) => q && typeof q === 'object');
  }

  function qState(id) {
    const s = c.subq[id];
    const stg = str(status.stage);
    // 다시 쓰기 실행은 ①~⑥을 원래 조사에서 이미 마쳤다
    if (isRewrite()) return { cls: 'qs-done', ic: 'check', text: '조사 완료' };
    if (!s) return { cls: 'qs-wait', ic: 'clock', text: '대기' };
    if (s.last === 'synthesis') {
      return { cls: 'qs-done', ic: 'check', text: '종합 완료', strength: s.strength };
    }
    if (s.last === 'subq_done') return { cls: 'qs-found', ic: 'check', text: `탐색 완료 · 후보 ${fmtInt(s.found)}건` };
    if (stg === 'act' && isLive()) return { cls: 'qs-active', ic: null, text: s.synthesized ? '추가 탐색 중' : '탐색 중' };
    return { cls: 'qs-found', ic: 'check', text: '탐색함' };
  }

  function renderPlan() {
    const qs = planQuestions();
    const awaiting = str(status.status) === 'awaiting_plan' && str(status.awaiting || 'plan') === 'plan';
    reviewBanner.hidden = !awaiting;
    planCard.classList.toggle('is-review', awaiting);
    planAside.textContent = qs.length ? `하위 질문 ${qs.length}개${c.added.size ? ` · 추가 ${c.added.size}개` : ''}` : '';

    if (awaiting && qs.length) {
      const key = `${JSON.stringify(qs.map((q) => [str(q.id), str(q.question)]))}#${c.lastWaitingSeq}`;
      if (!review || reviewKey !== key) {
        reviewKey = key;
        review = {
          items: qs.map((q) => ({ id: str(q.id), question: str(q.question), orig: q })),
          feedback: review ? review.feedback : '',
          dirty: false,
          submitting: false,
        };
        renderReviewEditor();
      }
      return;
    }
    review = null;
    reviewKey = '';
    if (!qs.length) {
      planBody.replaceChildren(h('div', { class: 'plan-empty' },
        skeleton(3),
        h('p', { class: 'muted' }, isLive() ? '주제를 이해한 뒤 하위 질문을 세웁니다.' : '조사 계획이 세워지기 전에 멈췄습니다.')));
      return;
    }
    planBody.replaceChildren(h('ol', { class: 'plan-list' }, qs.map((q) => {
      const id = str(q.id);
      const s = qState(id);
      return h('li', { class: 'plan-q' },
        h('span', { class: 'badge badge-id' }, id || '—'),
        h('div', { class: 'plan-q-body' },
          h('div', { class: 'plan-q-text' }, str(q.question, '(질문 없음)')),
          h('div', { class: 'plan-q-meta' },
            str(q.perspective) ? h('span', null, q.perspective) : null,
            c.added.has(id) ? h('span', { class: 'tag tag-accent' }, '추가됨') : null)),
        h('span', { class: ['q-state', s.cls] },
          s.ic ? icon(s.ic, 12) : h('span', { class: 'pulse-dot' }),
          s.text,
          s.strength !== undefined ? h('span', { class: 'q-strength' }, ' · 근거 강도 ', strengthBadge(s.strength)) : null));
    })));
  }

  function renderReviewEditor() {
    if (!review) return;
    const rv = review;
    const errBox = h('div', { class: 'field-error', role: 'alert', hidden: true });
    const showErr = (m) => { errBox.replaceChildren(icon('alert-triangle', 14), h('span', null, m)); errBox.hidden = false; };

    const list = h('ol', { class: 'plan-edit-list' });
    const renderItems = () => {
      list.replaceChildren(...rv.items.map((it, idx) => {
        const ta = h('textarea', {
          class: 'input plan-edit-input', rows: 2, 'aria-label': `${it.id || `질문 ${idx + 1}`} 문장`, disabled: rv.submitting,
          placeholder: it.orig ? null : '새 하위 질문을 적어 주세요',
          onInput: (e) => { it.question = e.target.value; rv.dirty = true; autosize(e.target, 200); },
        });
        ta.value = it.question;
        requestAnimationFrame(() => autosize(ta, 200));
        return h('li', { class: 'plan-edit-row' },
          h('span', { class: 'badge badge-id' }, it.id || '새 질문'),
          ta,
          h('button', {
            type: 'button', class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': `${it.id || '새 질문'} 삭제`, title: '삭제', disabled: rv.submitting || rv.items.length <= 1,
            onClick: () => { rv.items.splice(idx, 1); rv.dirty = true; renderItems(); },
          }, icon('trash', 16)));
      }));
      addBtn.disabled = rv.submitting || rv.items.length >= MAX_PLAN_Q;
      addHint.textContent = `${rv.items.length} / ${MAX_PLAN_Q}개`;
    };
    const addHint = h('span', { class: 'field-hint num' });
    const addBtn = button('질문 추가', {
      kind: 'ghost', icon: 'plus', size: 'sm',
      onClick: () => {
        if (rv.items.length >= MAX_PLAN_Q) return;
        rv.items.push({ id: nextQid(rv.items), question: '', orig: null });
        rv.dirty = true;
        renderItems();
        list.lastElementChild?.querySelector('textarea')?.focus();
      },
    });
    const fb = h('textarea', {
      class: 'input plan-feedback', rows: 2, disabled: rv.submitting,
      placeholder: '예: 한국 대학원 사례를 더 찾아 주세요. 정책 관련 질문은 빼도 됩니다.',
      'aria-label': '계획에 대한 의견',
      onInput: (e) => { rv.feedback = e.target.value; autosize(e.target, 200); },
    });
    fb.value = rv.feedback;

    const approveBtn = button(rv.submitting ? '반영하는 중…' : '승인하고 진행', { kind: 'primary', icon: 'check', disabled: rv.submitting });
    const reviseBtn = button('의견 반영해 다시 계획', { kind: 'secondary', icon: 'refresh', disabled: rv.submitting });
    approveBtn.addEventListener('click', async () => {
      errBox.hidden = true;
      const items = rv.items.map((it) => ({ ...it, question: it.question.trim() })).filter((it) => it.question);
      if (!items.length) { showErr('하위 질문을 하나 이상 남겨 주세요.'); return; }
      // 의견은 '다시 계획'에서만 쓰인다: 적어 둔 채 승인하면 버려지므로 먼저 묻는다
      if (rv.feedback.trim()) {
        const ok = await confirmDialog(
          "적어 둔 의견은 승인할 때 반영되지 않습니다. 의견을 반영하려면 '돌아가기'를 누른 뒤 '의견 반영해 다시 계획'을 누르세요. 의견 없이 승인할까요?",
          '의견 없이 승인', { title: '의견이 반영되지 않습니다', cancelLabel: '돌아가기' });
        if (!ok || disposed || review !== rv) { if (!ok) fb.focus(); return; }
      }
      const body = { action: 'approve' };
      if (rv.dirty) {
        // 고치지 않은 질문만 원래 검색어·관점을 그대로 쓴다. 고치거나 새로 넣은 질문은 문장만 보낸다
        body.sub_questions = items.map((it) => {
          const o = obj(it.orig);
          if (it.orig && it.question === str(o.question).trim()) return { ...o, id: it.id, question: it.question };
          const q = { id: it.id, question: it.question };
          if (Array.isArray(o.preferred_tools) && o.preferred_tools.length) q.preferred_tools = o.preferred_tools;
          return q;
        });
      }
      await submit(body, approveBtn, '승인했습니다. 검색을 시작합니다.');
    });
    reviseBtn.addEventListener('click', async () => {
      errBox.hidden = true;
      let feedback = rv.feedback.trim();
      if (!feedback) { showErr('다시 계획하려면 의견을 적어 주세요.'); fb.focus(); return; }
      if (rv.dirty) {
        // 고친 질문 목록을 의견에 덧붙여 다시 세운 계획에도 사용자의 수정이 남게 한다(최대 2000자)
        const LIMIT = 2000;
        const qs = rv.items.map((it) => it.question.trim()).filter(Boolean);
        if (qs.length) {
          const headText = '\n\n사용자가 고친 하위 질문 목록(이 질문들을 바탕으로 계획을 세워 주세요):\n';
          let tail = '';
          for (const q of qs) {
            const line = `${tail ? '\n' : ''}- ${q}`;
            if (feedback.length + headText.length + tail.length + line.length > LIMIT) break;
            tail += line;
          }
          if (tail) feedback += headText + tail;
        }
      }
      await submit({ action: 'revise', feedback }, reviseBtn, '의견을 보냈습니다. 계획을 다시 세웁니다.');
    });

    async function submit(body, btn, okMsg) {
      setBusy(btn, true, '보내는 중…');
      try {
        await api.submitPlan(runId, body);
        rv.submitting = true;
        toast(okMsg, 'success');
        renderReviewEditor();
        pollSoon();
      } catch (err) {
        setBusy(btn, false);
        if (err?.code === 'not_awaiting') { toast('이미 다음 단계로 넘어갔습니다.', 'info'); pollSoon(); return; }
        showErr(str(err?.message, '보내지 못했습니다.'));
      }
    }

    planBody.replaceChildren(h('div', { class: 'plan-edit' },
      h('p', { class: 'plan-edit-help' }, '질문 문장을 직접 고치거나 지우고, 필요하면 추가하세요. 최대 8개까지 둘 수 있습니다.'),
      list,
      h('div', { class: 'plan-edit-add' }, addBtn, addHint),
      h('label', { class: 'field-label' }, '다시 계획할 때 반영할 의견 (선택)'),
      fb,
      errBox,
      h('div', { class: 'plan-edit-actions' }, reviseBtn, approveBtn)));
    renderItems();
    requestAnimationFrame(() => autosize(fb, 200));
  }

  // ── 활동 기록 ──
  function renderItem(item) {
    if (item.type === 'tools') {
      if (item.events.length === 1) return eventRow(item.events[0], cfg);
      return toolGroupRow(item, cfg);
    }
    return eventRow(item.ev, cfg);
  }

  function upsertItems(items, animate) {
    for (const item of items) {
      const old = rowNodes.get(item);
      const node = renderItem(item);
      if (!node) continue;
      if (old && old.isConnected) {
        old.replaceWith(node);
      } else {
        if (animate) node.classList.add('is-new');
        feedList.prepend(node);
      }
      rowNodes.set(item, node);
    }
    while (feedList.children.length > MAX_ROWS) {
      const last = feedList.lastElementChild;
      for (const [k, v] of rowNodes) if (v === last) { rowNodes.delete(k); break; }
      last.remove();
    }
    feedAside.textContent = c.events.length ? `이벤트 ${fmtInt(c.events.length)}개` : '';
    if (!feedList.children.length) {
      feedList.replaceChildren(h('li', { class: 'feed-empty' }, isLive() ? '에이전트가 첫 작업을 시작하면 여기에 기록됩니다.' : '기록된 활동이 없습니다.'));
    } else {
      feedList.querySelector('.feed-empty')?.remove();
    }
  }

  function ingestBatch(events, animate) {
    const changed = new Set();
    for (const ev of events) {
      if (!ev || typeof ev !== 'object') continue;
      const seq = num(ev.seq);
      if (seq !== null && seq <= c.lastSeq) continue;
      if (seq !== null) c.lastSeq = seq;
      c.events.push(ev);
      const item = ingest(c, ev);
      if (item) changed.add(item);
    }
    if (c.events.length > MAX_EVENTS) c.events.splice(0, c.events.length - MAX_EVENTS);
    if (changed.size) upsertItems([...changed], animate);
    return changed.size;
  }

  // ── 종료 상태 ──
  function retryButton(label, kind) {
    // 데모는 키 없이 다시 재생한다(새 조사 화면으로 가면 키가 필요하다)
    if (status.demo) {
      const btn = button('데모 다시 보기', { kind, icon: 'play' });
      btn.addEventListener('click', async () => {
        try {
          const mod = await import('../onboarding.js');
          await mod.startDemo(num(status.demo_speed) ?? 1, btn);
        } catch (err) {
          setBusy(btn, false);
          toast(str(err?.message, '데모를 시작하지 못했습니다.'), 'error');
        }
      });
      return btn;
    }
    return button(label, {
      kind, icon: 'refresh',
      onClick: () => {
        const conf = { ...obj(status.config) };
        if (Array.isArray(status.formats) && status.formats.length) conf.formats = status.formats;
        const prefill = { prompt: str(status.prompt), config: conf };
        // 다시 쓰기 실행은 비용 한도를 강제로 비워 두므로, 그 값을 사용자의 선택으로 넘기지 않는다
        if (status.parent_id || status.rewrite) { delete conf.max_cost_usd; prefill.rewrite = true; }
        store.set({ prefill });
        navigate('#/');
      },
    });
  }

  /** 원래 실행이 이 브라우저의 기록에 있는지(목록을 아직 못 불러왔으면 있다고 본다) */
  function parentKnown() {
    const runs = store.get().runs;
    if (!Array.isArray(runs)) return true;
    const pid = str(status.parent_id);
    return runs.some((r) => r && str(r.id) === pid);
  }

  /** 보조 버튼: 다시 쓰기 실행이면 원래 결과로, 아니면 같은 설정으로 새 조사 */
  function restartButton(kind) {
    if (status.parent_id) {
      if (!parentKnown()) return h('span', { class: 'end-text muted' }, '원래 결과는 이 브라우저에 없습니다');
      return button('원래 결과 보기', { kind, icon: 'file-text', onClick: () => navigate(`#/run/${encodeURIComponent(str(status.parent_id))}`) });
    }
    return retryButton('처음부터 다시', kind);
  }

  /** 키·크레딧 문제로 멈춘 실행: 고친 뒤 이어서 진행하도록 안내한다 */
  function fixHint(code, resumable) {
    const then = resumable ? '이어서 진행하세요.' : '다시 시도하세요.';
    if (code === 'auth' || code === 'permission') {
      return h('p', { class: 'end-text end-key' }, icon('key', 14), h('span', null, `키를 고친 뒤 ${then} `),
        h('button', { type: 'button', class: 'link-btn', onClick: () => openKeyDialog() }, '키 입력'));
    }
    if (code === 'billing') {
      return h('p', { class: 'end-text end-key' }, icon('info', 14), h('span', null, `크레딧을 충전한 뒤 ${then} `),
        h('a', { class: 'link-btn', href: 'https://console.anthropic.com/settings/billing', target: '_blank', rel: 'noopener noreferrer' }, '결제 설정 열기'));
    }
    return null;
  }

  /** "이어서 진행" 주 버튼 + 키 안내 */
  function resumeParts() {
    const needKey = !status.demo && !getApiKey();
    const btn = button('이어서 진행', { kind: 'primary', icon: 'play' });
    btn.addEventListener('click', () => resumeRun(btn));
    const hint = needKey
      ? h('p', { class: 'end-text end-key' }, icon('key', 14), h('span', null, '이어서 진행하려면 API 키가 필요합니다. '),
        h('button', { type: 'button', class: 'link-btn', onClick: () => openKeyDialog() }, '키 입력'))
      : status.demo ? h('p', { class: 'end-text muted' }, '데모 실행은 키 없이 이어서 재생합니다.') : null;
    return { btn, hint };
  }

  function renderEnd() {
    const st = str(status.status);
    if (!lost && (isLive() || st === 'done')) { endSlot.replaceChildren(); return; }
    const resumable = !lost && status.resumable === true && (st === 'interrupted' || st === 'error');
    let card;
    if (lost) {
      card = h('div', { class: 'end-card end-error', role: 'alert' },
        h('span', { class: 'end-icon' }, icon('search', 20)),
        h('div', { class: 'end-body' },
          h('div', { class: 'end-title' }, '이 조사 기록을 찾을 수 없습니다'),
          h('p', { class: 'end-text' }, '기록이 삭제되었거나 이 브라우저에 저장되지 않았습니다. 더 이상 진행 상황을 받아 올 수 없습니다.')),
        h('div', { class: 'end-actions' }, button('새 조사', { kind: 'primary', icon: 'plus', onClick: () => navigate('#/') })));
    } else if (st === 'error') {
      const e = obj(status.error);
      const r = resumable ? resumeParts() : null;
      const fix = fixHint(str(e.code), resumable);
      // 키 문제면 '키 입력' 안내가 키 안내를 대신한다
      if (r && fix && (str(e.code) === 'auth' || str(e.code) === 'permission')) r.hint = null;
      card = h('div', { class: 'end-card end-error', role: 'alert' },
        h('span', { class: 'end-icon' }, icon('alert-triangle', 20)),
        h('div', { class: 'end-body' },
          h('div', { class: 'end-title' }, '조사 중 오류가 발생했습니다'),
          h('p', { class: 'end-text' }, str(e.message, '알 수 없는 오류로 조사가 멈췄습니다.')),
          str(e.code) ? h('p', { class: 'end-code mono' }, `오류 코드: ${e.code}`) : null,
          resumable
            ? h('p', { class: 'end-text muted' }, '마지막으로 저장된 단계부터 이어서 진행할 수 있습니다.')
            : h('p', { class: 'end-text muted' }, '아래 활동 기록에서 멈추기 전까지의 과정을 볼 수 있습니다.'),
          fix,
          r ? r.hint : null),
        h('div', { class: 'end-actions' }, r ? [restartButton('secondary'), r.btn] : retryButton('설정을 고쳐 다시 시도', 'primary')));
    } else if (st === 'interrupted') {
      const r = resumable ? resumeParts() : null;
      const e = obj(status.error);
      card = h('div', { class: 'end-card', role: 'status' },
        h('span', { class: 'end-icon' }, icon('alert-triangle', 20)),
        h('div', { class: 'end-body' },
          h('div', { class: 'end-title' }, '조사가 중간에 멈췄습니다'),
          h('p', { class: 'end-text' }, resumable
            ? '탭이 닫히거나 새로고침되어 멈췄습니다. 마지막으로 저장된 단계부터 이어서 진행할 수 있습니다.'
            : str(e.message) || '첫 단계가 저장되기 전에 멈춰 이어서 진행할 수 없습니다. 같은 설정으로 다시 조사할 수 있습니다.'),
          r ? r.hint : null),
        h('div', { class: 'end-actions' }, r ? [restartButton('secondary'), r.btn] : retryButton('다시 조사', 'primary')));
    } else {
      card = h('div', { class: 'end-card', role: 'status' },
        h('span', { class: 'end-icon' }, icon('stop', 20)),
        h('div', { class: 'end-body' },
          h('div', { class: 'end-title' }, '조사를 중단했습니다'),
          h('p', { class: 'end-text' }, '보고서는 만들어지지 않았습니다. 지금까지의 활동 기록은 아래에서 볼 수 있습니다.')),
        h('div', { class: 'end-actions' }, status.parent_id ? restartButton('primary') : retryButton('다시 조사', 'primary')));
    }
    endSlot.replaceChildren(card);
  }

  function renderAll() {
    renderHead();
    renderStepper();
    renderTiles();
    renderBudget(!isLive() || !budgetAt);
    renderBudgetNote();
    renderNow();
    renderPlan();
    renderReflections();
    renderPreview();
    renderEnd();
  }

  function applyStatus(next) {
    const prevStatus = str(status.status);
    status = { ...status, ...obj(next) };
    statusAt = performance.now();
    if (num(status.elapsed_s) !== null && !isLive()) shownElapsed = status.elapsed_s;
    renderAll();
    const now = str(status.status);
    // 완료·오류·검토 대기 알림(데스크톱 알림·소리·토스트)은 notify.js가 한 번만 낸다
    trackRunStatus(runId, status);
    if (now !== prevStatus) refreshRuns();
    if (now === 'done' && !finished) {
      finished = true;
      stop();
      setTimeout(() => { if (!disposed) onDone(status); }, 500);
    } else if (!isLive()) {
      stop();
      if (prevStatus && prevStatus !== now && ACTIVE_STATUSES.has(prevStatus) && now !== 'error') {
        toast(now === 'interrupted' ? '조사가 멈췄습니다. 이어서 진행할 수 있는지 확인하세요.' : '조사가 중단되었습니다.', 'info');
      }
    }
  }

  // ── 폴링 ──
  // 백엔드는 미리보기 위치를 코드 포인트로 센다(문자열 length는 UTF-16 단위)
  const cpLen = (s) => { let n = 0; for (const _ of s) n += 1; return n; };

  function resetPreview() {
    c.preview = '';
    c.previewPos = 0;
    c.previewTotal = null;
    previewBody.replaceChildren();
    previewLines = 0;
  }

  async function poll() {
    if (disposed || inflight || lost) return;
    inflight = true;
    try {
      const sentPos = c.previewPos;
      const res = obj(await api.events(runId, c.next || c.lastSeq, sentPos));
      if (disposed) return;
      failures = 0;
      connEl.hidden = true;
      const events = arr(res.events);
      const got = ingestBatch(events, true);
      const nx = num(res.next);
      c.next = Math.max(c.next, nx ?? c.lastSeq, c.lastSeq);
      // 보고서 단계가 새로 시작되면 백엔드 버퍼도 처음부터 다시 쌓인다
      const reportRestart = sentPos > 0 && events.some((ev) => str(ev?.kind) === 'stage' && str(ev?.stage) === 'report' && str(obj(ev?.data).status) === 'start');
      const pv = res.preview;
      if (pv && typeof pv === 'object' && typeof pv.text === 'string') {
        const from = num(pv.from) ?? 0;
        if (from < sentPos || reportRestart) {
          // 버퍼가 다시 시작됨: 패널을 비우고 백엔드가 알려 준 위치부터 다시 받는다
          resetPreview();
          // from이 0보다 크면 앞부분이 없으므로 다음 폴링에서 0부터 다시 받는다
          if (from === 0) {
            c.preview = pv.text;
            c.previewPos = cpLen(pv.text);
          }
        } else if (from === sentPos) {
          c.preview += pv.text;
          c.previewPos = from + cpLen(pv.text);
        }
        if (num(pv.total) !== null && c.preview) c.previewTotal = pv.total;
      } else if (reportRestart) resetPreview();
      if (res.status && typeof res.status === 'object') applyStatus(res.status);
      else if (got) { renderNow(); renderPlan(); renderReflections(); }
      renderPreview();
    } catch (err) {
      if (disposed) return;
      if (err?.status === 404) {
        // 백엔드가 이 실행을 모른다(삭제 등): 더 폴링하지 않고 종료 화면을 보인다
        lost = true;
        stop();
        connEl.hidden = true;
        renderAll();
        return;
      }
      failures += 1;
      connEl.hidden = false;
    } finally {
      inflight = false;
      schedule();
    }
  }

  function schedule() {
    clearTimeout(pollTimer);
    if (disposed || finished || !isLive()) return;
    const base = document.hidden ? 3000 : 1000;
    const delay = failures ? Math.min(10000, base * 2 ** Math.min(failures, 3)) : base;
    pollTimer = setTimeout(poll, delay);
  }

  function pollSoon() {
    clearTimeout(pollTimer);
    if (disposed || lost) return;
    pollTimer = setTimeout(poll, 150);
  }

  function stop() {
    clearTimeout(pollTimer);
    clearInterval(clockTimer);
    clockTimer = 0;
    cancelBtn.hidden = true;
    finishBtn.hidden = true;
    tickClock();
    updateEta();
  }

  /** 체크포인트에서 이어서 진행 (데모 실행은 키 없이) */
  async function resumeRun(btn) {
    if (resuming || disposed) return;
    const key = getApiKey();
    if (!status.demo && !key) {
      toast('이어서 진행하려면 API 키가 필요합니다. 키를 입력한 뒤 다시 눌러 주세요.', 'info');
      openKeyDialog();
      return;
    }
    unlockAudio();
    resuming = true;
    setBusy(btn, true, '이어서 시작하는 중…');
    try {
      const res = obj(await api.resume(runId, key ? { api_key: key } : {}));
      if (disposed) return;
      lost = false;
      finished = false;
      failures = 0;
      etaSmooth = null;
      etaText = '';
      applyStatus(obj(res.status).status ? res.status : { status: 'running' });
      watchRun(runId, status);
      if (!clockTimer && isLive()) clockTimer = setInterval(tick, 1000);
      toast('저장된 단계부터 이어서 진행합니다.', 'success');
      pollSoon();
    } catch (err) {
      if (disposed) return;
      setBusy(btn, false);
      if (err?.code === 'no_api_key' || err?.code === 'auth') openKeyDialog();
      toast(str(err?.message, '이어서 진행하지 못했습니다.'), 'error', { duration: 6000 });
    } finally {
      resuming = false;
    }
  }

  const onVisibility = () => {
    if (!document.hidden && isLive() && !inflight) pollSoon();
  };
  document.addEventListener('visibilitychange', onVisibility);

  async function cancelRun() {
    const ok = await confirmDialog('조사를 중단할까요? 지금까지의 활동 기록은 남지만 보고서는 만들어지지 않습니다.', '중단', { title: '조사 중단', danger: true });
    if (!ok || disposed) return;
    setBusy(cancelBtn, true, '중단하는 중…');
    try {
      const res = await api.cancel(runId);
      // 이미 끝난 실행이면 백엔드가 {ok:false}를 돌려준다
      if (res && res.ok === false) {
        setBusy(cancelBtn, false);
        toast('이미 끝났거나 중단된 조사입니다.', 'info');
      } else toast('중단을 요청했습니다.', 'info');
      pollSoon();
    } catch (err) {
      setBusy(cancelBtn, false);
      toast(str(err?.message, '중단하지 못했습니다.'), 'error');
    }
  }

  /** 지금 마무리: 추가 검색·재조사를 멈추고 지금까지 모은 근거로 보고서를 쓰게 한다 */
  async function finishEarly() {
    const ok = await confirmDialog('추가 검색과 재조사를 멈추고 지금까지 모은 근거로 보고서를 씁니다. 계속할까요?', '지금 마무리', { title: '지금 마무리' });
    if (!ok || disposed) return;
    setBusy(finishBtn, true, '요청하는 중…');
    try {
      if (typeof api.finishEarly !== 'function') throw Object.assign(new Error('이 실행은 일찍 마무리할 수 없습니다.'), { code: 'not_supported' });
      const res = obj(await api.finishEarly(runId));
      if (disposed) return;
      setBusy(finishBtn, false);
      const snap = obj(res.status);
      applyStatus(snap.status ? { ...snap, finish_requested: true } : { finish_requested: true });
      toast('추가 조사를 멈추고 보고서를 쓰도록 요청했습니다.', 'success');
      pollSoon();
    } catch (err) {
      if (disposed) return;
      setBusy(finishBtn, false);
      const code = str(err?.code);
      if (['not_now', 'not_supported', 'not_running'].includes(code)) {
        toast(str(err?.message, '지금은 마무리할 수 없습니다.'), 'info');
        pollSoon();
      } else toast(str(err?.message, '마무리를 요청하지 못했습니다.'), 'error');
    }
  }

  // ── 시작 ──
  // 캐시에 있던 기록을 먼저 그린다(새로 붙는 줄만 애니메이션)
  upsertItems(c.items.slice(-MAX_ROWS), false);
  renderAll();
  trackRunStatus(runId, status);
  watchRun(runId, status);
  if (isLive()) clockTimer = setInterval(tick, 1000);
  // 키 창에서 키를 넣으면 종료 카드의 안내를 바로 고친다
  const unsubKey = store.subscribe((s, p) => { if (s.keyStatus !== p.keyStatus && !isLive()) renderEnd(); });
  poll();

  return () => {
    disposed = true;
    clearTimeout(pollTimer);
    clearInterval(clockTimer);
    document.removeEventListener('visibilitychange', onVisibility);
    unsubKey();
    if (bell) bell.dispose();
  };
}

function nextQid(items) {
  let max = 0;
  for (const it of items) {
    const m = str(it.id).match(/^Q(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `Q${max + 1}`;
}

// ───────────────────────── 활동 기록 줄 ─────────────────────────

function toolLabel(name, cfg) {
  const n = str(name);
  const t = arr(cfg.tools).find((x) => x && x.name === n);
  if (t && str(t.label)) return t.label;
  const base = n.replace(/^search_/, '').replace(/_/g, ' ');
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : '검색';
}

function formatLabel(id, cfg) {
  const f = arr(cfg.formats).find((x) => x && x.id === id);
  return str(f?.label) || str(id).toUpperCase() || '결과물';
}

function rowShell(ev, cfg, variant, body, extraClass) {
  return h('li', { class: ['feed-row', `feed-${variant}`, extraClass], dataset: { kind: str(ev.kind) } },
    h('span', { class: 'feed-time mono' }, fmtTime(ev.ts)),
    h('span', { class: 'feed-stage' }, stageLabel(ev.stage, cfg)),
    h('div', { class: 'feed-body' }, body));
}

function toolInline(ev, cfg, { showSubq = true } = {}) {
  const d = obj(ev.data);
  if (!ev.data || (!d.tool && !d.query)) return [h('span', { class: 'feed-msg' }, str(ev.msg))];
  const count = num(d.count);
  return [
    showSubq && str(d.subq) ? h('span', { class: 'feed-q mono' }, d.subq) : null,
    h('span', { class: 'db-chip' }, toolLabel(d.tool, cfg)),
    h('code', { class: 'feed-query', title: str(d.query) }, truncate(d.query, 110)),
    h('span', { class: 'feed-count num' }, `→ ${count === null ? '?' : fmtInt(count)}건`),
    num(d.total) !== null ? h('span', { class: 'feed-total num' }, `누적 ${fmtInt(d.total)}`) : null,
  ];
}

function toolGroupRow(item, cfg) {
  const evs = item.events;
  const last = evs[evs.length - 1];
  const sum = evs.reduce((a, e) => a + (num(obj(e.data).count) ?? 0), 0);
  const total = num(obj(last.data).total);
  const details = h('details', { class: 'feed-group', open: item.open || null },
    h('summary', { class: 'feed-group-sum' },
      item.subq ? h('span', { class: 'feed-q mono' }, item.subq) : null,
      h('span', { class: 'feed-group-title' }, `검색 ${fmtInt(evs.length)}건`),
      h('span', { class: 'feed-count num' }, `→ ${fmtInt(sum)}건`),
      total !== null ? h('span', { class: 'feed-total num' }, `누적 ${fmtInt(total)}`) : null,
      icon('chevron-down', 14, 'feed-caret')),
    h('ol', { class: 'feed-sublist' }, [...evs].reverse().map((e) => h('li', { class: 'feed-subrow' },
      h('span', { class: 'feed-time mono' }, fmtTime(e.ts)),
      h('div', { class: 'feed-body' }, toolInline(e, cfg, { showSubq: false }))))));
  details.addEventListener('toggle', () => { item.open = details.open; });
  return rowShell(last, cfg, 'quiet', details, 'feed-row-group');
}

const PLAN_REVIEW_TEXT = {
  waiting: '계획 검토를 기다리는 중', approve: '계획을 승인했습니다', revise: '의견을 반영해 다시 계획합니다', edit: '수정한 계획으로 승인했습니다',
};

/** 이벤트 1건 → 활동 기록 줄 */
export function eventRow(ev, cfg = {}) {
  const kind = str(ev.kind);
  const d = obj(ev.data);
  const has = !!(ev.data && typeof ev.data === 'object');
  const msg = str(ev.msg);
  const plain = (variant, extra) => rowShell(ev, cfg, variant, [h('span', { class: 'feed-msg' }, msg), extra || null]);

  switch (kind) {
    case 'stage': {
      const round = num(d.round);
      return h('li', { class: 'feed-row feed-divider', dataset: { kind } },
        h('span', { class: 'feed-time mono' }, fmtTime(ev.ts)),
        h('span', { class: 'feed-divider-text' }, `${stageLabel(ev.stage, cfg)} 시작${round && round >= 2 ? ` · 재조사 ${round - 1}회차` : ''}`));
    }
    case 'tool':
      return rowShell(ev, cfg, 'quiet', toolInline(ev, cfg));
    case 'tool_error': {
      if (!has) return plain('muted');
      return rowShell(ev, cfg, 'muted', [
        icon('alert-triangle', 12, 'feed-ic'),
        str(d.subq) ? h('span', { class: 'feed-q mono' }, d.subq) : null,
        h('span', { class: 'db-chip' }, toolLabel(d.tool, cfg)),
        str(d.query) ? h('code', { class: 'feed-query', title: str(d.query) }, truncate(d.query, 80)) : null,
        h('span', { class: 'feed-err' }, `실패 · ${truncate(d.error, 100) || '알 수 없는 오류'}`),
      ]);
    }
    case 'tool_disabled':
      return rowShell(ev, cfg, 'warn', [icon('alert-triangle', 14, 'feed-ic'),
        h('span', { class: 'feed-msg' }, has && str(d.tool) ? `${toolLabel(d.tool, cfg)} 검색이 계속 실패해 이번 조사에서 제외했습니다` : msg)]);
    case 'warning':
    case 'budget':
      return rowShell(ev, cfg, 'warn', [icon('alert-triangle', 14, 'feed-ic'), h('span', { class: 'feed-msg' }, msg)]);
    case 'error':
      return rowShell(ev, cfg, 'error', [icon('alert-triangle', 14, 'feed-ic'), h('span', { class: 'feed-msg' }, msg)]);
    case 'subq_done': {
      if (!has || !str(d.subq)) return plain('summary');
      return rowShell(ev, cfg, 'summary', [
        h('span', { class: 'feed-strong' }, h('span', { class: 'feed-q mono' }, d.subq), ` 탐색 완료 · 관련 후보 ${fmtInt(d.found)}건`),
        str(d.summary) ? h('p', { class: 'feed-detail' }, truncate(d.summary, 240)) : null,
      ]);
    }
    case 'evaluate': {
      if (!has || num(d.evaluated) === null) return plain('summary');
      return rowShell(ev, cfg, 'summary', h('span', { class: 'feed-strong' },
        `문헌 평가 ${fmtInt(d.evaluated)}건 · 채택 ${fmtInt(d.included)}건`,
        num(d.merged) !== null ? ` · 중복 병합 ${fmtInt(d.merged)}건` : ''));
    }
    case 'synthesis': {
      if (!has || !str(d.subq)) return plain('summary');
      return rowShell(ev, cfg, 'summary', h('span', { class: 'feed-strong' },
        h('span', { class: 'feed-q mono' }, d.subq), ` 종합 완료 · 근거 ${fmtInt(d.n)}건 · 강도 `,
        STRENGTH_LABEL[str(d.strength)] || str(d.strength, '미평가')));
    }
    case 'report': {
      if (!has) return plain('summary');
      if (num(d.evidence) !== null) {
        return rowShell(ev, cfg, 'summary', h('span', { class: 'feed-strong' },
          `보고서 근거 ${fmtInt(d.evidence)}건 전달`, num(d.used) !== null ? ` · 종합에서 다룬 ${fmtInt(d.used)}건 포함` : ''));
      }
      if (num(d.chars) !== null) return rowShell(ev, cfg, 'summary', h('span', { class: 'feed-strong' }, `보고서 초안 완성 · ${fmtInt(d.chars)}자`));
      return plain('summary');
    }
    case 'verify': {
      if (!has || num(d.cited_ids) === null) return plain('summary');
      return rowShell(ev, cfg, 'summary', h('span', { class: 'feed-strong' },
        `인용 ID ${fmtInt(d.cited_ids)}개 · 미존재 ${fmtInt(d.unknown)}개 · 표본 ${fmtInt(d.checked)}문장 중 지지 ${fmtInt(d.supported)}`));
    }
    case 'repair': {
      if (!has || num(d.bad) === null) return plain('summary');
      return rowShell(ev, cfg, 'summary', h('span', { class: 'feed-strong' },
        `문제 문장 ${fmtInt(d.bad)}개 중 ${fmtInt(d.fixed)}개 수정 · 재검증 지지 ${fmtInt(d.supported_after)}/${fmtInt(d.checked)}`));
    }
    case 'understanding': {
      if (!has) return plain('emph');
      const concepts = arr(d.concepts).map(str).filter((x) => x && !x.startsWith('…')).slice(0, 8);
      const reqs = arr(d.requirements).map(str).filter(Boolean).slice(0, 5);
      return rowShell(ev, cfg, 'emph', [
        h('span', { class: 'feed-strong' }, '주제 이해', str(d.research_type) ? ` · ${d.research_type}` : ''),
        str(d.discipline) ? h('p', { class: 'feed-detail' }, truncate(d.discipline, 200)) : null,
        concepts.length ? h('div', { class: 'feed-tags' }, concepts.map((t) => h('span', { class: 'tag' }, truncate(t, 40)))) : null,
        reqs.length ? h('ul', { class: 'feed-bullets' }, reqs.map((r) => h('li', null, truncate(r, 160)))) : null,
      ]);
    }
    case 'window': {
      if (!has) return plain('emph');
      const y = num(d.year_from);
      return rowShell(ev, cfg, 'emph', [
        h('span', { class: 'feed-strong' }, `검색 기간: ${y ? `${y}년 이후` : '제한 없음'}`,
          h('span', { class: 'feed-soft' }, d.source === 'user' ? ' · 사용자 지정' : ' · 에이전트 판단')),
        str(d.reason) ? h('p', { class: 'feed-detail' }, truncate(d.reason, 240)) : null,
      ]);
    }
    case 'plan': {
      const qs = arr(d.sub_questions).filter((q) => q && typeof q === 'object');
      if (!has || !qs.length) return plain('emph');
      return rowShell(ev, cfg, 'emph', [
        h('span', { class: 'feed-strong' }, d.revised ? '계획 수정' : '조사 계획 수립', ` · 하위 질문 ${qs.length}개`),
        h('ul', { class: 'feed-bullets' }, qs.slice(0, 8).map((q) => h('li', null,
          h('span', { class: 'feed-q mono' }, str(q.id)), ' ', truncate(str(q.perspective) || str(q.question), 120)))),
      ]);
    }
    case 'plan_review':
      return rowShell(ev, cfg, 'emph', h('span', { class: 'feed-strong' }, PLAN_REVIEW_TEXT[str(d.action)] || msg || '계획 검토'));
    case 'finish_early':
      return rowShell(ev, cfg, 'emph', [icon('file-text', 14, 'feed-ic'),
        h('span', { class: 'feed-strong' }, msg || '사용자 요청으로 추가 조사를 멈추고 지금까지 모은 근거로 보고서를 씁니다.')]);
    case 'reflection':
      // 구조화된 값이 없는 옛 기록(샘플 등)은 카드가 아니라 보통 줄로 보여 준다(카드 줄의 위 여백이 붙지 않게)
      return has ? rowShell(ev, cfg, 'card', reflectionCard(d)) : plain('summary');
    case 'replan': {
      if (has && str(d.question)) {
        return rowShell(ev, cfg, 'summary', [
          h('span', { class: 'feed-strong' }, '새 하위 질문 ', h('span', { class: 'feed-q mono' }, str(d.subq)), ' 추가'),
          h('p', { class: 'feed-detail' }, truncate(d.question, 240)),
        ]);
      }
      const qs = arr(d.queries).map((q) => (typeof q === 'string' ? q : str(obj(q).query))).filter(Boolean);
      if (has && qs.length) {
        return rowShell(ev, cfg, 'summary', [
          h('span', { class: 'feed-strong' }, `추가 검색 ${qs.length}건 계획`),
          h('ul', { class: 'feed-bullets' }, qs.slice(0, 5).map((q) => h('li', null, h('code', { class: 'feed-query' }, truncate(q, 110))))),
        ]);
      }
      return plain('summary');
    }
    case 'export': {
      if (!has || !str(d.fmt)) return plain('quiet');
      const ok = d.ok !== false && !str(d.error);
      return rowShell(ev, cfg, ok ? 'quiet' : 'muted', [
        icon(ok ? 'check' : 'alert-triangle', 12, 'feed-ic'),
        h('span', { class: 'feed-msg' }, ok ? `${formatLabel(d.fmt, cfg)} 생성 완료` : `${formatLabel(d.fmt, cfg)} 생성 실패${str(d.error) ? ` · ${truncate(d.error, 100)}` : ''}`),
      ]);
    }
    default:
      // 이어서 진행한 실행의 첫 줄: {resume_from}
      if (kind === 'log' && has && d.resume_from !== undefined && d.resume_from !== null) {
        return rowShell(ev, cfg, 'emph', [icon('refresh', 14, 'feed-ic'), h('span', { class: 'feed-strong' }, msg || '저장된 단계부터 이어서 진행합니다')]);
      }
      return plain('log');
  }
}

/** 자기 비판 카드 (활동 기록 · 옆 칸 공용) */
export function reflectionCard(data, { compact = false } = {}) {
  const d = obj(data);
  const score = num(d.quality_score);
  const cont = truthy(d.should_continue);
  const risks = arr(d.bias_risks).map(str).filter((x) => x && !x.startsWith('…'));
  return h('div', { class: ['reflect', compact ? 'is-compact' : ''] },
    h('div', { class: 'reflect-score' },
      h('span', { class: 'reflect-num num' }, score === null ? '—' : String(score)),
      h('span', { class: 'reflect-den' }, '/10')),
    h('div', { class: 'reflect-body' },
      h('div', { class: 'reflect-head' },
        h('span', { class: 'reflect-round' }, `라운드 ${num(d.round) ?? '?'}`),
        cont ? badge('재조사 진행', 'accent', 'refresh') : badge(truthy(d.final) ? '최종 · 충분' : '충분', '', 'check')),
      str(d.reason) ? h('p', { class: 'reflect-reason', title: compact ? str(d.reason) : null }, compact ? truncate(d.reason, 180) : d.reason) : null,
      !compact && risks.length ? h('div', { class: 'reflect-risks' },
        h('div', { class: 'reflect-risks-title' }, icon('alert-triangle', 12), `편향 위험 ${risks.length}건`),
        h('ul', null, risks.slice(0, 6).map((r) => h('li', null, truncate(r, 220))))) : null,
      compact && risks.length ? h('div', { class: 'reflect-risk-count' }, `편향 위험 ${risks.length}건`) : null));
}
