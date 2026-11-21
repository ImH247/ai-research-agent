// 발표 슬라이드(.pptx) 그리기 (docs/SLIDES_V2.md 3절). 무엇을 말할지는 구성안(slides.js)이 정하고, 이 파일은 그리기만 한다.
//
// 16:9 빈 슬라이드 위에 격자(구역 이름 · 제목 · 본문 · 꼬리말)를 한 번 정해 두고 모든 도형을 직접 배치한다.
// PowerPoint는 글자를 알아서 줄여 주지 않으므로, 글자 폭 · 글자 크기 · 상자 너비로 줄바꿈을 미리 셈해
// 글자 크기 단계를 고르고, 가장 작은 단계로도 넘치면 마지막 수단으로 글을 줄인다(끝에 '…').
// pptxgenjs가 직접 지정하지 못하는 것(차트 글자의 한글 글꼴, 글머리 기호 색, 계열별 데이터 레이블 색)은
// 만든 뒤 zip 안의 XML을 고쳐 맞춘다.
import PptxGenJS from '../../../vendor/pptxgenjs.js';
import JSZip from '../../../vendor/jszip.js';
import * as theme from './theme.js';
import { VERDICTS, arr, authorsText, citeReGlobal, citedIds, fmtInt, metaInfo, shortCite, sidNum, sourcesById,
  verdictTally } from './common.js';
import { STRENGTHS, clip, emLen, fallbackDeck, isDeck, normalizeDeck, stripControl } from './slides.js';

// ---------------------------------------------------------------- 색 (발표 자료 전용, SLIDES_V2 3.1)
// 다른 결과물(HTML · Word)의 색은 theme.js에 있고 여기서는 쓰지 않는다. 사이트의 라벤더 디자인과 같은 계열이다
const C = {
  INK: '1E1933', INK_2: '4B4463', MUTED: '7A7391',
  RULE: 'E5DEF5', TINT: 'F7F4FF', TINT_2: 'EEE8FF',
  PURPLE: '6A3DE8', VIOLET: '7C4DF0', DEEP: '24184D', DEEP_2: '34226B', LAV: 'C9B8FD',
  MINT: '19B8A2', MINT_DARK: '097A6B', MINT_SOFT: 'E1F6F2',
  CORAL: 'F26D50', CORAL_DARK: 'BE3324', CORAL_SOFT: 'FFEDE4',
  GRAY: 'CFC9E0', WHITE: 'FFFFFF',
};
// 근거 강도: 막대 색 · 옅은 면 · 글자 색 · 채울 칸 수(4칸 중). 색만으로 구분하지 않도록 칸 수와 글자를 함께 쓴다
const STRENGTH_STYLE = {
  strong: { bar: C.MINT_DARK, soft: C.MINT_SOFT, ink: C.MINT_DARK, n: 4 },
  moderate: { bar: C.PURPLE, soft: C.TINT_2, ink: C.PURPLE, n: 3 },
  weak: { bar: C.CORAL, soft: C.CORAL_SOFT, ink: C.CORAL_DARK, n: 2 },
  insufficient: { bar: C.MUTED, soft: 'F1EEF6', ink: C.MUTED, n: 1 },
};
// 결과 방향(도넛): 긍정 민트 · 부정 코랄 · 혼재 보라 · 효과 없음 라벤더 · 해당 없음/미분류 회색
const DIRECTION_FILL = {
  'positive': C.MINT, 'negative': C.CORAL, 'mixed': C.VIOLET, 'null': C.LAV,
  'not applicable': C.GRAY, '': 'E4E0EC',
};
// 인용 검증 판정
const VERDICT_FILL = {
  'supported': C.MINT, 'partially supported': C.CORAL, 'not in source text': C.GRAY, 'contradicted': C.CORAL_DARK,
};

// ---------------------------------------------------------------- 격자 (단위: 인치)
const W = 13.333, H = 7.5;
const ML = 0.75;                      // 좌우 여백
const CW = W - 2 * ML;                // 본문 너비
const KICK_Y = 0.5, KICK_H = 0.32;    // 구역 이름
const TITLE_Y = 0.84, TITLE_H = 1.2;  // 제목(최대 2줄)
const TOP = 2.2, BOTTOM = 6.7;        // 본문 영역
const TOP_C = 1.6;                    // 제목이 한 줄뿐인 부록 슬라이드의 본문 시작
const FOOT_Y = 7.0, FOOT_H = 0.28;    // 꼬리말
const MX = 0.05, MY = 0.03;           // 글상자 안쪽 여백
const GAP = 0.3;                      // 카드 사이 간격
const PAD = 0.28;                     // 카드 안쪽 여백

// 줄 수 셈에 쓰는 값: 줄 폭은 2% 덜 쓰는 것으로 치고(WRAP), 줄 높이는 글자 크기의 1.2배(LINE, PowerPoint로 잰 값)
const WRAP = 0.98, LINE = 1.2;
const FONT = theme.FONT_KO;

// ---------------------------------------------------------------- 고정 문구 (한 표에 두 언어)
const TXT = {
  ko: {
    product: 'AI RESEARCH AGENT', none: '자료 없음', unit: '건',
    collected: '수집', included: '채택', window: '검색 기간',
    q_k: '오늘의 질문', why_now: '왜 지금인가', scope: '조사 범위', scope_items: ['검색 기간', '채택 문헌', '하위 질문'],
    n_q: (n) => `${n}개`, n_src: (n) => `${fmtInt(n)}건`,
    ans_k: '한 문장 결론', strip: '하위 질문별 근거 강도',
    method_k: '조사 방법', method_t: (c, i) => `AI 에이전트가 문헌 ${c}건을 모아 ${i}건을 추렸습니다`,
    steps_k: '에이전트 8단계', flow_k: '문헌 흐름',
    steps: [['주제 이해', '개념 · 기간'], ['계획 수립', '하위 질문'], ['문헌 탐색', '학술 DB · 웹'],
      ['근거 평가', '관련성 · 신뢰도'], ['종합', '질문별 정리'], ['성찰', '재조사 판단'],
      ['보고서', '브리프 작성'], ['인용 검증', '초록 대조']],
    flow: ['수집', '중복 병합', '채택', '본문 인용'],
    model: '모델', elapsed: '소요 시간', minutes: (m) => `${m}분`, calls: 'LLM 호출', n_calls: (n) => `${fmtInt(n)}회`,
    disabled: '제외된 도구',
    ev_k: '근거 지형', ev_t: (n) => `채택 문헌 ${n}건은 어떤 근거인가`,
    study: '연구 유형', year: '출판 연도', direction: '결과 방향', other: '기타',
    cap_type: (name, n, p) => `가장 많은 유형은 ${name}(${n}건, ${p}%)`,
    cap_years: (a, b, p) => `${a}–${b}년 문헌이 ${p}%`, cap_year1: (y) => `모두 ${y}년 문헌`,
    cap_dir: (parts) => parts.map(([l, n]) => `${l} ${n}건`).join(' · '),
    msg_k: (i, k) => `핵심 메시지 ${i} / ${k}`, strength: '근거 강도', so: '그래서', more: (n) => ` 외 ${n}건`,
    st_k: '근거의 단단함',
    st_t: (n, m) => (m ? `하위 질문 ${n}개 중 ${m}개는 근거가 '약함' 이하입니다` : `하위 질문 ${n}개 모두 근거가 '중간' 이상입니다`),
    st_cols: ['하위 질문', '근거 강도', '근거 수'], st_more: (n) => `외 하위 질문 ${n}개는 부록 A에 있습니다`,
    ten_k: '일치와 상충', ten_t: '연구들이 같은 말을 하는 곳과 엇갈리는 곳',
    agree: '일치하는 점', conflict: '엇갈리는 점', why: '왜 엇갈리나',
    gaps_k: '연구 공백', gaps_t: (n) => `아직 답하지 못한 질문 ${n}가지`,
    next_k: '다음 연구 제안', next_t: (n) => `근거를 채울 다음 연구 ${n}가지`,
    fields: [['design', '설계'], ['sample', '표본'], ['payoff', '기대 기여']],
    caut_k: '주의할 점', caut_t: '이 결과를 읽을 때 주의할 점', no_caut: '기재된 주의 사항이 없습니다.',
    check: '인용 검증', check_figs: ['인용 문헌', '검증 문장', '고친 문장'], verdict: '판정', before: '수정 전', after: '수정 후',
    no_check: '인용 검증 기록이 없습니다.',
    take_k: '기억할 세 가지',
    qa: '질문과 토론', qa_sub: (c, i) => `이 발표 자료는 AI Research Agent가 수집한 문헌 ${c}건 중 채택한 ${i}건을 바탕으로 만들었습니다.`,
    plan_src: { llm: '발표 구성: AI가 보고서를 바탕으로 따로 짠 구성안', sample: '발표 구성: 미리 만들어 둔 샘플 구성안',
      rules: '발표 구성: 보고서의 문장을 규칙에 따라 고른 구성안' },
    app_k: '부록', app_t: '부록',
    app_items: [['A', '하위 질문', '원래 질문과 근거 강도'], ['B', '필독 문헌', '먼저 읽을 문헌과 그 이유'],
      ['C', '참고문헌', '슬라이드와 노트에 인용한 문헌']],
    appA_t: '하위 질문과 근거 강도', appB_t: '먼저 읽을 문헌', appC_t: '참고문헌',
    page: (i, n) => ` (${i}/${n})`,
  },
  en: {
    product: 'AI RESEARCH AGENT', none: 'No data', unit: '',
    collected: 'collected', included: 'included', window: 'Search window',
    q_k: 'Today\'s question', why_now: 'Why now', scope: 'Scope', scope_items: ['Search window', 'Included sources', 'Sub-questions'],
    n_q: (n) => `${n}`, n_src: (n) => `${fmtInt(n)}`,
    ans_k: 'The bottom line', strip: 'Evidence strength by sub-question',
    method_k: 'Method', method_t: (c, i) => `An AI agent collected ${c} sources and kept ${i}`,
    steps_k: 'Eight agent stages', flow_k: 'Source flow',
    steps: [['Understand', 'concepts, scope'], ['Plan', 'sub-questions'], ['Search', 'databases, web'],
      ['Evaluate', 'relevance'], ['Synthesize', 'per question'], ['Reflect', 'search again?'],
      ['Report', 'write brief'], ['Verify', 'check citations']],
    flow: ['Collected', 'Duplicates merged', 'Included', 'Cited in text'],
    model: 'Model', elapsed: 'Time', minutes: (m) => `${m} min`, calls: 'LLM calls', n_calls: (n) => fmtInt(n),
    disabled: 'Disabled tools',
    ev_k: 'Evidence landscape', ev_t: (n) => `What the ${n} included sources look like`,
    study: 'Study type', year: 'Publication year', direction: 'Result direction', other: 'Other',
    cap_type: (name, n, p) => `Most common: ${name} (${n}, ${p}%)`,
    cap_years: (a, b, p) => `${p}% published ${a}–${b}`, cap_year1: (y) => `All published in ${y}`,
    cap_dir: (parts) => parts.map(([l, n]) => `${l} ${n}`).join(' · '),
    msg_k: (i, k) => `Key message ${i} / ${k}`, strength: 'Evidence', so: 'So what', more: (n) => ` +${n} more`,
    st_k: 'How solid is the evidence',
    st_t: (n, m) => (m ? `${m} of ${n} sub-questions rest on weak evidence` : `All ${n} sub-questions have at least moderate evidence`),
    st_cols: ['Sub-question', 'Evidence strength', 'Sources'], st_more: (n) => `${n} more sub-questions in Appendix A`,
    ten_k: 'Agreement and conflict', ten_t: 'Where the studies agree and where they part',
    agree: 'Where they agree', conflict: 'Where they differ', why: 'Why they differ',
    gaps_k: 'Research gaps', gaps_t: (n) => (n === 1 ? 'One question still open' : `${n} questions still open`),
    next_k: 'Next studies', next_t: (n) => (n === 1 ? 'One study that would fill the gaps' : `${n} studies that would fill the gaps`),
    fields: [['design', 'Design'], ['sample', 'Sample'], ['payoff', 'Payoff']],
    caut_k: 'Cautions', caut_t: 'Read these results with care', no_caut: 'No cautions were listed.',
    check: 'Citation check', check_figs: ['Cited sources', 'Claims checked', 'Claims revised'], verdict: 'Verdict',
    before: 'Before', after: 'After', no_check: 'No citation check was recorded.',
    take_k: 'Three things to remember',
    qa: 'Q & A', qa_sub: (c, i) => `These slides were made by AI Research Agent from ${i} of the ${c} sources it collected.`,
    plan_src: { llm: 'Slide plan: written by the AI from the brief', sample: 'Slide plan: prepared sample plan',
      rules: 'Slide plan: sentences chosen from the brief by rules' },
    app_k: 'Appendix', app_t: 'Appendix',
    app_items: [['A', 'Sub-questions', 'Original questions and evidence strength'], ['B', 'Must-read', 'Read these first, and why'],
      ['C', 'References', 'Every source cited on the slides or in the notes']],
    appA_t: 'Sub-questions and evidence strength', appB_t: 'Read these first', appC_t: 'References',
    page: (i, n) => ` (${i}/${n})`,
  },
};
const STRENGTH_EN = { strong: 'Strong', moderate: 'Moderate', weak: 'Weak', insufficient: 'Insufficient' };
const VERDICT_EN = {
  'supported': 'Supported', 'partially supported': 'Partly supported',
  'not in source text': 'Not in abstract', 'contradicted': 'Contradicted',
};
const STUDY_EN = {
  'meta-analysis/systematic review': 'Meta-analysis', 'RCT/experiment': 'RCT / experiment', 'quasi-experiment': 'Quasi-experiment',
  'longitudinal': 'Longitudinal', 'survey/correlational': 'Survey', 'qualitative': 'Qualitative', 'mixed methods': 'Mixed methods',
  'case study': 'Case study', 'theoretical/conceptual': 'Theory', 'review/commentary': 'Review', 'report/web article': 'Report / web',
};
const DIRECTIONS = Object.keys(theme.DIRECTION_LABEL);   // 고정 순서 → 계열색 고정

