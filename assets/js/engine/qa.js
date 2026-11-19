// 근거 기반 후속 질문 (PYTHON_SPEC 4.6). 끝난 실행의 result만 가지고 답한다(새 검색은 하지 않음). (원본: agent/qa.py)

import { ABSTRACT_RULE, SYS_BASE } from './prompts.js';
import { cosineScores } from './tfidf.js';

const CITE_G = /\[S\d+(?:\s*,\s*S\d+)*\]/g;

/** [S3], [S1, S2] 형식으로 인용된 ID를 처음 나온 순서대로 (pipeline.citedIds와 같은 규칙). */
function cited(text) {
  return [...new Set((String(text || '').match(CITE_G) || []).join(' ').match(/S\d+/g) || [])];
}

/** 채택 문헌에서 질문과 가까운 근거 상위 k개: TF-IDF 유사도(0.7) + 평가 점수(0.3). */
export function retrieve(result, question, k = 8) {
  const pool = (result?.sources || []).filter((s) => s?.included);
  if (!pool.length) return [];
  const docs = pool.map((s) => `${s.title ?? ''} ${s.abstract ?? ''} ${s.key_finding ?? ''}`);
  const sims = cosineScores(String(question || ''), docs);   // 어휘가 비면 모두 0 → 점수만으로 순위
  const top = Math.max(...sims) || 1;
  const scoreOf = (s, sim) => 0.7 * sim / top + 0.3 * (Number(s.score) || 0);
  return pool.map((s, i) => [s, sims[i]]).sort((a, b) => scoreOf(...b) - scoreOf(...a)).slice(0, k).map(([s]) => s);
}

function evidenceLine(s) {
  const authors = s.authors || [];
  const who = authors.length ? authors[0] + (authors.length > 1 ? ' et al.' : '') : 'Unknown';
  return `[${s.sid}] ${who} (${s.year || 'n.d.'}) | type: ${s.study_type || s.kind || ''} | ` +
    `sample: ${s.sample || ''} | key finding: ${s.key_finding || ''}\n` +
    `    Title: ${s.title ?? ''}\n    Abstract: ${(s.abstract || '').slice(0, 900)}`;
}

/** 검색된 근거를 가장 많이 쓴 하위 질문 종합의 answer (최대 n개). */
function relatedSyntheses(result, sids, n = 2) {
  const questions = new Map(((result?.plan || {}).sub_questions || []).map((q) => [q.id, q.question || '']));
  const scored = [];
  for (const [qid, syn] of Object.entries(result?.syntheses || {})) {
    const overlap = (syn?.sources || []).filter((x) => sids.has(x)).length;
    if (overlap && syn.answer) scored.push([overlap, qid, syn.answer]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, n).map(([, qid, answer]) => `${qid}. ${questions.get(qid) || ''}\n${answer}`);
}

/**
 * 근거와 보고서 발췌(하위 질문 종합)만으로 답한다. → {answer_markdown, sources: [실제로 있는 인용 ID]}
 * @param {object} llm  LLM 또는 FakeLLM
 * @param {object} result  result.json
 * @param {string} question
 * @param {Array<{question: string, answer_markdown: string}>} [history]
 */
export async function answerQuestion(llm, result, question, history = []) {
  const lang = result?.lang || 'ko';
  const evidence = retrieve(result, question);
  const sids = new Set(evidence.map((s) => s.sid));
  const recent = (history || []).slice(-3).map((h) => `Q: ${h.question || ''}\nA: ${(h.answer_markdown || '').slice(0, 600)}`);
  const syntheses = relatedSyntheses(result, sids);
  const system = SYS_BASE + ' Answer follow-up questions about a finished literature review using ONLY the evidence and ' +
    'report excerpts given below. Do not use outside knowledge; if the evidence is insufficient, say so plainly. ' +
    ABSTRACT_RULE;
  const prompt = `Research topic: ${result?.topic || ''}
Follow-up question: ${question}

Recent Q&A (context only):
${recent.join('\n') || '(none)'}

Evidence:
${evidence.map(evidenceLine).join('\n') || '(no relevant evidence)'}

Related sub-question syntheses (report excerpts):
${syntheses.join('\n') || '(none)'}

Rules: cite evidence IDs like [S3] right after each claim, using only the IDs listed above.
Answer in Markdown, concisely (about 150-400 words). Write the answer in language "${lang}".`;
  const text = await llm.text(system, prompt, { effort: 'medium', maxTokens: 8000 });
  const known = new Set((result?.sources || []).map((s) => s.sid));
  return { answer_markdown: String(text || '').trim(), sources: cited(text).filter((s) => known.has(s)) };
}
