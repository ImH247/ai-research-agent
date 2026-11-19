// 내보내기 공통 헬퍼: 문헌 표기, 메타 정보, 라벨. 모든 형식(md · html · docx · pptx · 참고문헌)이 같은 표기를 쓰게 한다.
// 입력은 항상 result 객체(PYTHON_SPEC 3.2)이고, 키가 없거나 빈 값이어도 죽지 않는다.

export const VERDICTS = ['supported', 'partially supported', 'not in source text', 'contradicted'];
// 본문 인용 표기: [S3] 또는 [S3, S12]. 전역 플래그가 없는 정규식이다(여러 번 찾을 때는 citeReGlobal()을 쓴다)
export const CITE_RE = /\[S\d+(?:\s*,\s*S\d+)*\]/;
export const citeReGlobal = () => new RegExp(CITE_RE.source, 'g');

// 보고서 언어별 고정 문구 (노트북 ⑥ 셀의 LABELS)
export const LABELS = {
  ko: {
    title: '연구 조사 보고서', topic: '연구 주제', gen: '생성', model: '모델', stats: '수집/채택 문헌',
    window: '검색 기간', nolimit: '제한 없음', since: '년 이후', merged: '중복 판본 병합', sent: '보고서 전달 근거',
    tableA: '부록 A. 근거 비교표', refB: '부록 B. 참고문헌', verC: '부록 C. 인용 검증', traceD: '부록 D. 에이전트 수행 기록',
    after: '수정 후', before: '수정 전', cols: ['ID', '문헌 · 유형', '방법 · 표본', '핵심 결과', '방향 · 점수'],
    contents: '목차', minutes: '분', calls: 'LLM 호출', tokens: '토큰', cost: '예상 비용', checked: '검증 문장',
    cited: '인용 ID', claims: '인용 문장',
  },
  en: {
    title: 'Research Brief', topic: 'Topic', gen: 'Generated', model: 'Model', stats: 'Collected/included sources',
    window: 'Search window', nolimit: 'no limit', since: ' onward', merged: 'duplicate versions merged',
    sent: 'sources given to report', tableA: 'Appendix A. Evidence table', refB: 'Appendix B. References',
    verC: 'Appendix C. Citation check', traceD: 'Appendix D. Agent trace', after: 'after revision', before: 'before',
    cols: ['ID', 'Source · type', 'Method · sample', 'Key finding', 'Direction · score'],
    contents: 'Contents', minutes: 'min', calls: 'LLM calls', tokens: 'tokens', cost: 'est. cost', checked: 'claims checked',
    cited: 'cited ids', claims: 'claims with citations',
  },
};

export function labels(result) {
  return result?.lang === 'ko' ? LABELS.ko : LABELS.en;
}

// 'S12' → 12 (형식이 다르면 0)
export function sidNum(sid) {
  const m = /^S(\d+)$/.exec(String(sid ?? ''));
  return m ? parseInt(m[1], 10) : 0;
}

// 배열이 아니면 빈 배열 (가져온 조사 파일처럼 모양이 어긋난 결과에서도 죽지 않게)
export const arr = (x) => (Array.isArray(x) ? x : []);

// 문헌의 저자 목록(문자열 배열). 문자열 하나로 들어온 저자는 ';'·','로 나눈다
export function authorList(s) {
  const a = s?.authors;
  if (Array.isArray(a)) return a.filter((n) => n !== null && n !== undefined && String(n).trim()).map(String);
  if (typeof a === 'string') return a.split(/[;,]/).map((x) => x.trim()).filter(Boolean);
  return [];
}

// 앞에서 n자만 남긴다. 서로게이트 쌍(이모지 등) 가운데에서 자르지 않는다
export function headCut(s, n) {
  let t = String(s ?? '').slice(0, Math.max(n, 0));
  const last = t.charCodeAt(t.length - 1);
  if (last >= 0xD800 && last <= 0xDBFF) t = t.slice(0, -1);
  return t;
}

