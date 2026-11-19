// 데모 실행 (SITE_SPEC 5, 원본: server/demo.py): API를 호출하지 않고, 기록된 실제 실행(샘플)의 이벤트를 빠르게 재생한다.
//
// 재생하면서 이벤트의 kind·data로 상태 스냅샷(단계, 라운드, 진행률, 집계, 사용량)을 실제 실행처럼 바꾼다.
// human_in_the_loop이면 계획 뒤에 실제로 멈춰 사용자 결정을 기다리고, 보고서 단계에서는 샘플 보고서를 조각내어
// 미리보기로 흘려보낸다. 끝나면 샘플 result를 새 id·사용자 prompt로 복사해 결과로 돌려준다.
// 웹 버전 변경점: 서버 전체 데모 모드 대신 실행마다 고른다(body.demo). speed는 '빠르기'(1 = 원본 속도 약 45초, 5 = 약 10초)이고,
// 단계가 바뀔 때마다 재생 위치를 체크포인트로 남겨 페이지를 새로 연 뒤에도 이어서 재생할 수 있다.

import { APP_VERSION } from './models.js';
import { STAGE_NAMES } from './pipeline.js';
import { retrieve } from './qa.js';
import { isoLocal } from './runs.js';

export const DEMO_SAMPLE = 'sample_genai_graduate_research';
export const DEMO_NOTE = '데모 모드 결과입니다. API를 호출하지 않고, 실제로 기록된 실행(중간고사 노트북, Claude Opus 5.5)의 ' +
  '과정과 결과를 재생했습니다. 보고서 내용은 입력한 요청이 아니라 기록된 실행의 주제에 대한 것입니다.';
// 이벤트 종류별 재생 간격(초). 빠르기로 나눈다. 샘플 91개 이벤트 + 보고서 미리보기로 전체 약 45초.
export const DELAYS = { tool: 0.3, tool_error: 0.3, tool_disabled: 0.3, subq_done: 0.5, evaluate: 0.6, synthesis: 0.5,
  reflection: 0.6, replan: 0.4, understanding: 0.6, window: 0.3, plan: 0.6, report: 0.4, verify: 0.6, repair: 0.6 };
export const REPORT_CHUNKS = 120;      // 보고서 미리보기를 몇 조각으로 나눌지
export const MAX_REVISIONS = 5;
export const PROGRESS_LABEL = { act: '하위 질문 탐색', synthesize: '하위 질문 종합' };
const STEP_MS = 100;                   // 쉬는 동안 취소를 확인하는 간격

const sleepMs = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const clone = (x) => (x === undefined || x === null ? x : JSON.parse(JSON.stringify(x)));

/** 취소를 확인하면서 쉰다(적어도 한 번은 이벤트 루프를 돌려 화면이 멈추지 않게). */
async function pause(run, ms) {
  const end = Date.now() + ms;
  for (;;) {
    await run.checkpoint();
    const left = end - Date.now();
    await sleepMs(Math.min(Math.max(left, 0), STEP_MS));
    if (left <= STEP_MS) {
      await run.checkpoint();
      return;
    }
  }
}

/** events.jsonl 문자열 → 이벤트 배열 (빈 줄·깨진 줄은 건너뜀) */
export function parseJsonl(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) out.push(obj);
    } catch { /* 깨진 줄은 건너뛴다 */ }
  }
  return out;
}

/**
 * 이벤트마다 [이벤트, 실제로 속한 단계, 라운드]를 붙인다.
 * 계속하자는 자기 비판 뒤의 탐색부터 라운드가 오르고, replan 이벤트는 다음 라운드의 탐색(act) 단계에서 일어난다.
 */
export function annotate(events) {
  const out = [];
  let rnd = 1;
  let pending = null;
  for (const ev of events) {
    const stage = ev.kind === 'replan' ? 'act' : ev.stage;
    if (pending && stage === 'act') {
      rnd = pending;
      pending = null;
    }
    out.push([ev, stage, rnd]);
    const d = ev.data || {};
    if (ev.kind === 'reflection' && d.should_continue && !d.final) pending = rnd + 1;
  }
  return out;
}

function emitStage(run, stage, rnd, status) {
  const suffix = rnd > 1 ? ` (라운드 ${rnd})` : '';
  run.emit(stage, 'stage', `${STAGE_NAMES[stage] || stage} ${status === 'start' ? '시작' : '완료'}${suffix}`,
    { status, round: rnd });
}