// ---------------------------------------------------------------- 글자 맞춤 어림

// 글을 그리기 전에 "이 상자에 몇 줄이 되는가"를 미리 셈해서 글자 크기와 자리를 정한다.
// PowerPoint가 글을 놓는 방식을 그대로 따라 한다(맑은 고딕을 PowerPoint로 그려 잰 값):
//   · 글자 폭: 100pt로 10자 · 40자를 그려 그 차이로 잰 값(em × 1000). 보통 글자와 굵은 글자가 다르다
//   · 줄 높이: 글자 크기 × 1.2 (LINE)
//   · 줄바꿈: 한글도 띄어쓰기에서만 줄을 바꾼다. 한 줄보다 긴 낱말만 글자 단위로 끊는다
// (전체 폭 ÷ 줄 폭으로 어림하면, 낱말이 통째로 다음 줄로 넘어가며 생기는 빈자리를 놓쳐 실제보다 한 줄 적게 셈한다
//  → 아래 글과 겹친다. 그래서 낱말 단위로 직접 놓아 본다.)

// ASCII 0x20~0x7E의 폭: 보통 / 굵게
const ASCII_W = [
  352, 289, 395, 607, 552, 837, 818, 233, 305, 305, 425, 702, 219, 410, 219, 397,
  552, 552, 552, 552, 552, 552, 552, 552, 552, 552, 219, 219, 702, 702, 702, 460,
  980, 659, 584, 607, 718, 518, 499, 702, 725, 270, 326, 590, 480, 918, 765, 774,
  572, 774, 610, 543, 555, 703, 634, 954, 602, 564, 583, 305, 764, 305, 702, 427,
  273, 520, 600, 473, 603, 535, 317, 603, 579, 247, 265, 507, 247, 880, 579, 599,
  600, 603, 354, 433, 345, 579, 488, 737, 465, 493, 463, 305, 239, 305, 702,
];
const ASCII_WB = [
  352, 324, 477, 608, 580, 875, 858, 282, 358, 358, 457, 719, 262, 414, 262, 439,
  580, 580, 580, 580, 580, 580, 580, 580, 580, 580, 262, 262, 719, 719, 719, 453,
  979, 704, 638, 607, 745, 539, 525, 723, 770, 310, 404, 645, 513, 964, 798, 777,
  615, 777, 654, 567, 604, 732, 672, 1010, 654, 607, 612, 358, 764, 358, 719, 427,
  309, 543, 627, 488, 627, 550, 373, 627, 608, 275, 295, 555, 275, 924, 609, 620,
  627, 627, 394, 463, 384, 609, 537, 795, 539, 537, 484, 358, 309, 358, 719,
];
// 그 밖에 자주 나오는 글자 [보통, 굵게]: · ± × ÷ µ ° é ü Δ Σ Ω α β μ σ – — ‘ ’ “ ” • … ′ ″ − ≈ ≠ ≤ ≥ ℃ (0xA0 = 줄바꿈 없는 공백)
const GLYPH_W = new Map([
  [0xA0, [352, 352]], [0xB7, [219, 262]], [0xB1, [702, 719]], [0xD7, [702, 719]], [0xF7, [702, 719]],
  [0xB5, [590, 619]], [0xB0, [387, 389]], [0xE9, [535, 550]], [0xFC, [579, 609]], [0x394, [658, 704]],
  [0x3A3, [527, 568]], [0x3A9, [774, 783]], [0x3B1, [629, 647]], [0x3B2, [558, 617]], [0x3BC, [590, 628]],
  [0x3C3, [588, 618]], [0x2013, [514, 514]], [0x2014, [1027, 1027]], [0x2018, [141, 193]], [0x2019, [141, 193]],
  [0x201C, [379, 472]], [0x201D, [379, 472]], [0x2022, [418, 418]], [0x2026, [740, 883]], [0x2032, [232, 282]],
  [0x2033, [379, 472]], [0x2212, [748, 733]], [0x2248, [737, 723]], [0x2260, [702, 720]], [0x2264, [702, 720]],
  [0x2265, [702, 720]], [0x2103, [950, 950]],
]);
const WIDE = 1000;      // 한글 · 한자 · 전각 기호 · 화살표 · 도형 기호

/** 글자 하나의 폭(em × 1000) */
function glyphWidth(cp, bold) {
  if (cp >= 0x20 && cp <= 0x7E) return (bold ? ASCII_WB : ASCII_W)[cp - 0x20];
  if (cp < 0x20) return 0;
  const known = GLYPH_W.get(cp);
  if (known) return known[bold ? 1 : 0];
  if (cp >= 0x2200 && cp <= 0x22FF) return 780;             // 수학 기호
  // 한글 · 한자 · 전각 기호 · 화살표, 그리고 재지 않은 기호(※ · 위아래 첨자 …)는 넉넉하게 1em
  if (cp >= 0x2000 || (cp >= 0x1100 && cp <= 0x11FF)) return WIDE;
  return bold ? 740 : 700;                                  // 라틴 확장 · 그리스 · 키릴 문자
}

/** 글의 폭(em): 한 줄로 썼을 때 */
function emWidth(s, bold = false) {
  let n = 0;
  for (const ch of String(s ?? '')) n += glyphWidth(ch.codePointAt(0), bold);
  return n / 1000;
}

/** 한 문단이 폭 per(em)인 줄 몇 개를 차지하는가: 낱말을 차례로 놓고, 들어가지 않으면 다음 줄로 넘긴다 */
function wrapCount(part, per, bold) {
  const space = glyphWidth(0x20, bold) / 1000;
  let lines = 1, used = 0;        // used = 지금 줄에 놓인 폭
  for (const word of part.split(' ')) {
    if (!word) { used += used ? space : 0; continue; }      // 겹친 공백
    const w = emWidth(word, bold);
    const lead = used ? space : 0;
    if (used + lead + w <= per) { used += lead + w; continue; }
    if (w <= per) { lines += 1; used = w; continue; }
    // 한 줄보다 긴 낱말(긴 영문 · 주소): 새 줄에서 시작해 글자 단위로 끊긴다
    if (used) lines += 1;
    used = 0;
    for (const ch of word) {
      const g = glyphWidth(ch.codePointAt(0), bold) / 1000;
      if (used + g > per && used) { lines += 1; used = g; } else used += g;
    }
  }
  return lines;
}

/** 너비 width(인치) 글 영역에 size pt로 쓸 때의 줄 수. wrap = 줄 폭 가운데 쓰는 비율(1이면 여유 없이 잰 그대로) */
function countLines(text, size, width, bold, wrap) {
  const per = Math.max(((width * 72) / size) * wrap, 1.1);
  return String(text ?? '').split('\n').reduce((acc, part) => acc + wrapCount(part, per, bold), 0);
}

/** 자리를 잡을 때 쓰는 줄 수: 줄 폭에 2% 여유를 둔다(프로그램마다 조금씩 다른 반올림 몫) → 실제보다 적게 세는 일이 없다 */
export function textLines(text, size, width, bold = false) {
  return countLines(text, size, width, bold, WRAP);
}

/** 문단 [[글, 크기, 굵게?]]에 필요한 높이(인치, 안쪽 여백 포함). gap = 문단 사이 간격(pt). */
export function textHeight(paras, width, gap = 0, indent = 0) {
  const w = width - 2 * MX - indent;
  const h = paras.reduce((acc, [t, s, b]) => acc + (textLines(t, s, w, b) * s * LINE) / 72, 0);
  return h + (gap * Math.max(paras.length - 1, 0)) / 72 + 2 * MY;
}

/** 가장 큰 글자 크기를 고르고, 가장 작은 크기로도 넘치면 글을 줄인다 → [글, 크기] */
export function fitText(text, width, height, tiers, bold = false) {
  text = String(text ?? '');
  for (const size of tiers) {
    if (textHeight([[text, size, bold]], width) <= height) return [text, size];
  }
  const size = tiers[tiers.length - 1];
  while (text.length > 4 && textHeight([[text, size, bold]], width) > height) {
    const next = clip(text, Math.floor(emLen(text) * 0.85));   // clip의 길이 단위(emLen)로 15%씩 줄인다
    if (next.length >= text.length) break;      // 더 줄지 않으면 멈춘다
    text = next;
  }
  return [text, size];
}

/**
 * 여러 줄이 되는 큰 글(제목 · 질문 · 결론)의 줄 길이를 고르게 한다: 줄 수가 늘지 않는 가장 좁은 상자 너비(인치)를 찾는다.
 * 상자를 그 너비로 그리면 "…근거가 사실상 / 없다."처럼 마지막 줄에 낱말 하나만 남지 않는다. 한 줄짜리 글은 그대로 둔다.
 * 여기서는 여유 없이 잰 줄 수를 쓴다(여유를 두고 세면 한 줄에 들어가는 글을 두 줄로 잘못 나눈다). 여유 2%는 찾은 너비에 더한다.
 */
export function balancedWidth(text, size, width, bold = false) {
  const inner = width - 2 * MX;
  const lines = countLines(text, size, inner, bold, 1);
  if (lines < 2) return width;
  let lo = inner / (lines + 1), hi = inner;
  for (let i = 0; i < 14; i += 1) {          // 이분 탐색: hi는 늘 '줄 수가 그대로인 너비'
    const mid = (lo + hi) / 2;
    if (countLines(text, size, mid, bold, 1) <= lines) hi = mid; else lo = mid;
  }
  return Math.min(width, hi / WRAP + 2 * MX);
}

// 한 줄에 들어가는가(줄바꿈 없이). 큰 숫자 · 칩처럼 한 줄로만 쓰는 글에 쓴다(굵은 글자 기준, 3% 여유)
const oneLine = (text, size, width, bold = true) => (emWidth(text, bold) * 1.03 * size) / 72 <= width - 2 * MX;