// 첫 저자 이름 → 성 ("John Smith" → Smith, "Kim J"(Europe PMC 형식) → Kim). 없으면 ''
export function lastName(s) {
  const names = authorList(s);
  if (!names.length) return '';
  const parts = String(names[0]).replace(/,/g, ' ').trim().split(/\s+/);
  const last = parts[parts.length - 1];
  return (last.replace(/^\.+|\.+$/g, '').length > 2 || parts.length === 1) ? last : parts[0];
}

// 'Smith et al. (2024)' 형태의 짧은 표기 (노트북 Source.short_cite와 같은 규칙)
export function shortCite(s) {
  const names = authorList(s);
  const a = lastName(s) || s?.venue || 'n.a.';
  const etal = names.length > 1 ? ' et al.' : '';
  return `${a}${etal} (${s?.year || 'n.d.'})`;
}

export function authorsText(s, n = 3) {
  const authors = authorList(s);
  return authors.slice(0, n).join(', ') + (authors.length > n ? ' et al.' : '');
}

// http(s) 주소만 돌려준다 (그 외는 빈 문자열)
export function safeUrl(s) {
  const url = String(s?.url || s?.doi || '').trim();
  return (url.startsWith('http://') || url.startsWith('https://')) ? url : '';
}

// sid → 문헌. 프로토타입이 없는 객체라 'constructor' 같은 키가 끼어들지 않는다
export function sourcesById(result) {
  const out = Object.create(null);
  for (const s of arr(result?.sources)) {
    if (s && s.sid) out[s.sid] = s;
  }
  return out;
}

// 채택 문헌(관련성 ≥ 2), 종합 점수 높은 순
export function includedSources(result) {
  return arr(result?.sources).filter((s) => s && s.included)
    .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
}

// 참고문헌 목록용: 채택 문헌, S 번호순
export function referenceSources(result) {
  return includedSources(result).sort((a, b) => sidNum(a.sid) - sidNum(b.sid));
}

// 글에서 인용된 S 번호를 처음 나온 순서대로
export function citedIds(text) {
  const joined = (String(text || '').match(citeReGlobal()) || []).join(' ');
  return [...new Set(joined.match(/S\d+/g) || [])];
}

export function windowLabel(result) {
  const L = labels(result);
  const y = result?.meta?.year_from;
  return y ? `${y}${L.since}` : L.nolimit;
}

// 머리말·표지에 쓰는 값 모음 (문자열/숫자, 없으면 빈 값)
export function metaInfo(result) {
  const meta = result?.meta || {};
  const usage = meta.usage || {};
  const counts = meta.counts || {};
  const stamp = String(meta.finished_at || meta.created_at || '').slice(0, 16).replaceAll('T', ' ');
  return {
    date: stamp, model: meta.model_label || meta.model || '', window: windowLabel(result),
    collected: counts.collected ?? arr(result?.sources).length,
    included: counts.included ?? includedSources(result).length,
    merged: counts.merged ?? 0, report_evidence: counts.report_evidence ?? 0,
    minutes: Math.round(((Number(meta.elapsed_s) || 0) / 60) * 10) / 10,
    calls: usage.calls ?? 0, input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0, cost_usd: usage.cost_usd ?? null,
    note: meta.note || '',
  };
}

// 판정별 문장 수. after=true면 수정된 문장은 재검증 판정으로 센다
export function verdictTally(checks, after = false) {
  const out = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
  for (const c of arr(checks)) {
    const v = (after ? c?.verdict_after : null) || c?.verdict;
    if (Object.hasOwn(out, v)) out[v] += 1;
  }
  return out;
}

// 1234567 → '1,234,567' (파이썬 f'{n:,}'와 같게)
export function fmtInt(n) {
  const x = Number(n) || 0;
  return x.toLocaleString('en-US', { maximumFractionDigits: 20 });
}