/** 사용량을 샘플의 최종값 쪽으로 비례해서 늘린다. */
function usageAt(target, frac) {
  const cost = target.cost_usd;
  return {
    calls: Math.round((target.calls || 0) * frac), input_tokens: Math.round((target.input_tokens || 0) * frac),
    output_tokens: Math.round((target.output_tokens || 0) * frac),
    cost_usd: cost === null || cost === undefined ? null : Math.round(cost * frac * 100) / 100,
  };
}

async function streamReport(run, text, scale, minMs) {
  const size = Math.max(1, Math.floor(text.length / REPORT_CHUNKS) + 1);
  for (let i = 0; i < text.length; i += size) {
    let end = Math.min(text.length, i + size);
    // 서로게이트 쌍을 가르지 않게
    const c = text.charCodeAt(end - 1);
    if (end < text.length && c >= 0xd800 && c <= 0xdbff) end += 1;
    run.reportDelta(text.slice(i, end));
    i = end - size;
    await pause(run, Math.max(minMs, 70 * scale));
  }
}

/** 계획 검토: 실제로 멈춰서 결정을 기다린다. revise면 재계획한 척하고 다시 기다린다. */
async function review(run, scale) {
  for (let i = 0; i < MAX_REVISIONS + 1; i++) {
    run.emit('plan', 'plan_review', '조사 계획 검토를 기다리는 중', { action: 'waiting' });
    const d = (await run.waitPlan(run.plan)) || {};
    if (d.action === 'revise') {
      run.emit('plan', 'plan_review', `사용자 피드백 반영하여 재계획: ${d.feedback || ''}`, { action: 'revise' });
      await pause(run, 1000 * scale);
      const sqs = (run.plan || {}).sub_questions || [];
      const brief = sqs.map((q) => ({ id: q.id, question: q.question, perspective: q.perspective }));
      run.emit('plan', 'plan', `하위 질문 ${sqs.length}개 수립 (검토 의견 반영 · 데모: 기록된 계획을 그대로 씀)`,
        { sub_questions: brief, revised: true });
      continue;
    }
    if (Array.isArray(d.sub_questions) && d.sub_questions.length) {
      run.emit('plan', 'plan_review', `사용자가 하위 질문 목록을 수정함 (${d.sub_questions.length}개) · ` +
        '데모에서는 기록된 계획대로 이어서 재생합니다', { action: 'edit' });
    } else {
      run.emit('plan', 'plan_review', '조사 계획 승인', { action: 'approve' });
    }
    return;
  }
  run.emit('plan', 'warning', '재계획 요청 횟수를 넘어 현재 계획으로 진행합니다', null);
}

/**
 * 샘플 실행을 재생하고, 새 id·사용자 prompt를 넣은 result를 돌려준다.
 * @param {import('./runs.js').Run} run
 * @param {object} sample  샘플 result.json
 * @param {object[]} events  샘플 events.jsonl의 이벤트
 * @param {{speed?: number, startAt?: number, onCheckpoint?: (pos: number) => Promise<void>, timeScale?: number}} [opts]
 *   speed: 빠르기(1 = 약 45초). startAt: 이어하기 위치(이 순번의 이벤트부터 재생).
 *   onCheckpoint(pos): 단계가 바뀔 때 재생 위치를 저장. timeScale: 테스트용 추가 배속(기본 1).
 */
