// Markdown 보고서 (노트북 ⑥ 셀의 build_markdown을 result 객체 입력으로 옮긴 것)
import * as theme from './theme.js';
import {
  VERDICTS, arr, authorsText, fmtInt, headCut, includedSources, labels, metaInfo, referenceSources, shortCite, verdictTally,
} from './common.js';

export const VERDICT_MARK = { 'supported': '✅', 'partially supported': '🟡', 'not in source text': '⚪', 'contradicted': '❌' };
const UNKNOWN = { ko: '미존재 ID 제거', en: 'unknown ids removed' };
const NONE = { ko: '없음', en: 'none' };

// 표 칸에 넣을 글: | 와 줄바꿈을 없애고 n자로 자른다 (노트북 그대로)
export function cell(x, n = 160) {
  return headCut(String(x || '').replaceAll('|', '/').replaceAll('\n', ' '), n);
}

function clipCell(x, n) {
  const s = cell(x, n + 1);
  return s.length > n ? headCut(s, n) + '…' : s;
}

// 방향 값 표시: 한국어 보고서는 theme 라벨, 영어는 원래 값
export function directionText(result, d) {
  if (result?.lang === 'ko') {
    const key = d || '';
    return Object.hasOwn(theme.DIRECTION_LABEL, key) ? theme.DIRECTION_LABEL[key] : key;
  }
  return d || '-';
}

const num2 = (v) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : '-');
const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '');

export function buildMarkdown(result) {
  result = result || {};
  const L = labels(result);
  const m = metaInfo(result);
  const lang = result.lang === 'ko' ? 'ko' : 'en';
  const inc = includedSources(result);
  let metaLine = `${L.gen}: ${m.date || '-'} · ${L.model}: ${m.model || '-'} · ${L.window}: ${m.window} · `
    + `${L.stats}: ${m.collected}/${m.included} (${L.merged} ${m.merged}, `
    + `${L.sent} ${m.report_evidence}) · ${m.minutes.toFixed(1)} ${L.minutes} · `
    + `${L.calls} ${m.calls} (in ${fmtInt(m.input_tokens)} / out ${fmtInt(m.output_tokens)} ${L.tokens})`;
  if (m.cost_usd !== null && m.cost_usd !== undefined) metaLine += ` · ${L.cost} $${(Number(m.cost_usd) || 0).toFixed(2)}`;
  const md = [`# ${L.title}`, `**${L.topic}**: ${result.topic || result.prompt || ''}  `, metaLine];
  if (m.note) md.push('', `> ${cell(m.note, 400)}`);
  md.push('', '---', '', String(result.report_markdown || '').trim(), '', '---', '',
    `## ${L.tableA}`, '', '| ' + L.cols.join(' | ') + ' |', '|' + '---|'.repeat(L.cols.length));

  // 부록 A: 채택 문헌, 종합 점수 높은 순
  for (const s of inc) {
    md.push(`| ${s.sid || ''} | ${cell(shortCite(s))}<br>${cell(s.study_type)} `
      + `| ${cell(s.method, 80)}<br>${cell(s.sample, 60)} `
      + `| ${cell(s.key_finding, 220)} | ${cell(directionText(result, s.direction))}<br>${num2(s.score)} |`);
  }

  // 부록 B: 참고문헌, S 번호순
  md.push('', `## ${L.refB}`, '');
  for (const s of referenceSources(result)) {
    const cites = s.citations !== null && s.citations !== undefined ? s.citations : '-';
    md.push(`- **[${s.sid}]** ${authorsText(s) || s.venue || ''} (${s.year || 'n.d.'}). `
      + `*${cell(s.title, 400)}*. ${s.venue || ''}. ${s.url || s.doi || ''} — `
      + `${s.kind || ''}, cites=${cites}, via ${s.origin || ''}`);
  }

  // 부록 C: 인용 검증
  const v = result.verification || {};
  const checks = Array.isArray(v.checks) ? v.checks : [];
  md.push('', `## ${L.verC}`, '',
    `- ${L.cited}: ${v.cited_ids ?? '-'} · ${UNKNOWN[lang]}: ${arr(v.unknown_ids).join(', ') || NONE[lang]}`
    + ` · ${L.claims}: ${v.claims_total ?? '-'} · ${L.checked}: ${checks.length}`);
  if (checks.length) {
    const tally = (after) => {
      const t = verdictTally(checks, after);
      return VERDICTS.map((k) => `${VERDICT_MARK[k]} ${k} ${t[k]}`).join(' · ');
    };
    md.push(`- ${L.before}: ${tally(false)}`, `- ${L.after}: ${tally(true)}`, '');
  }
  for (const c of checks) {
    if (!c || typeof c !== 'object') continue;
    md.push(`- ${VERDICT_MARK[c.verdict] || '❌'} ${c.verdict || '-'} — `
      + `“${clipCell(c.claim, 150)}” — ${cell(c.note, 400)}`);
    if (c.revised) {
      md.push(`  - → ${L.after}: ${VERDICT_MARK[c.verdict_after] || '❔'} ${c.verdict_after || '-'} — `
        + `“${clipCell(c.revised, 150)}” — ${cell(c.note_after, 400)}`);
    }
  }

  // 부록 D: 에이전트 수행 기록
  md.push('', `## ${L.traceD}`, '');
  for (const t of arr(result.trace)) {
    if (!t || typeof t !== 'object') continue;
    md.push(`- \`${String(t.ts || '').slice(11) || '-'}\` **${capitalize(String(t.stage || ''))}** — ${cell(t.msg, 250)}`);
  }
  return md.join('\n') + '\n';
}