// 여러 글에 같은 크기를 쓴다: 모두가 들어가는 가장 큰 단계(없으면 가장 작은 단계)
function commonSize(texts, width, height, tiers, bold = false) {
  return tiers.find((s) => texts.every((t) => textHeight([[t, s, bold]], width) <= height)) ?? tiers[tiers.length - 1];
}

// ---------------------------------------------------------------- 글 · 도형 헬퍼

/** 정수는 천 단위 쉼표, 그 밖의 값은 그대로(null은 0). */
function num(v) {
  if (v === null || v === undefined || v === '') return '0';
  return Number.isInteger(v) ? fmtInt(v) : String(v);
}

// 제어 문자(stripControl, slides.js)를 빼고 한 줄로 (문헌 제목처럼 구성안을 거치지 않은 글에 쓴다)
const safe = (t) => stripControl(t).replace(/\s+/g, ' ').trim();
const pts = (inch) => Math.round(inch * 72 * 100) / 100;
const pct = (n, total) => (total ? Math.round((n / total) * 100) : 0);

/** 본문과 [S#] 인용을 나눈다. 인용은 작고 흐린 글자로. → [[글, 크기, 색, 굵게]] */
function citeRuns(text, size, color = C.INK, bold = false) {
  const out = [];
  let pos = 0;
  for (const m of text.matchAll(citeReGlobal())) {
    if (m.index > pos) out.push([text.slice(pos, m.index), size, color, bold]);
    out.push([m[0], Math.max(size - 4, 11), C.MUTED, false]);
    pos = m.index + m[0].length;
  }
  if (pos < text.length) out.push([text.slice(pos), size, color, bold]);
  return out.length ? out : [[text, size, color, bold]];
}

/** paras(각 항목은 문자열 또는 [[글, 크기, 색, 굵게]] 목록) → pptxgenjs 글 조각 목록 */
function textObjs(paras, { size = 14, color = C.INK, bold = false, align = null, gap = 0, lang = 'ko-KR', spacing = 0 } = {}) {
  const out = [];
  paras.forEach((para, i) => {
    const runs = Array.isArray(para) ? para : [[para, size, color, bold]];
    const last = i === paras.length - 1;
    runs.forEach(([t, s, c, b], j) => {
      const o = { fontFace: FONT, fontSize: s, color: c, bold: !!b, lang };
      if (align) o.align = align;
      if (gap && !last) o.paraSpaceAfter = gap;
      if (spacing) o.charSpacing = spacing;
      if (j === runs.length - 1 && !last) o.breakLine = true;
      out.push({ text: stripControl(t), options: o });
    });
  });
  return out;
}

/** 글상자 공통 옵션 */
function frameOpts({ anchor = 'top', margins = [MX, MY] } = {}) {
  return {
    valign: anchor, wrap: true, fit: 'none',
    // pptxgenjs 글상자 여백 순서: [왼쪽, 오른쪽, 아래, 위] (pt)
    margin: [pts(margins[0]), pts(margins[0]), pts(margins[1]), pts(margins[1])],
  };
}

function shapeOpts(x, y, w, h, fill, { radius = 0, line = null, transparency = 0 } = {}) {
  return {
    x, y, w, h,
    fill: transparency ? { color: fill, transparency } : { color: fill },
    line: line ? { color: line, width: 0.75 } : { type: 'none' },
    ...(radius ? { rectRadius: Math.min(radius, Math.min(w, h) / 2) } : {}),
  };
}

function rect(slide, x, y, w, h, fill, opts = {}) {
  slide.addShape(opts.radius ? 'roundRect' : 'rect', shapeOpts(x, y, w, h, fill, opts));
}

// 장식 원은 일부러 슬라이드 밖으로 걸쳐 둔다. 이름을 'Decoration …'으로 붙여 검사(check_office.py)에서 구분한다
function circle(slide, x, y, d, fill, transparency = 0) {
  const deco = x < 0 || y < 0 || x + d > W || y + d > H;
  slide.addShape('ellipse', { ...shapeOpts(x, y, d, d, fill, { transparency }), ...(deco ? { objectName: 'Decoration circle' } : {}) });
}

function hline(slide, x, y, w, color, width = 0.75) {
  slide.addShape('line', { x, y, w, h: 0, line: { color, width } });
}

// ---------------------------------------------------------------- 차트 데이터

/** 연구 유형: 많은 순으로 최대 7개 + 나머지를 합친 '기타' 한 줄. labels가 있으면 표시 이름으로 바꾼다.
 *  원래 유형이 'other'이거나 비어 있는 것도 '기타'에 합쳐 같은 이름이 두 번 나오지 않게 한다. */
export function studyTypeRows(stats, other, labels = null, max = 7) {
  labels = labels || {};
  const named = [];
  let rest = 0;
  const entries = Object.entries(stats?.by_study_type || {})
    .map(([k, v]) => [String(k), parseInt(v, 10) || 0])
    .sort((a, b) => b[1] - a[1]);
  for (const [k, v] of entries) {
    if (v <= 0) continue;
    if (k === '' || k === 'other' || named.length >= max) rest += v;
    else named.push([labels[k] ?? k, v]);
  }
  return rest ? [...named, [other, rest]] : named;
}

