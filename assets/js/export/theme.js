// 결과물(HTML · PDF · Word · PPT)이 공유하는 디자인 값. 웹 화면(assets/tokens.css)의 토큰과 맞춘다.
// 색을 바꾸려면 이 파일만 고치면 모든 결과물에 반영된다. 값은 '#' 없는 6자리 16진수.

// 브랜드 · 본문
export const ACCENT = '2456C9';          // 강조색(제목 줄, 링크, 표 머리글)
export const ACCENT_DARK = '173A8C';
export const ACCENT_SOFT = 'E8EEFB';     // 강조색의 옅은 배경
export const INK = '15171C';             // 본문 글자
export const INK_2 = '4A5160';           // 보조 글자
export const MUTED = '7A8292';           // 캡션 · 각주
export const RULE = 'D8DCE5';            // 구분선 · 표 테두리
export const SURFACE = 'FFFFFF';
export const SURFACE_ALT = 'F4F6FA';     // 표 머리글 · 카드 배경

// 상태색 (판정 표시 전용, 다른 용도로 쓰지 않는다)
export const GOOD = '0CA30C';
export const WARNING = 'FAB219';
export const SERIOUS = 'EC835A';
export const CRITICAL = 'D03B3B';
export const NEUTRAL = '898781';

// 차트 계열색 (고정 순서, 순환 금지)
export const SERIES = ['2A78D6', 'EB6834', '1BAF7A', 'EDA100', 'E87BA4', '008300', '6250D6', 'E34948'];
export const SEQUENTIAL = '2A78D6';      // 크기 비교용 단일 색상

// 글꼴
export const FONT_KO = '맑은 고딕';       // Word · PPT 한글/영문 공통 (Windows 기본 탑재)
export const FONT_MONO = 'Consolas';
export const FONT_STACK_CSS = "'Pretendard Variable', Pretendard, 'Malgun Gothic', '맑은 고딕', 'Apple SD Gothic Neo', 'Noto Sans KR', system-ui, sans-serif";

export const VERDICT_LABEL = {
  'supported': '지지', 'partially supported': '부분 지지',
  'not in source text': '초록에 없음', 'contradicted': '상충', 'not checked': '미확인',
};
export const VERDICT_COLOR = {
  'supported': GOOD, 'partially supported': WARNING,
  'not in source text': NEUTRAL, 'contradicted': CRITICAL, 'not checked': NEUTRAL,
};
export const KIND_LABEL = { 'peer-reviewed': '동료심사', 'academic': '학술', 'preprint': '프리프린트', 'web': '웹' };
export const DIRECTION_LABEL = {
  'positive': '긍정', 'negative': '부정', 'mixed': '혼재', 'null': '효과 없음',
  'not applicable': '해당 없음', '': '미분류',
};
export const STRENGTH_LABEL = { 'strong': '강함', 'moderate': '중간', 'weak': '약함', 'insufficient': '불충분' };

export const STUDY_TYPE_LABEL = {
  'meta-analysis/systematic review': '메타분석·체계적 고찰', 'RCT/experiment': 'RCT·실험', 'quasi-experiment': '준실험',
  'longitudinal': '종단 연구', 'survey/correlational': '설문·상관', 'qualitative': '질적 연구', 'mixed methods': '혼합 방법',
  'case study': '사례 연구', 'theoretical/conceptual': '이론·개념', 'review/commentary': '리뷰·논평',
  'report/web article': '보고서·웹 문서', 'other': '기타',
};
// 결과 방향은 대상마다 색을 고정한다(웹 화면의 --chart-1~4, --chart-none과 같은 값). '해당 없음'·미분류는 중립 회색
export const NEUTRAL_FILL = 'C3C2B7';
export const DIRECTION_COLOR = {
  'positive': SERIES[0], 'negative': SERIES[1], 'mixed': SERIES[2], 'null': SERIES[3],
  'not applicable': NEUTRAL_FILL, '': NEUTRAL_FILL,
};