export async function replay(run, sample, events, { speed = 1, startAt = 0, onCheckpoint = null, timeScale = 1 } = {}) {
  const plan = sample.plan || {};
  const byId = new Map((plan.sub_questions || []).map((sq) => [sq.id, sq]));
  const target = (sample.meta || {}).usage || {};
  const items = annotate(events);
  const totals = new Map();
  const key = (rnd, stage) => `${rnd}|${stage}`;
  for (const [ev, stage, rnd] of items) {
    if (ev.kind === 'subq_done' || ev.kind === 'synthesis') totals.set(key(rnd, stage), (totals.get(key(rnd, stage)) || 0) + 1);
  }
  const done = new Map();
  const scale = 1 / Math.max(0.01, (Number(speed) || 1) * (Number(timeScale) || 1));
  const minMs = 5 / Math.max(1, Number(timeScale) || 1);
  const start = Math.max(0, Math.min(Math.trunc(Number(startAt) || 0), items.length));

  // 이어하기: 이미 재생한 부분의 진행률 집계만 되살린다
  for (const [ev, stage, rnd] of items.slice(0, start)) {
    if (ev.kind === 'subq_done' || ev.kind === 'synthesis') done.set(key(rnd, stage), (done.get(key(rnd, stage)) || 0) + 1);
  }
  if (start === 0) run.emit('system', 'log', '데모 모드: 기록된 실제 실행을 재생합니다 (API를 호출하지 않음)', null);
  else run.emit('system', 'log', '데모 모드: 저장된 위치에서 이어서 재생합니다', { resume_from: start });

  let current = null;
  for (let i = start; i < items.length; i++) {
    const [ev, stage, rnd] = items[i];
    const kind = ev.kind;
    const data = clone(ev.data ?? null);
    if (stage !== 'system' && (!current || current[0] !== stage || current[1] !== rnd)) {
      if (current) emitStage(run, current[0], current[1], 'end');
      current = [stage, rnd];
      if (onCheckpoint) await onCheckpoint(i);
      emitStage(run, stage, rnd, 'start');
    }
    await pause(run, (DELAYS[kind] ?? 0.2) * 1000 * scale);

    if (kind === 'plan') {
      const ids = ((data || {}).sub_questions || []).filter((q) => q && typeof q === 'object').map((q) => q.id);
      run.setPlan({ ...plan, sub_questions: ids.filter((q) => byId.has(q)).map((q) => byId.get(q)) });
    } else if (kind === 'replan' && byId.has((data || {}).subq)) {
      const p = clone(run.plan || { sub_questions: [] });
      if (!Array.isArray(p.sub_questions)) p.sub_questions = [];
      if (!p.sub_questions.some((q) => q.id === data.subq)) p.sub_questions.push(byId.get(data.subq));
      run.setPlan(p);
    } else if (kind === 'report' && data && 'chars' in data) {
      await streamReport(run, sample.report_markdown || '', scale, minMs);
    }

    run.emit(ev.stage, kind, ev.msg, data);
    if (kind === 'plan' && run.config.human_in_the_loop) await review(run, scale);
    if (kind === 'subq_done' || kind === 'synthesis') {
      const k = key(rnd, stage);
      done.set(k, (done.get(k) || 0) + 1);
      run.setProgress(stage, done.get(k), totals.get(k), PROGRESS_LABEL[stage] || '');
    }
    run.setUsage(usageAt(target, (i + 1) / items.length));
  }
  if (current) emitStage(run, current[0], current[1], 'end');
  await run.checkpoint();
  return demoResult(run, sample);
}

/** 샘플 result를 새 id·사용자 prompt로 복사한다. */
export function demoResult(run, sample) {
  const result = clone(sample);
  result.id = run.id;
  result.prompt = run.prompt;
  result.meta = result.meta || {};
  Object.assign(result.meta, {
    created_at: run.created_at, finished_at: isoLocal(run._now ? run._now() : new Date()),
    elapsed_s: run.elapsed(), config: run.config.toDict(), app_version: APP_VERSION,
    sample: false, demo: true, note: DEMO_NOTE, budget_cap_usd: null, budget_hit: false,
  });
  // 새 실행 결과(toResult)와 같은 모양이 되도록 비용 한도 필드를 맞춘다(데모는 한도 없음)
  result.budget_cap_usd = null;
  result.budget_hit = false;
  return result;
}

/** 데모용 후속 질문 답: LLM 없이 qa.retrieve로 찾은 관련 근거 목록. */
export function demoAnswer(result, question, k = 5) {
  const top = retrieve(result, question, k);
  const lines = [`**데모 모드: 관련 근거 상위 ${top.length}건** (API 키로 실행하면 이 근거로 답변을 만듭니다.)`, ''];
  for (const s of top) {
    const finding = s.key_finding || String(s.abstract || '').slice(0, 160);
    const year = s.year || 'n.d.';
    lines.push(`- [${s.sid}] ${s.title || ''} (${year}) — ${finding}`);
  }
  if (!top.length) lines.push('관련 근거를 찾지 못했습니다.');
  return { answer_markdown: lines.join('\n'), sources: top.map((s) => s.sid) };
}