export function yearRows(stats) {
  return Object.entries(stats?.by_year || {}).map(([k, v]) => [String(k), parseInt(v, 10) || 0])
    .filter(([, v]) => v > 0)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** 결과 방향: [키, 개수]. 개수 0은 뺀다. */
export function directionRows(stats) {
  const d = stats?.by_direction || {};
  const keys = [...DIRECTIONS, ...Object.keys(d).filter((k) => !DIRECTIONS.includes(k))];
  return keys.map((k) => [k, parseInt(d[k], 10) || 0]).filter(([, v]) => v > 0);
}

// ---------------------------------------------------------------- 덱

class Deck {
  constructor(result, deck) {
    this.r = result;
    this.d = deck;
    this.lang = result.lang === 'ko' ? 'ko' : 'en';
    this.langTag = this.lang === 'ko' ? 'ko-KR' : 'en-US';
    this.T = TXT[this.lang];
    this.pptx = new PptxGenJS();
    this.pptx.layout = 'LAYOUT_WIDE';          // 13.333 × 7.5 인치
    this.pptx.theme = { headFontFace: FONT, bodyFontFace: FONT };
    this.count = 0;
    this.m = metaInfo(result);
    this.topic = safe(deck.title) || safe(result.topic || result.prompt);
    this.sources = sourcesById(result);
    this.syn = (result.syntheses && typeof result.syntheses === 'object') ? result.syntheses : {};
    const plan = result.plan?.sub_questions;
    this.plan = (Array.isArray(plan) ? plan : []).filter((q) => q && typeof q === 'object' && q.id);
    this.labels = Object.fromEntries(deck.subq_labels.map((x) => [x.id, x.label]));
    this.chartLabelColors = [];               // 차트 순번별 계열 데이터 레이블 색 (나중에 XML에 반영)
  }

  // --- 값 · 이름
  strengthLabel(s) {
    return (this.lang === 'ko' ? theme.STRENGTH_LABEL : STRENGTH_EN)[s] ?? (s || '-');
  }

  verdictLabel(v) {
    return (this.lang === 'ko' ? theme.VERDICT_LABEL : VERDICT_EN)[v] ?? v;
  }

  directionLabel(d) {
    if (this.lang === 'ko') return theme.DIRECTION_LABEL[d] ?? d;
    return { '': 'Unclassified', 'null': 'No effect', 'not applicable': 'N/A' }[d] ?? (d.charAt(0).toUpperCase() + d.slice(1));
  }

  // 하위 질문 id 목록: 구성안의 subq_labels 순서(= 계획 순서)
  subqIds() {
    return this.d.subq_labels.map((x) => x.id);
  }

  strengthOf(qid) {
    const s = this.syn[qid]?.evidence_strength;
    return STRENGTHS.includes(s) ? s : 'insufficient';
  }

  // 하위 질문에 연결된 채택 문헌 수(stats.per_subq). 없으면 종합에 쓴 문헌 수
  sourceCount(qid) {
    const n = parseInt(this.r.stats?.per_subq?.[qid], 10);
    if (Number.isFinite(n)) return n;
    return arr(this.syn[qid]?.sources).length;
  }

  citedCount() {
    const v = this.r.verification?.cited_ids;
    return Number.isInteger(v) ? v : citedIds(this.r.report_markdown).length;
  }

  // --- 글상자
  text(slide, x, y, w, h, paras, opts = {}) {
    slide.addText(textObjs(paras, { lang: this.langTag, ...opts }), { x, y, w, h, ...frameOpts(opts) });
  }

  /** 글 하나를 상자에 맞춰(단계 tiers) 그린다. 고른 글자 크기를 돌려준다. balance = 여러 줄이면 줄 길이를 고르게 */
  fit(slide, x, y, w, h, text, tiers, opts = {}) {
    const [t, size] = fitText(text, w, h, tiers, !!opts.bold);
    const paras = opts.cites ? [citeRuns(t, size, opts.color ?? C.INK, opts.bold)] : [t];
    const bw = opts.balance ? balancedWidth(t, size, w, !!opts.bold) : w;
    this.text(slide, x, y, bw, h, paras, { ...opts, size });
    return size;
  }

  /**
   * 굵은 글 + 보충 글을 글상자 하나에 문단 둘로 쓴다(크기 hs · bs는 호출하는 쪽이 고른다).
   * 두 글을 따로 놓으면 줄 수 셈이 한 줄만 어긋나도 서로 겹치지만, 한 상자 안에서는 PowerPoint가 차례로 이어 놓으므로
   * 겹칠 수 없다. 그래도 높이를 넘치면 보충부터 줄인다(굵은 글에는 보충 한 줄을 남긴 자리까지 준다).
   */
  pair(slide, x, y, w, h, head, body, hs, bs, { gap = 5, cites = false } = {}) {
    const iw = w - 2 * MX, room = h - 2 * MY;
    const tall = (t, size, bold) => (t ? (textLines(t, size, iw, bold) * size * LINE) / 72 : 0);
    let a = String(head ?? ''), b = String(body ?? '');
    const g = a && b ? gap / 72 : 0;
    if (tall(a, hs, true) + g + tall(b, bs, false) > room) {
      if (a) a = fitText(a, w, (b ? room - g - (bs * LINE) / 72 : room) + 2 * MY, [hs], true)[0];
      if (b) b = fitText(b, w, room - g - tall(a, hs, true) + 2 * MY, [bs])[0];
    }
    const paras = [];
    if (a) paras.push([[a, hs, C.INK, true]]);
    if (b) paras.push(cites ? citeRuns(b, bs, C.INK_2) : [[b, bs, C.INK_2, false]]);
    if (paras.length) this.text(slide, x, y, w, h, paras, { gap });
  }

  /** 글이 든 도형(칩 · 배지) */
  chip(slide, x, y, w, h, fill, paras, opts = {}) {
    slide.addText(textObjs(paras, { lang: this.langTag, align: 'center', ...opts }), {
      ...shapeOpts(x, y, w, h, fill, { radius: opts.radius ?? h / 2, line: opts.line }),
      shape: opts.shape || 'roundRect', ...frameOpts({ anchor: 'middle', margins: [0.04, 0.0] }),
    });
  }

  /** 번호 원(①처럼) */
  badge(slide, x, y, d, label, fill, color, size = 14) {
    this.chip(slide, x, y, d, d, fill, [label], { size, color, bold: true, shape: 'ellipse', radius: 0 });
  }

  /** 강도 글자 칸의 너비: 이 언어에서 가장 긴 이름(영어 'Insufficient')이 한 줄에 들어가는 폭 */
  wordWidth(size) {
    const longest = Math.max(...STRENGTHS.map((s) => emWidth(this.strengthLabel(s), true)));
    return (longest * 1.03 * size) / 72 + 2 * MX;
  }

  /** 강도 막대 전체 폭: 막대 네 칸 + 간격 + 글자 칸. 오른쪽에 맞춰 놓을 때 쓴다 */
  meterWidth({ seg = 0.3, size = 12 } = {}) {
    return 4 * seg + 3 * 0.05 + 0.14 + this.wordWidth(size);
  }

  /** 네 칸 강도 막대 + 글자 */
  meter(slide, x, y, strength, { seg = 0.3, h = 0.12, size = 12 } = {}) {
    const st = STRENGTH_STYLE[strength] || STRENGTH_STYLE.insufficient;
    for (let i = 0; i < 4; i += 1) {
      rect(slide, x + i * (seg + 0.05), y, seg, h, i < st.n ? st.bar : C.RULE, { radius: h / 2 });
    }
    const wx = x + 4 * seg + 3 * 0.05 + 0.14;
    this.text(slide, wx, y + h / 2 - 0.16, this.wordWidth(size), 0.32, [this.strengthLabel(strength)],
      { size, color: st.ink, bold: true, anchor: 'middle' });
  }

  // --- 슬라이드 틀
  newSlide(bg = C.WHITE) {
    this.count += 1;
    const s = this.pptx.addSlide();
    s.background = { color: bg };
    return s;
  }

  notes(slide, text) {
    const t = safe(text);
    if (t) slide.addNotes(t);
  }

  footer(s, dark = false) {
    const color = dark ? '8F84B8' : C.MUTED;
    if (!dark) hline(s, ML, FOOT_Y - 0.08, CW, C.RULE);
    const [foot, fs] = fitText(this.topic, CW - 1.2, FOOT_H, [10, 9]);
    this.text(s, ML, FOOT_Y, CW - 1.2, FOOT_H, [foot], { size: fs, color, anchor: 'middle' });
    this.text(s, W - ML - 1.0, FOOT_Y, 1.0, FOOT_H, [String(this.count)], { size: 10, color, align: 'right', anchor: 'middle' });
  }

  /** 흰 바탕 본문 슬라이드: 구역 이름 → 제목(주장, 최대 2줄) → (본문) → 꼬리말. compact = 한 줄 제목(부록) */
  slide(kicker, title, { bg = C.WHITE, compact = false, kickerW = CW } = {}) {
    const s = this.newSlide(bg);
    const [k, ks] = fitText(kicker, kickerW, KICK_H, [12, 11], true);
    this.text(s, ML, KICK_Y, kickerW, KICK_H, [k], { size: ks, color: C.PURPLE, bold: true, anchor: 'middle', spacing: 0.5 });
    if (title) {
      const h = compact ? 0.62 : TITLE_H;
      this.fit(s, ML, TITLE_Y, CW, h, title, compact ? [24, 22, 20] : [30, 28, 26, 24], { color: C.INK, bold: true, balance: true });
    }
    this.footer(s);
    return s;
  }

  /** 어두운 바탕의 반투명 원 두 개와 코랄 점(사이트 첫 화면의 오로라 인상) */
  // small = 글이 넓게 깔리는 슬라이드(기억할 세 가지)용: 원을 오른쪽 끝으로 작게
  aurora(s, small = false) {
    if (small) {
      circle(s, W - 3.3, -1.5, 5.4, C.VIOLET, 55);
      circle(s, W - 2.1, H - 2.9, 3.8, C.MINT, 72);
      circle(s, W - 2.75, H - 3.6, 0.22, C.CORAL);
      circle(s, W - 1.2, 1.0, 0.14, C.LAV);
      return;
    }
    circle(s, W - 5.6, -1.9, 7.4, C.VIOLET, 55);
    circle(s, W - 3.0, H - 3.3, 4.6, C.MINT, 72);
    circle(s, W - 6.3, H - 1.55, 0.26, C.CORAL);
    circle(s, W - 1.55, 1.25, 0.14, C.LAV);
  }

  chart(slide, type, x, y, w, h, cats, series, colors, { reverse = false, max = null } = {}) {
    const data = series.map(([name, vals]) => ({ name: stripControl(name), labels: cats.map(stripControl), values: vals }));
    const top = max ?? Math.max(...series.flatMap(([, v]) => v), 1);
    const opts = {
      x, y, w, h,
      barDir: type === 'col' ? 'col' : 'bar', barGrouping: 'clustered',
      chartColors: colors, showTitle: false, showLegend: false,
      showValue: true, dataLabelFormatCode: '0', dataLabelFontSize: 11, dataLabelFontFace: FONT,
      dataLabelColor: C.INK_2, dataLabelPosition: 'outEnd',
      valAxisHidden: true, valAxisLineShow: false, valGridLine: { style: 'none' }, catGridLine: { style: 'none' },
      valAxisMinVal: 0, valAxisMaxVal: Math.ceil(top * 1.2 * 100) / 100,
      catAxisLabelFontSize: 11, catAxisLabelFontFace: FONT, catAxisLabelColor: C.INK_2,
      catAxisLineShow: true, catAxisLineColor: C.GRAY,
      barGapWidthPct: type === 'col' ? 55 : 45,
    };
    if (reverse) opts.catAxisOrientation = 'maxMin';      // 많은 것이 위로
    slide.addChart('bar', data, opts);
    this.chartLabelColors.push(null);
  }

  doughnut(slide, x, y, w, h, rows) {
    const data = [{ name: this.T.direction, labels: rows.map(([k, v]) => stripControl(`${this.directionLabel(k)} ${v}`)),
      values: rows.map(([, v]) => v) }];
    slide.addChart('doughnut', data, {
      x, y, w, h, holeSize: 58, firstSliceAng: 0,
      chartColors: rows.map(([k]) => DIRECTION_FILL[k] ?? C.GRAY), dataBorder: { pt: 1.5, color: C.WHITE },
      showTitle: false, showValue: false, showPercent: false, showLabel: false, showLeaderLines: false,
      showLegend: true, legendPos: 'r', legendFontSize: 11, legendFontFace: FONT, legendColor: C.INK_2,
    });
    this.chartLabelColors.push(null);
  }

  // ================================================================ 슬라이드

  // --- 1. 표지 (어두움)
  cover() {
    const { T, m, d } = this;
    const s = this.newSlide(C.DEEP);
    this.aurora(s);
    const x = 0.95, w = 8.3;
    this.text(s, x, 1.2, w, 0.36, [T.product], { size: 13, color: C.LAV, bold: true, spacing: 3, anchor: 'middle' });
    this.fit(s, x, 1.7, w, 2.45, d.title || this.topic || T.none, [40, 36, 32], { color: C.WHITE, bold: true, anchor: 'bottom', balance: true });
    rect(s, x + MX, 4.38, 1.1, 0.07, C.LAV);
    if (d.subtitle) this.fit(s, x, 4.62, w, 0.95, d.subtitle, [20, 18, 16], { color: 'DDD3FF', balance: true });
    const parts = [String(m.date).slice(0, 10), m.model, `${T.collected} ${num(m.collected)}${T.unit}`,
      `${T.included} ${num(m.included)}${T.unit}`, `${T.window} ${m.window}`];
    this.fit(s, x, 6.45, 10.5, 0.4, parts.filter(Boolean).join('  ·  '), [12, 11], { color: 'A99DD6', anchor: 'middle' });
    this.notes(s, [d.title, d.subtitle].filter(Boolean).join('. '));
  }

  // --- 2. 오늘의 질문
  question() {
    const { T, d } = this;
    const s = this.slide(T.q_k, '');
    const lw = 6.2, rx = ML + 6.75, rw = CW - 6.75;
    // 왼쪽: 질문을 크게, 세로 가운데
    rect(s, ML, 2.0, 0.09, 3.6, C.PURPLE, { radius: 0.04 });
    this.fit(s, ML + 0.4, 1.4, lw - 0.4, 4.8, d.question || this.topic || T.none, [34, 32, 30, 28, 26],
      { color: C.INK, bold: true, anchor: 'middle', balance: true });
    // 오른쪽: 왜 지금인가(번호 원 + 글) 또는 조사 범위 사실 카드
    const ctx = d.context;
    const label = ctx.length ? T.why_now : T.scope;
    this.text(s, rx, 1.45, rw, 0.34, [label], { size: 12, color: C.MUTED, bold: true, anchor: 'middle' });
    const top = 1.95, bottom = 6.55, gap = 0.22;
    if (ctx.length) {
      const n = ctx.length, ch = Math.min(1.45, (bottom - top - gap * (n - 1)) / n);
      const y0 = top + (bottom - top - (ch * n + gap * (n - 1))) / 2;
      const tw = rw - 1.15;
      const size = commonSize(ctx, tw, ch - 0.2, [17, 16, 15, 14]);
      ctx.forEach((c, i) => {
        const y = y0 + i * (ch + gap);
        rect(s, rx, y, rw, ch, C.TINT, { radius: 0.12 });
        this.badge(s, rx + 0.28, y + ch / 2 - 0.25, 0.5, String(i + 1), C.PURPLE, C.WHITE, 15);
        this.fit(s, rx + 0.98, y + 0.1, tw, ch - 0.2, c, [size], { color: C.INK, anchor: 'middle', cites: true });
      });
    } else {
      const vals = [this.m.window, T.n_src(this.m.included || 0), T.n_q(this.subqIds().length)];
      const n = 3, ch = 1.3, y0 = top + (bottom - top - (ch * n + gap * (n - 1))) / 2;
      vals.forEach((v, i) => {
        const y = y0 + i * (ch + gap);
        rect(s, rx, y, rw, ch, C.TINT, { radius: 0.12 });
        rect(s, rx, y + 0.3, 0.07, ch - 0.6, C.PURPLE);
        this.text(s, rx + 0.35, y + 0.18, rw - 0.6, 0.32, [T.scope_items[i]], { size: 12, color: C.MUTED, bold: true });
        this.fit(s, rx + 0.35, y + 0.5, rw - 0.6, 0.65, String(v), [28, 24, 20], { color: C.PURPLE, bold: true });
      });
    }
    this.notes(s, d.notes.opening || this.defaultNote('opening'));
  }

  // --- 3. 한 문장 결론 (옅은 바탕)
  bottomLine() {
    const { T, d } = this;
    const s = this.slide(T.ans_k, '', { bg: C.TINT });
    const cy = 1.15, ch = 2.95;
    rect(s, ML, cy, CW, ch, C.WHITE, { radius: 0.14 });
    rect(s, ML, cy, 0.12, ch, C.PURPLE);
    this.fit(s, ML + 0.6, cy + 0.3, CW - 1.1, ch - 0.6, d.answer || T.none, [34, 32, 30, 28],
      { color: d.answer ? C.INK : C.MUTED, bold: true, anchor: 'middle', balance: true });
    if (d.answer_caveat) {
      circle(s, ML + 0.12, 4.55, 0.16, C.CORAL);
      this.fit(s, ML + 0.45, 4.35, CW - 0.5, 0.75, d.answer_caveat, [17, 16, 15], { color: C.INK_2, cites: true, balance: true });
    }
    // 맨 아래: 하위 질문마다 칩(id + 강도 글자, 강도 색의 옅은 면)
    const ids = this.subqIds();
    if (ids.length) {
      this.text(s, ML, 5.35, CW, 0.3, [T.strip], { size: 11, color: C.MUTED, bold: true, anchor: 'middle' });
      const rows = ids.length > 8 ? 2 : 1;
      const per = Math.ceil(ids.length / rows);
      const gap = 0.14, cw = Math.min(2.2, (CW - gap * (per - 1)) / per), chh = rows > 1 ? 0.42 : 0.56;
      ids.forEach((id, i) => {
        const st = this.strengthOf(id), sty = STRENGTH_STYLE[st];
        const x = ML + (i % per) * (cw + gap), y = 5.72 + Math.floor(i / per) * (chh + 0.1);
        const size = oneLine(`${id} · ${this.strengthLabel(st)}`, 13, cw) ? 13 : 11;
        this.chip(s, x, y, cw, chh, sty.soft,
          [[[`${id}  `, size, C.INK, true], [this.strengthLabel(st), size, sty.ink, true]]], { radius: 0.1 });
      });
    }
    this.notes(s, d.notes.answer || this.defaultNote('answer'));
  }

  // --- 4. 조사 방법
  method() {
    const { T, m } = this;
    const s = this.slide(T.method_k, T.method_t(num(m.collected), num(m.included)));
    // 8단계 흐름: 번호 원을 선으로 잇고 아래에 이름 · 설명
    this.text(s, ML, TOP - 0.12, CW, 0.3, [T.steps_k], { size: 11, color: C.MUTED, bold: true, anchor: 'middle' });
    const n = T.steps.length, step = CW / n, d0 = 0.5, cy = TOP + 0.28;
    hline(s, ML + step / 2, cy + d0 / 2, CW - step, C.LAV, 1.5);
    T.steps.forEach(([label, desc], i) => {
      const cx = ML + i * step + step / 2;
      this.badge(s, cx - d0 / 2, cy, d0, String(i + 1), i === n - 1 ? C.MINT_DARK : C.PURPLE, C.WHITE, 14);
      this.fit(s, cx - step / 2 + 0.03, cy + 0.6, step - 0.06, 0.34, label, [14, 13, 12], { color: C.INK, bold: true, align: 'center' });
      this.fit(s, cx - step / 2 + 0.03, cy + 0.94, step - 0.06, 0.5, desc, [12, 11], { color: C.MUTED, align: 'center' });
    });
    // 숫자 흐름: 수집 → 중복 병합 → 채택 → 본문 인용
    const fy = 4.45, fh = 1.45;
    this.text(s, ML, fy - 0.42, CW, 0.3, [T.flow_k], { size: 11, color: C.MUTED, bold: true, anchor: 'middle' });
    const vals = [m.collected, m.merged, m.included, this.citedCount()];
    const aw = 0.5, bw = (CW - aw * 3) / 4;
    vals.forEach((v, i) => {
      const x = ML + i * (bw + aw);
      const hi = i === 2;   // 채택 문헌을 강조
      rect(s, x, fy, bw, fh, hi ? C.PURPLE : C.TINT, { radius: 0.14 });
      this.text(s, x, fy + 0.16, bw, 0.78, [num(v)], { size: 40, color: hi ? C.WHITE : C.PURPLE, bold: true, align: 'center', anchor: 'middle' });
      this.fit(s, x + 0.1, fy + 0.94, bw - 0.2, 0.36, T.flow[i], [14, 13, 12], { color: hi ? 'E9E2FF' : C.INK_2, align: 'center', anchor: 'middle' });
      if (i < 3) {
        s.addShape('chevron', shapeOpts(x + bw + aw / 2 - 0.11, fy + fh / 2 - 0.17, 0.22, 0.34, C.GRAY));
      }
    });
    // 한 줄 정보
    const disabled = arr(this.r.meta?.disabled_tools).map(String);
    const parts = [`${T.window} ${m.window}`];
    if (m.model) parts.push(`${T.model} ${m.model}`);
    if (m.minutes) parts.push(`${T.elapsed} ${T.minutes(m.minutes)}`);
    if (m.calls) parts.push(`${T.calls} ${T.n_calls(m.calls)}`);
    if (disabled.length) parts.push(`${T.disabled} ${disabled.join(', ')}`);
    this.fit(s, ML, 6.15, CW, 0.5, parts.join('   ·   '), [13, 12], { color: C.INK_2, anchor: 'middle' });
    this.notes(s, this.defaultNote('method'));
  }

  // --- 5. 근거 지형: 진짜 차트 세 개 + 숫자로 만든 한 줄 설명
  landscape() {
    const { T } = this;
    const stats = this.r.stats || {};
    const s = this.slide(T.ev_k, T.ev_t(num(this.m.included)));
    const labels = this.lang === 'ko' ? theme.STUDY_TYPE_LABEL : STUDY_EN;
    const studies = studyTypeRows(stats, T.other, labels), years = yearRows(stats), dirs = directionRows(stats);
    const cw = (CW - 2 * GAP) / 3, ch = BOTTOM - TOP;
    const cards = [[T.study, studies.length], [T.year, years.length], [T.direction, dirs.length]];
    const caps = [this.captionStudy(studies), this.captionYears(years), this.captionDirection(dirs)];
    cards.forEach(([title, has], i) => {
      const x = ML + i * (cw + GAP);
      rect(s, x, TOP, cw, ch, C.WHITE, { radius: 0.14, line: C.RULE });
      this.text(s, x + PAD, TOP + 0.2, cw - 2 * PAD, 0.36, [title], { size: 15, color: C.INK, bold: true, anchor: 'middle' });
      const gx = x + 0.12, gy = TOP + 0.65, gw = cw - 0.24, gh = ch - 0.65 - 1.0;
      if (!has) {
        this.text(s, gx, gy, gw, gh, [T.none], { size: 14, color: C.MUTED, align: 'center', anchor: 'middle' });
      } else if (i === 0) {
        this.chart(s, 'bar', gx, gy, gw, gh, studies.map(([k]) => k), [[T.included, studies.map(([, v]) => v)]], [C.VIOLET],
          { reverse: true });
      } else if (i === 1) {
        this.chart(s, 'col', gx, gy, gw, gh, years.map(([k]) => k), [[T.included, years.map(([, v]) => v)]], [C.VIOLET]);
      } else {
        this.doughnut(s, gx, gy, gw, gh, dirs);
      }
      // 아래 한 줄 설명(숫자로 만든 것). 자료가 없으면 비워 둔다
      if (caps[i]) {
        hline(s, x + PAD, TOP + ch - 0.95, cw - 2 * PAD, C.RULE);
        this.fit(s, x + PAD, TOP + ch - 0.88, cw - 2 * PAD, 0.72, caps[i], [13, 12], { color: C.INK_2, anchor: 'middle' });
      }
    });
    this.notes(s, this.d.notes.landscape || this.defaultNote('landscape'));
  }

  captionStudy(rows) {
    const named = rows.filter(([k]) => k !== this.T.other);
    if (!named.length) return '';
    const total = rows.reduce((a, [, v]) => a + v, 0);
    const [name, n] = named[0];
    return this.T.cap_type(name, n, pct(n, total));
  }

  captionYears(rows) {
    if (!rows.length) return '';
    if (rows.length === 1) return this.T.cap_year1(rows[0][0]);
    const total = rows.reduce((a, [, v]) => a + v, 0);
    const last = rows.slice(-2);
    return this.T.cap_years(last[0][0], last[1][0], pct(last[0][1] + last[1][1], total));
  }

  captionDirection(rows) {
    const keys = ['positive', 'negative', 'mixed', 'null'];
    const parts = rows.filter(([k]) => keys.includes(k)).map(([k, v]) => [this.directionLabel(k), v]);
    return parts.length ? this.T.cap_dir(parts) : '';
  }

  // --- 6…. 핵심 메시지: 제목 = 주장, 근거 카드 2~3개, 아래 띠에 요지
  message(msg, i, k) {
    const { T } = this;
    // 오른쪽 위 근거 강도: 막대를 오른쪽 여백에 맞추고, 구역 이름은 그 왼쪽까지만 쓴다
    const mw = this.meterWidth();
    const mx = W - ML - mw;
    const s = this.slide(T.msg_k(i + 1, k), msg.headline || T.none, { kickerW: CW - mw - 1.2 });
    this.text(s, mx - 1.05, KICK_Y, 0.95, KICK_H, [T.strength], { size: 11, color: C.MUTED, bold: true, align: 'right', anchor: 'middle' });
    this.meter(s, mx, KICK_Y + KICK_H / 2 - 0.06, msg.strength);

    const points = msg.points;
    const band = Boolean(msg.takeaway);
    const tw = CW - 1.75;
    const bandH = textHeight([[msg.takeaway, 17, true]], tw) <= 0.4 ? 0.72 : 0.9, bandY = BOTTOM - bandH;
    const ch = (band ? bandY - 0.24 : BOTTOM) - TOP;
    if (points.length) this.pointCards(s, points, ch);
    if (band) {
      rect(s, ML, bandY, CW, bandH, C.TINT_2, { radius: 0.12 });
      rect(s, ML, bandY, 0.1, bandH, C.PURPLE);
      this.text(s, ML + 0.35, bandY, 1.1, bandH, [T.so], { size: 12, color: C.PURPLE, bold: true, anchor: 'middle' });
      this.fit(s, ML + 1.45, bandY + 0.06, tw, bandH - 0.12, msg.takeaway, [17, 16, 15, 14],
        { color: C.INK, bold: true, anchor: 'middle', cites: true, balance: true });
    }
    this.notes(s, msg.notes || this.messageNote(msg));
  }

  /**
   * 근거 카드 한 줄: 같은 높이, 같은 글자 크기. 큰 숫자가 없는 카드는 번호 배지로 균형을 맞춘다.
   * 배치는 두 가지: 넉넉하게(큰 숫자, 출처 두 줄) → 촘촘하게(작은 숫자, 출처 한 줄). 글을 줄이지 않고 들어가는 첫 배치를 쓴다.
   */
  pointCards(s, points, ch) {
    const n = points.length;
    const cw = (CW - GAP * (n - 1)) / n, iw = cw - 2 * PAD;
    const figs = points.map((p) => p.figure).filter(Boolean);
    const pgap = 5;       // 주장과 보충 사이(pt)
    const body = (p, a, b) => [...(p.text ? [[p.text, a, true]] : []), ...(p.detail ? [[p.detail, b, false]] : [])];
    const plan = (figMax, srcMax) => {
      // 큰 숫자: 모두 한 줄에 들어가는 가장 큰 크기(카드끼리 같은 크기). 숫자 칸 높이는 그 크기에 맞춘다
      const figSize = [44, 40, 36, 32, 28, 24, 20].find((sz) => sz <= figMax && figs.every((f) => oneLine(f, sz, iw))) ?? 20;
      const figH = figs.length ? Math.max(0.62, (figSize * 1.25) / 72 + 0.1) : 0.56;
      const src = points.map((p) => this.sourceLines(p.sids, srcMax, iw));
      const srcH = src.some((l) => l.length > 1) ? 0.42 : (src.some((l) => l.length) ? 0.24 : 0);
      const mid = ch - 2 * PAD - figH - 0.12 - (srcH ? srcH + 0.12 : 0);
      // 주장(굵게)과 보충을 한 글상자에 이어 쓴다: 모든 카드에 들어가는 가장 큰 글자 크기 조합
      const need = (a, b) => Math.max(...points.map((p) => textHeight(body(p, a, b), iw, pgap)));
      let sizes = null;
      for (const a of [18, 17, 16, 15, 14]) {
        for (const b of [13, 12]) {
          if (!sizes && need(a, b) <= mid) sizes = [a, b];
        }
      }
      return { figSize, figH, src, srcH, mid, sizes };
    };
    let L = plan(44, 2);
    if (!L.sizes) L = plan(28, 1);
    const [ts, ds] = L.sizes ?? [14, 12];      // 그래도 넘치면 가장 작은 크기로 쓰고 pair()가 보충부터 줄인다
    points.forEach((p, j) => {
      const x = ML + j * (cw + GAP);
      rect(s, x, TOP, cw, ch, C.WHITE, { radius: 0.14, line: C.RULE });
      rect(s, x + PAD, TOP, 0.9, 0.06, C.PURPLE);
      const y = TOP + PAD;
      if (p.figure) {
        // 한 줄에 들어가는 크기를 이미 골랐으므로 줄이지 않고 그린다(잘린 숫자는 틀린 숫자다)
        this.text(s, x + PAD, y, iw, L.figH, [p.figure], { size: L.figSize, color: C.PURPLE, bold: true, anchor: 'middle' });
      } else {
        this.badge(s, x + PAD + MX, y + (L.figH - 0.52) / 2, 0.52, String(j + 1).padStart(2, '0'), C.TINT_2, C.PURPLE, 13);
      }
      this.pair(s, x + PAD, y + L.figH + 0.12, iw, L.mid, p.text, p.detail, ts, ds, { gap: pgap });
      if (L.src[j].length) {
        const sy = TOP + ch - PAD - L.srcH;
        hline(s, x + PAD, sy - 0.07, iw, C.RULE);
        this.text(s, x + PAD, sy, iw, L.srcH, L.src[j], { size: 11, color: C.MUTED, anchor: 'bottom' });
      }
    });
  }

  /**
   * 짧은 문헌 표기('Pensky et al. (2025)')를 뒤에 붙는 글(tail)과 함께 폭 width(인치)에 한 줄로 들어가게 줄인다.
   * 저자가 없는 문헌은 표기에 학술지 · 사이트 이름이 들어와 길어진다. 연도는 남기고 이름만 줄인다(끝에 '…').
   */
  citeFit(sid, tail, size, width, bold = false) {
    const cite = safe(shortCite(this.sources[sid] || {}));
    const m = /^(.*\S)(\s\([^()]*\))$/.exec(cite);
    let name = m ? m[1] : cite;
    const year = m ? m[2] : '';
    while (name.length > 4 && !oneLine(name + year + tail, size, width, bold)) {
      const next = clip(name, Math.floor(emLen(name) * 0.85));
      if (next.length >= name.length) break;      // 더 줄지 않으면 멈춘다
      name = next;
    }
    return name + year;
  }

  /** 출처 줄: 'Pensky et al. (2025) · S15'. max개까지 한 줄씩(폭 width에 맞춰), 나머지는 '외 n건' */
  sourceLines(sids, max, width) {
    const shown = sids.slice(0, max);
    return shown.map((sid, i) => {
      const more = i === shown.length - 1 && sids.length > max ? this.T.more(sids.length - max) : '';
      const tail = ` · ${sid}${more}`;
      return this.citeFit(sid, tail, 11, width) + tail;
    });
  }

  // --- 근거의 단단함: 하위 질문마다 한 줄
  strength() {
    const { T } = this;
    const ids = this.subqIds();
    if (!ids.length) return;
    const weak = ids.filter((q) => ['weak', 'insufficient'].includes(this.strengthOf(q))).length;
    const s = this.slide(T.st_k, T.st_t(ids.length, weak));
    const rows = ids.slice(0, 8);
    const hy = TOP - 0.05, top = TOP + 0.32;
    const rh = Math.min(0.62, (BOTTOM - top) / rows.length);
    const cntX = W - ML - 1.25, meterX = cntX - this.meterWidth({ seg: 0.36, size: 13 }) - 0.1;
    const lx = ML + 1.05, lw = meterX - lx - 0.3;
    this.text(s, ML + 0.15, hy, 3, 0.3, [T.st_cols[0]], { size: 11, color: C.MUTED, bold: true, anchor: 'middle' });
    this.text(s, meterX, hy, 2.5, 0.3, [T.st_cols[1]], { size: 11, color: C.MUTED, bold: true, anchor: 'middle' });
    this.text(s, cntX, hy, 1.1, 0.3, [T.st_cols[2]], { size: 11, color: C.MUTED, bold: true, align: 'right', anchor: 'middle' });
    const names = rows.map((q) => this.labels[q] || q);
    const size = commonSize(names, lw, rh - 0.06, [16, 15, 14, 13]);
    rows.forEach((q, i) => {
      const y = top + i * rh;
      if (i % 2 === 0) rect(s, ML, y, CW, rh, C.TINT);
      this.chip(s, ML + 0.15, y + rh / 2 - 0.17, 0.72, 0.34, C.WHITE, [q], { size: 12, color: C.PURPLE, bold: true, line: C.RULE });
      this.fit(s, lx, y + 0.03, lw, rh - 0.06, names[i], [size], { color: C.INK, anchor: 'middle' });
      this.meter(s, meterX, y + rh / 2 - 0.07, this.strengthOf(q), { seg: 0.36, h: 0.14, size: 13 });
      this.text(s, cntX, y, 1.1, rh, [T.n_src(this.sourceCount(q))], { size: 14, color: C.INK_2, align: 'right', anchor: 'middle' });
    });
    if (ids.length > rows.length) {
      this.text(s, ML, BOTTOM - 0.02, CW, 0.26, [T.st_more(ids.length - rows.length)], { size: 11, color: C.MUTED });
    }
    this.notes(s, this.d.notes.strength || this.defaultNote('strength'));
  }

  // --- 일치와 상충
  tension() {
    const { T, d } = this;
    if (!d.agree.length && !d.conflict.length) return;
    const s = this.slide(T.ten_k, T.ten_t);
    const band = Boolean(d.conflict_why);
    const bandH = 0.9, bandY = BOTTOM - bandH;
    const ch = (band ? bandY - 0.24 : BOTTOM) - TOP;
    const cw = (CW - GAP) / 2;
    const iw = cw - 2 * PAD - 0.36, ih = ch - 0.62 - 0.2 - 0.12;
    const lists = [[T.agree, d.agree, C.MINT_DARK, C.MINT_SOFT, C.MINT], [T.conflict, d.conflict, C.CORAL_DARK, C.CORAL_SOFT, C.CORAL]];
    // 두 칸에 같은 글자 크기: 항목 높이의 합 + 간격이 들어가는 가장 큰 단계
    const fits = (sz) => lists.every(([, items]) => items.reduce((a, t) => a + textHeight([[t, sz]], iw), 0)
      + 0.2 * Math.max(items.length - 1, 0) <= ih);
    const size = [17, 16, 15, 14, 13].find(fits) ?? 13;
    lists.forEach(([label, items, ink, soft, dot], j) => {
      const x = ML + j * (cw + GAP);
      rect(s, x, TOP, cw, ch, C.WHITE, { radius: 0.14, line: C.RULE });
      rect(s, x, TOP, cw, 0.62, soft, { radius: 0.14 });
      rect(s, x, TOP + 0.4, cw, 0.22, soft);     // 머리 띠의 아래쪽 모서리는 각지게
      this.text(s, x + PAD, TOP, cw - 2 * PAD, 0.62, [label], { size: 16, color: ink, bold: true, anchor: 'middle' });
      if (!items.length) {
        this.text(s, x + PAD, TOP + 0.82, cw - 2 * PAD, 0.4, [T.none], { size: 14, color: C.MUTED });
        return;
      }
      let y = TOP + 0.62 + 0.22;
      // 가장 작은 단계로도 넘치면 항목마다 같은 높이를 나눠 주고 그 안으로 줄인다(마지막 수단)
      const room = fits(size) ? ih : (ih - 0.2 * (items.length - 1)) / items.length;
      items.forEach((t) => {
        const h = Math.min(textHeight([[t, size]], iw), room);
        circle(s, x + PAD + 0.02, y + (size * LINE) / 144 - 0.05, 0.13, dot);
        this.fit(s, x + PAD + 0.36, y, iw, h, t, [size], { color: C.INK, cites: true });
        y += h + 0.2;
      });
    });
    if (band) {
      rect(s, ML, bandY, CW, bandH, C.CORAL_SOFT, { radius: 0.12 });
      rect(s, ML, bandY, 0.1, bandH, C.CORAL);
      this.text(s, ML + 0.35, bandY, 1.45, bandH, [T.why], { size: 12, color: C.CORAL_DARK, bold: true, anchor: 'middle' });
      this.fit(s, ML + 1.8, bandY + 0.06, CW - 2.1, bandH - 0.12, d.conflict_why, [16, 15, 14, 13],
        { color: C.INK, anchor: 'middle', cites: true, balance: true });
    }
    this.notes(s, d.notes.tension || this.defaultNote('tension'));
  }

  // --- 연구 공백: 번호 카드(2개 → 1줄, 3개 → 3칸, 4개 → 2×2)
  gaps() {
    const { T, d } = this;
    const items = d.gaps;
    if (!items.length) return;
    const s = this.slide(T.gaps_k, T.gaps_t(items.length));
    const cols = items.length === 4 ? 2 : items.length, rows = items.length === 4 ? 2 : 1;
    const gy = 0.26;
    // 넓은 카드(2칸 이하)는 번호를 왼쪽에, 좁은 카드(3칸)는 번호를 위에 둔다
    const side = cols <= 2;
    const cw = (CW - GAP * (cols - 1)) / cols, iw = cw - 2 * PAD - (side ? 0.85 : 0), numH = side ? 0 : 0.6;
    let ch = (BOTTOM - TOP - gy * (rows - 1)) / rows;
    const inner = () => ch - 2 * PAD - numH;
    // 제목(굵게)과 이유: 모든 카드에 들어가는 가장 큰 조합
    const pgap = 7;
    const need = (a, b) => Math.max(...items.map((g) => textHeight([[g.gap, a, true], ...(g.why ? [[g.why, b, false]] : [])], iw, pgap)));
    let gs = 16, ws = 13;
    outer: for (const a of [20, 19, 18, 17, 16]) {
      for (const b of [15, 14, 13]) {
        if (need(a, b) <= inner()) { gs = a; ws = b; break outer; }
      }
    }
    // 한 줄뿐이면 카드 높이를 글에 맞춘다(키 큰 빈 카드가 되지 않게)
    if (rows === 1) ch = Math.min(ch, Math.max(2.4, need(gs, ws) + 2 * PAD + numH + 0.3));
    items.forEach((g, i) => {
      const x = ML + (i % cols) * (cw + GAP), y = TOP + Math.floor(i / cols) * (ch + gy);
      rect(s, x, y, cw, ch, C.TINT, { radius: 0.14 });
      rect(s, x + PAD, y, 0.6, 0.06, C.PURPLE);
      this.text(s, x + PAD, y + PAD - 0.04, 0.8, 0.5, [String(i + 1).padStart(2, '0')], { size: 22, color: C.PURPLE, bold: true });
      const tx = x + PAD + (side ? 0.85 : 0), ty = y + PAD + numH;
      this.pair(s, tx, ty, iw, inner(), g.gap, g.why, gs, ws, { gap: pgap, cites: true });
    });
    this.notes(s, d.notes.gaps || this.defaultNote('gaps'));
  }

  // --- 다음 연구 제안: 연구마다 가로 카드 한 장(번호 · 제목 | 설계 | 표본 | 기대 기여)
  nextStudies() {
    const { T, d } = this;
    const items = d.next_studies;
    if (!items.length) return;
    const s = this.slide(T.next_k, T.next_t(items.length));
    // 연구마다 가로 카드 한 장: 번호 · 제목 | 설계 | 표본 | 기대 기여. 칸 이름은 맨 위에 한 번만 쓴다
    const n = items.length, gy = 0.2, hy = TOP - 0.05, top = TOP + 0.32;
    const rh = Math.min(1.5, (BOTTOM - top - gy * (n - 1)) / n);
    const tx = ML + PAD + 0.66, tw = 2.7, fx = tx + tw + 0.35;
    const fw = (W - ML - PAD - fx - 0.3 * 2) / 3;
    const inner = rh - 0.3;
    const ts = commonSize(items.map((st) => st.title), tw, inner, [19, 18, 17, 16, 15], true);
    const fsz = commonSize(items.flatMap((st) => T.fields.map(([key]) => st[key]).filter(Boolean)), fw, inner, [15, 14, 13, 12]);
    T.fields.forEach(([, label], j) => {
      this.text(s, fx + j * (fw + 0.3), hy, fw, 0.3, [label], { size: 11, color: C.PURPLE, bold: true, anchor: 'middle' });
    });
    items.forEach((st, i) => {
      const y = top + i * (rh + gy);
      rect(s, ML, y, CW, rh, i % 2 ? C.WHITE : C.TINT, { radius: 0.12, line: i % 2 ? C.RULE : null });
      this.badge(s, ML + PAD, y + 0.16, 0.46, String(i + 1), C.PURPLE, C.WHITE, 14);
      this.fit(s, tx, y + 0.15, tw, inner, st.title, [ts], { color: C.INK, bold: true });
      T.fields.forEach(([key], j) => {
        if (st[key]) this.fit(s, fx + j * (fw + 0.3), y + 0.15, fw, inner, st[key], [fsz], { color: C.INK_2, cites: true });
      });
    });
    this.notes(s, d.notes.next || this.defaultNote('next'));
  }

  // --- 주의할 점 + 인용 검증
  cautions() {
    const { T, d } = this;
    const s = this.slide(T.caut_k, T.caut_t);
    const lw = 6.95, px = ML + lw + 0.45, pw = CW - lw - 0.45, ch = BOTTOM - TOP;
    const items = d.cautions;
    if (!items.length) {
      this.text(s, ML, TOP, lw, 0.5, [T.no_caut], { size: 16, color: C.MUTED });
    } else {
      const iw = lw - 0.75, gap = 0.26;
      const total = (sz) => items.reduce((a, t) => a + Math.max(textHeight([[t, sz]], iw), 0.5), 0) + gap * (items.length - 1);
      const size = [18, 17, 16, 15, 14].find((sz) => total(sz) <= ch) ?? 14;
      let y = TOP;
      // 가장 작은 단계로도 넘치면 항목마다 같은 높이를 나눠 준다(마지막 수단)
      const room = total(size) <= ch ? ch : (ch - gap * (items.length - 1)) / items.length;
      items.forEach((t, i) => {
        const h = Math.min(Math.max(textHeight([[t, size]], iw), 0.5), room);
        this.badge(s, ML, y + 0.02, 0.44, String(i + 1), C.CORAL_SOFT, C.CORAL_DARK, 13);
        this.fit(s, ML + 0.7, y, iw, h, t, [size], { color: C.INK, cites: true });
        y += h + gap;
      });
    }
    this.checkPanel(s, px, pw, ch);
    this.notes(s, d.notes.cautions || this.defaultNote('cautions'));
  }

  checkPanel(s, x, w, ch) {
    const { T } = this;
    const v = this.r.verification || {};
    const checks = arr(v.checks).filter((c) => c && typeof c === 'object');
    rect(s, x, TOP, w, ch, C.TINT, { radius: 0.14 });
    const ix = x + PAD, iw = w - 2 * PAD;
    this.text(s, ix, TOP + 0.18, iw, 0.38, [T.check], { size: 16, color: C.INK, bold: true, anchor: 'middle' });
    if (!checks.length && !v.cited_ids) {
      this.text(s, ix, TOP + 0.7, iw, 0.5, [T.no_check], { size: 14, color: C.MUTED });
      return;
    }
    const revised = checks.filter((c) => c.revised).length;
    const figs = [v.cited_ids || 0, checks.length, revised];
    const fw = iw / 3;
    T.check_figs.forEach((label, i) => {
      this.text(s, ix + i * fw, TOP + 0.66, fw, 0.6, [num(figs[i])], { size: 28, color: C.PURPLE, bold: true });
      this.fit(s, ix + i * fw, TOP + 1.24, fw - 0.08, 0.48, label, [12, 11], { color: C.INK_2 });
    });
    // 판정 수정 전 → 후 (작은 표)
    const before = verdictTally(checks), after = verdictTally(checks, true);
    const y0 = TOP + 1.95, cols = [iw - 1.7, 0.85, 0.85];
    const hx = [ix, ix + cols[0], ix + cols[0] + cols[1]];
    [T.verdict, T.before, T.after].forEach((label, j) => {
      this.text(s, hx[j], y0, cols[j], 0.3, [label], { size: 11, color: C.MUTED, bold: true, align: j ? 'right' : 'left', anchor: 'middle' });
    });
    hline(s, ix, y0 + 0.36, iw, C.GRAY);
    const rh = Math.min(0.5, (TOP + ch - 0.2 - (y0 + 0.44)) / VERDICTS.length);
    VERDICTS.forEach((key, i) => {
      const ry = y0 + 0.44 + i * rh;
      rect(s, hx[0], ry + rh / 2 - 0.07, 0.14, 0.14, VERDICT_FILL[key], { radius: 0.03 });
      this.fit(s, hx[0] + 0.24, ry, cols[0] - 0.24, rh, this.verdictLabel(key), [14, 13, 12], { color: C.INK, anchor: 'middle' });
      this.text(s, hx[1], ry, cols[1], rh, [String(before[key])], { size: 14, color: C.MUTED, align: 'right', anchor: 'middle' });
      this.text(s, hx[2], ry, cols[2], rh, [String(after[key])], { size: 14, color: C.INK, bold: true, align: 'right', anchor: 'middle' });
    });
  }

  // --- 기억할 세 가지 (어두움)
  takeaways() {
    const { T, d } = this;
    // 구성안에 없으면 메시지 제목을 쓴다(새 내용을 지어내지 않는다)
    const items = (d.takeaways.length ? d.takeaways : d.messages.map((m) => m.headline).filter(Boolean)).slice(0, 3);
    if (!items.length) return;
    const s = this.newSlide(C.DEEP);
    this.aurora(s, true);
    this.text(s, ML, KICK_Y, 6, KICK_H, [T.take_k], { size: 12, color: C.LAV, bold: true, anchor: 'middle', spacing: 0.5 });
    const x = ML, w = 9.1, top = 1.25, bottom = d.closing ? 5.75 : 6.5;
    const rh = (bottom - top) / items.length;
    const size = commonSize(items, w - 1.3, rh - 0.3, [26, 25, 24, 22, 20], true);
    items.forEach((t, i) => {
      const y = top + i * rh;
      if (i) hline(s, x, y, w, C.DEEP_2, 1);
      this.text(s, x, y + 0.12, 1.1, rh - 0.24, [String(i + 1).padStart(2, '0')], { size: 30, color: C.LAV, bold: true, anchor: 'middle' });
      this.fit(s, x + 1.3, y + 0.12, w - 1.3, rh - 0.24, t, [size], { color: C.WHITE, bold: true, anchor: 'middle', balance: true });
    });
    if (d.closing) {
      rect(s, x + MX, 6.05, 0.5, 0.05, C.CORAL);
      this.fit(s, x, 6.2, w, 0.6, d.closing, [17, 16, 15], { color: 'DDD3FF', anchor: 'top', balance: true });
    }
    this.footer(s, true);
    this.notes(s, d.notes.closing || this.defaultNote('closing'));
  }

  // --- Q & A (어두움)
  qa() {
    const { T, m, d } = this;
    const s = this.newSlide(C.DEEP);
    this.aurora(s);
    this.text(s, ML + 0.2, 2.2, 8.5, 1.5, [T.qa], { size: 60, color: C.WHITE, bold: true, anchor: 'bottom' });
    rect(s, ML + 0.25, 3.95, 1.1, 0.07, C.LAV);
    this.fit(s, ML + 0.2, 4.25, 8.2, 0.9, T.qa_sub(num(m.collected), num(m.included)), [17, 16, 15], { color: 'DDD3FF', balance: true });
    this.fit(s, ML + 0.2, 5.3, 8.2, 0.4, T.plan_src[d.source] || T.plan_src.rules, [12, 11], { color: 'A99DD6' });
    this.footer(s, true);
    this.notes(s, this.defaultNote('qa'));
  }

  // --- 부록 표지 (옅은 바탕)
  appendixCover() {
    const { T } = this;
    const s = this.newSlide(C.TINT);
    this.text(s, ML, 1.7, 5, 1.0, [T.app_t], { size: 44, color: C.PURPLE, bold: true, anchor: 'bottom' });
    rect(s, ML + MX, 2.9, 1.0, 0.07, C.PURPLE);
    T.app_items.forEach(([letter, name, desc], i) => {
      const y = 3.35 + i * 0.95;
      this.badge(s, ML, y, 0.56, letter, C.WHITE, C.PURPLE, 16);
      this.text(s, ML + 0.8, y - 0.06, 8, 0.38, [name], { size: 18, color: C.INK, bold: true, anchor: 'middle' });
      this.text(s, ML + 0.8, y + 0.32, 8, 0.32, [desc], { size: 13, color: C.INK_2, anchor: 'middle' });
    });
    this.footer(s);
    this.notes(s, this.defaultNote('appendix'));
  }

  /** 부록용 행 나누기: 행 높이(인치) 목록을 height 안으로 묶는다 → [[시작, 끝)].
   *  먼저 채워 넣기로 쪽수를 정하고, 같은 쪽수로 행 수를 고르게 나눠도 들어가면 그쪽을 쓴다(마지막 쪽에 한두 줄만 남지 않게) */
  static pages(heights, height) {
    const greedy = [];
    let start = 0, used = 0;
    heights.forEach((h, i) => {
      if (i > start && used + h > height) {
        greedy.push([start, i]);
        start = i;
        used = 0;
      }
      used += h;
    });
    if (heights.length) greedy.push([start, heights.length]);
    const k = greedy.length, per = Math.ceil(heights.length / Math.max(k, 1));
    const even = [];
    for (let a = 0; a < heights.length; a += per) even.push([a, Math.min(a + per, heights.length)]);
    const fits = even.length === k && even.every(([a, b]) => heights.slice(a, b).reduce((x, y) => x + y, 0) <= height);
    return fits ? even : greedy;
  }

  // --- 부록 A. 하위 질문: id · 짧은 이름 · 근거 강도, 그 아래에 원래 질문
  appendixSubq() {
    const { T } = this;
    const ids = this.subqIds();
    if (!ids.length) return;
    const byId = Object.fromEntries(this.plan.map((q) => [q.id, q]));
    // 첫 줄: id 칩 | 짧은 이름(굵게) | 강도 막대.  그 아래: 원래 질문(작게, 가로 전체를 써서 줄이지 않고 보여 준다. 최대 5줄)
    const lx = ML + 1.0, mx = W - ML - this.meterWidth({ seg: 0.26, size: 12 }), lw = mx - lx - 0.3, qw = W - ML - lx - 0.2;
    const qs = 11, pad = 0.13;
    const rows = ids.map((q) => {
      const [label, ls] = fitText(this.labels[q] || q, lw, 0.66, [15, 14], true);
      const lh = Math.max(0.34, textHeight([[label, ls, true]], lw));
      const question = safe(byId[q]?.question);
      // 이름이 곧 질문이면 한 번만 쓴다
      const qText = question && question !== label ? fitText(question, qw, (5 * qs * LINE) / 72 + 2 * MY, [qs])[0] : '';
      const qh = qText ? textHeight([[qText, qs]], qw) : 0;
      return { q, label, ls, lh, qText, qh, h: pad + lh + qh + pad };
    });
    const pages = Deck.pages(rows.map((r) => r.h), BOTTOM - TOP_C);
    pages.forEach(([a, b], p) => {
      const s = this.slide(T.app_k, `A · ${T.appA_t}${pages.length > 1 ? T.page(p + 1, pages.length) : ''}`, { compact: true });
      let y = TOP_C;
      rows.slice(a, b).forEach((r, i) => {
        if (i % 2 === 0) rect(s, ML, y, CW, r.h, C.TINT);
        const mid = y + pad + r.lh / 2;      // 첫 줄의 세로 가운데
        this.chip(s, ML + 0.15, mid - 0.16, 0.66, 0.32, C.WHITE, [r.q], { size: 12, color: C.PURPLE, bold: true, line: C.RULE });
        this.text(s, lx, y + pad, lw, r.lh, [r.label], { size: r.ls, color: C.INK, bold: true, anchor: 'middle' });
        this.meter(s, mx, mid - 0.06, this.strengthOf(r.q), { seg: 0.26, h: 0.12, size: 12 });
        if (r.qText) this.text(s, lx, y + pad + r.lh, qw, r.qh, [r.qText], { size: qs, color: C.MUTED });
        y += r.h;
      });
      this.notes(s, this.defaultNote('appendix_a'));
    });
  }

  // --- 부록 B. 필독 문헌: 순위 · 짧은 표기와 제목 · 읽을 이유
  appendixMust() {
    const { T, d } = this;
    const items = d.must_read;
    if (!items.length) return;
    const s = this.slide(T.app_k, `B · ${T.appB_t}`, { compact: true });
    const cx = ML + 0.9, cwid = 5.6, wx = cx + cwid + 0.35, ww = W - ML - wx;
    const rh = Math.min(1.0, (BOTTOM - TOP_C) / items.length);
    items.forEach((it, i) => {
      const y = TOP_C + i * rh;
      const src = this.sources[it.sid] || {};
      if (i) hline(s, ML, y, CW, C.RULE);
      this.text(s, ML, y + 0.08, 0.75, rh - 0.16, [String(i + 1)], { size: 26, color: C.PURPLE, bold: true, anchor: 'middle' });
      this.text(s, cx, y + 0.1, cwid, 0.32, [[[`${this.citeFit(it.sid, `  ${it.sid}`, 14, cwid, true)}  `, 14, C.INK, true], [it.sid, 12, C.MUTED, false]]],
        { anchor: 'middle' });
      const title = safe(src.title);
      if (title) this.fit(s, cx, y + 0.42, cwid, rh - 0.5, title, [12, 11], { color: C.INK_2 });
      this.fit(s, wx, y + 0.08, ww, rh - 0.16, it.why || '', [15, 14, 13], { color: C.INK, anchor: 'middle', cites: true });
    });
    this.notes(s, this.defaultNote('appendix_b'));
  }

  // --- 부록 C. 참고문헌: 슬라이드와 노트에 인용한 문헌 전체(여러 장 가능)
  references() {
    const { T } = this;
    const ids = this.citedOnSlides();
    if (!ids.length) return;
    const entries = ids.map((sid) => {
      const src = this.sources[sid];
      const body = safe(`${authorsText(src) || src.venue || 'n.a.'} (${src.year || 'n.d.'}). ${src.title || ''}. ${src.venue || ''}`);
      return [sid, clip(body.replace(/[. ]+$/, '') + '.', 150)];
    });
    const size = 12, iw = CW - 0.75;
    const heights = entries.map(([, t]) => textHeight([[t, size]], iw) + 0.1);
    const pages = Deck.pages(heights, BOTTOM - TOP_C);
    pages.forEach(([a, b], p) => {
      const s = this.slide(T.app_k, `C · ${T.appC_t}${pages.length > 1 ? T.page(p + 1, pages.length) : ''}`, { compact: true });
      let y = TOP_C;
      entries.slice(a, b).forEach(([sid, t], i) => {
        const h = heights[a + i];
        this.text(s, ML, y, 0.7, 0.3, [sid], { size: 11, color: C.PURPLE, bold: true });
        this.text(s, ML + 0.75, y, iw, h - 0.1, [t], { size, color: C.INK });
        y += h;
      });
      this.notes(s, this.defaultNote('appendix_c'));
    });
  }

  // 슬라이드 · 노트에 인용한 문헌 id(S 번호순)
  citedOnSlides() {
    const d = this.d;
    const texts = [d.answer, d.answer_caveat, ...d.context, ...d.agree, ...d.conflict, d.conflict_why, ...d.cautions,
      ...d.takeaways, d.closing, ...Object.values(d.notes)];
    for (const g of d.gaps) texts.push(g.gap, g.why);
    for (const st of d.next_studies) texts.push(...Object.values(st));
    for (const m of d.messages) {
      texts.push(m.headline, m.takeaway, m.notes);
      for (const p of m.points) texts.push(p.text, p.detail, p.sids.map((x) => `[${x}]`).join(' '));
    }
    const ids = new Set(citedIds(texts.map(String).join('\n')));
    for (const m of d.must_read) ids.add(m.sid);
    return [...ids].filter((i) => this.sources[i]).sort((a, b) => sidNum(a) - sidNum(b));
  }

  // ================================================================ 기본 노트 (구성안의 notes가 비었을 때, 숫자로 만든 문장)

  defaultNote(key) {
    const { m, d } = this;
    const ko = this.lang === 'ko';
    const ids = this.subqIds();
    const weak = ids.filter((q) => ['weak', 'insufficient'].includes(this.strengthOf(q))).length;
    const join = (xs) => xs.filter(Boolean).join(' ');
    const stats = this.r.stats || {};
    switch (key) {
      case 'opening':
        return ko ? `오늘의 질문은 "${d.question || this.topic}"입니다. 채택 문헌 ${num(m.included)}건과 하위 질문 ${ids.length}개로 답을 찾았습니다.`
          : `Today's question: "${d.question || this.topic}". We answer it from ${num(m.included)} included sources and ${ids.length} sub-questions.`;
      case 'answer':
        return join([d.answer, d.answer_caveat]) || (ko ? '결론을 정리할 근거가 부족합니다.' : 'There is not enough evidence for a bottom line.');
      case 'method':
        return ko ? `AI 에이전트가 8단계로 문헌 ${num(m.collected)}건을 수집해 중복 ${num(m.merged)}건을 합치고 ${num(m.included)}건을 채택했습니다. 검색 기간은 ${m.window}${m.model ? `, 모델은 ${m.model}` : ''}입니다.`
          : `In eight stages the agent collected ${num(m.collected)} sources, merged ${num(m.merged)} duplicates and included ${num(m.included)}. Search window: ${m.window}${m.model ? `; model: ${m.model}` : ''}.`;
      case 'landscape': {
        const top = studyTypeRows(stats, this.T.other, this.lang === 'ko' ? theme.STUDY_TYPE_LABEL : STUDY_EN);
        return join([this.captionStudy(top), this.captionYears(yearRows(stats)), this.captionDirection(directionRows(stats))].map((x) => (x ? `${x}.` : '')))
          || (ko ? '근거 통계가 없습니다.' : 'No evidence statistics were recorded.');
      }
      case 'strength':
        return ko ? `하위 질문 ${ids.length}개 중 근거가 '중간' 이상인 것은 ${ids.length - weak}개, '약함' 이하인 것은 ${weak}개입니다.`
          : `Of ${ids.length} sub-questions, ${ids.length - weak} have moderate or strong evidence and ${weak} weak or insufficient.`;
      case 'tension':
        return join([...d.agree, ...d.conflict, d.conflict_why]);
      case 'gaps':
        return join(d.gaps.map((g) => join([g.gap.replace(/[.。]?$/, '.'), g.why])));
      case 'next':
        return join(d.next_studies.map((st) => join([st.title.replace(/[.。]?$/, '.'), st.design, st.sample, st.payoff])));
      case 'cautions':
        return join(d.cautions) || (ko ? '기재된 주의 사항이 없습니다.' : 'No cautions were listed.');
      case 'closing':
        return join([...d.takeaways, d.closing]) || join(d.messages.map((x) => x.headline));
      case 'qa':
        return ko ? '질문을 받겠습니다. 인용한 문헌은 부록 C에 모두 있습니다.' : 'Questions are welcome. Every cited source is listed in Appendix C.';
      case 'appendix':
        return ko ? '부록에는 하위 질문, 필독 문헌, 참고문헌이 있습니다.' : 'The appendix lists the sub-questions, must-read sources and references.';
      case 'appendix_a':
        return ko ? `하위 질문 ${ids.length}개의 원래 질문과 근거 강도입니다.` : `The ${ids.length} sub-questions with their evidence strength.`;
      case 'appendix_b':
        return ko ? `먼저 읽을 문헌 ${d.must_read.length}건과 그 이유입니다.` : `${d.must_read.length} sources to read first, and why.`;
      case 'appendix_c':
        return ko ? '슬라이드와 발표자 노트에 인용한 문헌입니다.' : 'Sources cited on the slides and in the speaker notes.';
      default:
        return '';
    }
  }

  messageNote(msg) {
    const parts = [msg.headline.replace(/[.。]?$/, '.')];
    for (const p of msg.points) parts.push([p.figure, p.text].filter(Boolean).join(' ') + (p.sids.length ? ` [${p.sids.join(', ')}]` : '') + '.');
    if (msg.takeaway) parts.push(msg.takeaway);
    return parts.join(' ');
  }

  async build() {
    const d = this.d;
    // 파일 속성(파일 → 정보): 제목 · 주제 · 만든 이. 주제를 비워 두면 라이브러리 이름이 들어간다
    this.pptx.title = this.topic.slice(0, 200);
    this.pptx.subject = safe(d.subtitle || d.question || 'AI Research Agent').slice(0, 200);
    this.pptx.author = 'AI Research Agent';
    this.pptx.company = 'AI Research Agent';
    this.cover();
    this.question();
    this.bottomLine();
    this.method();
    this.landscape();
    d.messages.forEach((msg, i) => this.message(msg, i, d.messages.length));
    this.strength();
    this.tension();
    this.gaps();
    this.nextStudies();
    this.cautions();
    this.takeaways();
    this.qa();
    this.appendixCover();
    this.appendixSubq();
    this.appendixMust();
    this.references();
    const raw = await this.pptx.write({ outputType: 'uint8array' });
    return patchPackage(raw, this.chartLabelColors);
  }
}

// ---------------------------------------------------------------- 만든 뒤 XML 손질

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// latin 뒤에 ea · cs가 이미 있을 수 있다(범례는 latin + cs). 스키마 순서 latin → ea → cs를 지키고 겹치지 않게 한다
const LATIN_RUN = new RegExp(`<a:latin typeface="${esc(FONT)}"([^>]*)/>(\\s*<a:ea\\b[^>]*/>)?(\\s*<a:cs\\b[^>]*/>)?`, 'g');
const addEastAsian = (all, attrs, ea, cs) => (ea ? all
  : `<a:latin typeface="${FONT}"${attrs}/><a:ea typeface="${FONT}"/>${cs ? cs.trim() : `<a:cs typeface="${FONT}"/>`}`);

/** pptxgenjs 결과 zip을 고친다: 차트 글자에 동아시아 글꼴, 글머리 기호 색, 계열별 데이터 레이블 색. */
async function patchPackage(raw, chartLabelColors) {
  const zip = await JSZip.loadAsync(raw);
  const names = Object.keys(zip.files);
  for (const name of names) {
    const isSlide = /^ppt\/slides\/slide\d+\.xml$/.test(name);
    const chartNo = /^ppt\/charts\/chart(\d+)\.xml$/.exec(name);
    if (!isSlide && !chartNo) continue;
    let xml = await zip.file(name).async('string');
    const before = xml;
    // 라틴 글꼴만 지정된 곳에 동아시아 · 복합 글꼴을 붙인다 (한글이 대체 글꼴로 나오지 않게)
    xml = xml.replace(LATIN_RUN, addEastAsian);
    if (isSlide) {
      xml = xml.replace(/<a:buSzPct val="100000"\/><a:buChar /g,
        `<a:buClr><a:srgbClr val="${C.PURPLE}"/></a:buClr><a:buSzPct val="100000"/><a:buChar `);
    }
    if (chartNo) {
      const colors = chartLabelColors[parseInt(chartNo[1], 10) - 1];
      if (colors) {
        let k = 0;
        xml = xml.replace(/<c:ser>[\s\S]*?<\/c:ser>/g, (ser) => {
          const c = colors[k++];
          if (!c) return ser;
          return ser.replace(/(<c:dLbls>[\s\S]*?<c:txPr>[\s\S]*?<a:defRPr[^>]*>\s*<a:solidFill>\s*<a:srgbClr val=")[0-9A-Fa-f]{6}/,
            `$1${c}`);
        });
      }
    }
    if (xml !== before) zip.file(name, xml);
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

/** result(PYTHON_SPEC 3.2)와 발표 구성안(v2)으로 발표 슬라이드를 만들어 바이트(Uint8Array)로 돌려준다.
 *  deck이 v2 구성안이 아니면(없음 · v1 개요 · 엉뚱한 값) 규칙 구성안(fallbackDeck)을 쓴다. */
export async function buildPptx(result, deck = null) {
  result = (result && typeof result === 'object') ? result : {};
  const plan = isDeck(deck) ? deck : fallbackDeck(result);
  return new Deck(result, normalizeDeck(plan, result)).build();
}
