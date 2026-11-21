# 새 디자인 "라벤더" (DESIGN_LAVENDER)

사용자 요청(2026-11-20): 지금 디자인은 깔끔하지만 **임팩트가 부족**하다. **지금 디자인은 보존**하고 새 디자인을 만든다.
1. 전체 색은 **라벤더·보라**를 쓰고, 어울리는 색 **2가지를 더해 모두 3가지 색**만 쓴다.
2. 그 색에 어울리는 **테마와 글꼴**을 쓴다.
3. 새 디자인도 **알아보기 쉽고, 간결하고, 깔끔**해야 한다.

이 문서는 `assets/skin-lavender.css`에 실제로 들어 있는 값을 적은 것이다. 값을 바꾸면 이 문서도 같이 고친다(기준은 CSS).

## 0. 원칙
- **배치(LAYOUT_V3)와 동작은 그대로.** 바뀌는 것은 색·글꼴·모서리·그림자·강조 표현뿐이다.
- **스킨 두 개**: `lavender`(새 디자인, 기본값) · `classic`(이전 디자인, 그대로 보존). `<html data-skin="…">`로 고른다.
  새 디자인의 규칙은 `assets/skin-lavender.css` 한 파일에 있고 **전부 `:root[data-skin="lavender"]` 아래**에 둔다. 라벤더 디자인 때문에 공용 CSS에서 바꾼 것은 새 마크업을 classic에서 숨기는 `assets/home.css` 끝의 `.hero-eyebrow { display: none; }` 한 줄뿐이다. `classic`일 때는 설정 창의 "디자인" 구역을 빼면 화면이 이전과 한 픽셀도 달라지지 않아야 한다(이전 커밋과 화면을 찍어 픽셀 단위로 비교해 확인했다).
  그 뒤 두 디자인에 함께 적용되는 버그 수정 두 가지가 공용 CSS에 들어갔다: 자기 비판 카드 줄의 단계 태그가 잘리던 것(`app.css`의 `.feed-row.feed-card`, 함께 `run.js`에서 구조화된 내용이 없는 자기 비판 줄은 보통 줄로 그린다)과, 스크롤 상자 안의 숨김 글자 때문에 화면이 빈 공간으로 길어지던 것(`app.css`의 `.table-wrap`, `result.css`의 `.chart-table-wrap` · `.events-scroll`에 `position: relative`). 이 두 곳은 classic에서도 이전과 달라 보이는 것이 맞다.
- 색은 **세 가지 계열만**: 보라(라벤더~바이올렛) · 민트 · 코랄(살구~주홍). 회색 대신 보라 기운이 도는 중립색(글자·테두리·바탕)을 쓴다. 다른 색상(파랑·초록·노랑·빨강)은 쓰지 않는다.
- 임팩트는 **넓은 면 하나(진한 보라 사이드바)와 큰 제목, 그라데이션 주 버튼, 처음 화면 위쪽의 오로라**에서 만들고, 나머지는 카드와 옅은 바탕으로 조용하게 둔다. 민트·코랄은 **작은 강조**(상태·단계 번호·차트·경고)에만 쓴다.
- **밝은 화면과 어두운 화면 둘 다 같은 비중으로 다룬다.** 화면 테마의 기본값이 "시스템 설정"이라 Windows가 어두운 모드인 사용자는 어두운 화면을 먼저 본다. 어두운 화면은 검정에 가까운 회색이 아니라 **짙은 보라 밤색**으로 잡아, 어두워도 화면 전체가 보라로 읽히게 한다.

## 1. 색

### 1.1 세 가지 색
| 계열 | 쓰임 | 값 |
|---|---|---|
| **보라** (주색) | 사이드바, 주 버튼, 선택·초점, 링크, 진행 | `#24184D` · `#34226B` · `#4A2BB0` · `#5A2FD0` · `#6A3DE8` · `#7C4DF0` · `#9070F5` · `#A78BFA` · `#C9B8FD` · `#E0D6FE` · `#EEE8FF` · `#F7F4FF`; 가림막 `#1E1535`(반투명), 로고 타일 `#B79CFF`; 어두운 화면 사이드바 `#2E1F66` · `#1E1446`, 어두운 화면 주 버튼 `#B9A3FB` → `#8F6DF7` |
| **민트** (보조) | 완료·성공, 긍정 방향, 차트 3, 진행 막대의 끝 | `#097A6B`(글자) · `#0C8A79`(진행 막대 끝) · `#19B8A2` · `#3FD4BF`(어두운 화면·사이드바) · `#E1F6F2` |
| **코랄** (강조) | 주의·오류, 차트 2, "추천" 배지 | `#BE3324`(오류) · `#E0503A` · `#F26D50` · `#D9672F`(주의 아이콘) · `#FF9E7A`(살구, 오로라) · `#FFEDE4`; 어두운 화면·사이드바 `#FF8E6E` · `#FF8370` · `#FFA873` · `#FFB38F` |

### 1.2 토큰 (밝은 화면) — `:root[data-skin="lavender"]`
```
--bg: #F7F4FF;  --surface: #FFFFFF;  --surface-2: #F3EFFC;  --surface-3: #E8E1F9;
--border: #E5DEF5;  --border-strong: #CBC1E6;  --scrim: rgba(30, 21, 53, 0.5);
--text: #1E1933;  --text-2: #4B4463;  --text-3: #68617F;  --text-on-accent: #FFFFFF;
--accent: #6A3DE8;  --accent-hover: #5A2FD0;  --accent-soft: #EEE8FF;  --accent-ring: rgba(106, 61, 232, 0.30);
--good: #097A6B;  --good-soft: #E1F6F2;
--warning: #D9672F;  --warning-soft: #FFEDE4;  --serious: #E0503A;
--critical: #BE3324;  --critical-soft: #FDEBE7;
--neutral: #8B84A3;  --neutral-soft: #EFEBF8;
--chart-seq: #7C4DF0;  --chart-1: #7C4DF0;  --chart-2: #F26D50;  --chart-3: #19B8A2;  --chart-4: #C9B8FD;
--chart-none: #CFC9E0;  --chart-grid: #E9E4F5;
--shadow-1: 0 1px 2px rgba(60, 35, 140, 0.08);
--shadow-2: 0 6px 20px rgba(60, 35, 140, 0.10);
--shadow-pop: 0 16px 40px rgba(45, 25, 110, 0.20), 0 2px 8px rgba(45, 25, 110, 0.10);
--r-sm: 8px;  --r-md: 10px;  --r-lg: 14px;  --r-xl: 20px;
```
스킨 전용 변수(같은 선택자에):
```
--grad-primary: linear-gradient(135deg, #7C4DF0 0%, #5A2FD0 100%);
--grad-title: linear-gradient(92deg, #4A2BB0 0%, #7C4DF0 60%, #9070F5 100%);
--side-top: #34226B;  --side-bottom: #24184D;
--violet: #7C4DF0;  --mint: #19B8A2;  --coral: #F26D50;  --lavender: #C9B8FD;  --bar-end: #0C8A79;
--glow: 0 6px 16px rgba(106, 61, 232, 0.32);  (호버 0 9px 22px .38 · 누름 0 3px 10px .28)
--shadow-prompt: 0 10px 30px rgba(60, 35, 140, 0.10);
--seg-on: var(--surface);  --cite-hover: #E0D6FE;  --selection: #E0D6FE;
--aurora-violet: rgba(167, 139, 250, 0.20);  --aurora-mint: rgba(79, 209, 190, 0.14);  --aurora-apricot: rgba(255, 158, 122, 0.12);
--hero-violet: rgba(167, 139, 250, 0.42);  --hero-mint: rgba(79, 209, 190, 0.24);  --hero-apricot: rgba(255, 158, 122, 0.22);
--side-new-bg: #FFFFFF;  --side-new-hover: #F1ECFF;  --side-edge: none;
--toast-bg: #221A3D;  --toast-edge: transparent;
```

### 1.3 토큰 (어두운 화면) — `[data-theme="dark"]`와 시스템 어두운 화면 둘 다(tokens.css가 쓰는 두 가지 방식 그대로, 두 블록의 값은 같다)
```
--bg: #18112C;  --surface: #23193E;  --surface-2: #2C204B;  --surface-3: #37295B;
--border: #382D5C;  --border-strong: #51437F;  --scrim: rgba(8, 5, 18, 0.65);
--text: #EFEBFA;  --text-2: #BDB5D6;  --text-3: #A49CC0;  --text-on-accent: #1A1330;
--accent: #A78BFA;  --accent-hover: #B9A3FB;  --accent-soft: #33265F;  --accent-ring: rgba(167, 139, 250, 0.40);
--good: #3FD4BF;  --good-soft: #143D38;  --warning: #FFA873;  --warning-soft: #4A2C1C;  --serious: #FF8E6E;
--critical: #FF8370;  --critical-soft: #4A211B;  --neutral: #8F87AD;  --neutral-soft: #2E2550;
--chart-seq: #A78BFA;  --chart-1: #A78BFA;  --chart-2: #FF8E6E;  --chart-3: #3FD4BF;  --chart-4: #6756AA;
--chart-none: #51487A;  --chart-grid: #382D5C;
--shadow-1: 0 1px 2px rgba(0, 0, 0, 0.45);  --shadow-2: 0 6px 20px rgba(0, 0, 0, 0.5);
--shadow-pop: 0 16px 40px rgba(0, 0, 0, 0.65), 0 2px 8px rgba(0, 0, 0, 0.45);
--grad-primary: linear-gradient(135deg, #B9A3FB 0%, #8F6DF7 100%);
--grad-title: linear-gradient(92deg, #C9B8FD 0%, #A78BFA 60%, #8F6DF7 100%);
--side-top: #2E1F66;  --side-bottom: #1E1446;
--violet: #A78BFA;  --mint: #3FD4BF;  --coral: #FF8E6E;  --lavender: #C9B8FD;  --bar-end: #3FD4BF;
--glow: 0 6px 18px rgba(143, 109, 247, 0.26);  (호버 0 9px 24px .34 · 누름 0 3px 10px .22)
--shadow-prompt: 0 10px 30px rgba(0, 0, 0, 0.45);
--seg-on: var(--surface-3);  --cite-hover: rgba(167, 139, 250, 0.24);  --selection: rgba(167, 139, 250, 0.38);
--aurora-violet: rgba(167, 139, 250, 0.14);  --aurora-mint: rgba(79, 209, 190, 0.08);  --aurora-apricot: rgba(255, 158, 122, 0.07);
--hero-violet: rgba(167, 139, 250, 0.30);  --hero-mint: rgba(79, 209, 190, 0.13);  --hero-apricot: rgba(255, 158, 122, 0.12);
--side-new-bg: #EEE8FF;  --side-new-hover: #FFFFFF;  --side-edge: inset -1px 0 0 rgba(255, 255, 255, 0.06);
--toast-bg: #2F2456;  --toast-edge: rgba(255, 255, 255, 0.10);
```
어두운 화면의 주 버튼은 밝은 라벤더 그라데이션 위에 짙은 글자(`--text-on-accent: #1A1330`)다(밝은 화면은 진한 보라 위 흰 글자).

글자 대비는 WCAG AA(본문 4.5:1, 큰 글자·아이콘 3:1)를 계산해서 맞춘 값이다. 처음 정한 값 가운데 `--text-3`, `--good`, `--warning`, 제목 그라데이션의 끝 색, 사이드바 `--text-3`, 진행 막대의 끝 색은 대비가 모자라 같은 계열 안에서 고쳤다. 값을 바꾸면 다시 계산한다.
- `--warning`은 아이콘·차트 면에만 쓰므로 기준이 3:1이다(글자에는 쓰지 않는다).
- 처음 화면 머리띠의 색 점 세 개는 꾸밈 요소라 대비 기준에서 뺀다.

## 2. 글꼴 (사이트에 직접 담는다: CSP가 외부 글꼴을 막는다)
- **본문·UI: Pretendard Variable** (OFL-1.1, npm `pretendard` 1.3.9의 `dist/web/variable/woff2-dynamic-subset/` 92개 조각 + unicode-range).
- **제목·숫자·워드마크의 영문/숫자: Outfit Variable** (OFL-1.1, npm `@fontsource-variable/outfit` 5.3.0의 latin 조각 1개).
- 파일은 `assets/fonts/pretendard/pv-N.woff2`, `assets/fonts/outfit/outfit-latin.woff2`, 글꼴 선언은 `assets/fonts/fonts.css`. `font-display: swap`. 처음 화면이 실제로 내려받는 것은 필요한 조각 16개(약 440KB)뿐이다.
- 라벤더일 때 `boot.js`가 이 16개를 `<link rel="preload" as="font" crossorigin>`로 **미리 받는다**(스크립트·스타일과 나란히). 화면을 그린 뒤에야 받기 시작하면 처음 방문할 때 기본 글꼴로 잠깐 보였다가 바뀐다. 처음·진행·결과 화면이 모두 같은 16개를 쓴다. 화면 글자가 크게 바뀌어 쓰는 조각이 달라지면 `boot.js`의 목록도 고친다(주소가 `fonts.css`·실제 파일과 맞는지는 `tests/boot.test.js`가 확인한다). classic에서는 받지 않는다.
- **글꼴 이름은 `"RA Pretendard"`, `"RA Outfit"`** 로 선언한다. `classic` 스킨의 `--font-sans`가 "Pretendard Variable"로 시작하므로, 같은 이름으로 선언하면 보존해야 할 이전 디자인의 글꼴이 바뀐다.
- 스킨 토큰: `--font-sans: "RA Pretendard", -apple-system, BlinkMacSystemFont, "Segoe UI", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif;`
  `--font-display: "RA Outfit", "RA Pretendard", -apple-system, "Segoe UI", "Malgun Gothic", sans-serif;` (한글은 Outfit에 없으므로 자동으로 Pretendard가 받는다)
- 라이선스 원문은 `vendor/licenses/`에 있고 `THIRD_PARTY_NOTICES.md`에 적었다.

글자 규칙(라벤더 스킨):
- 처음 화면 제목: `--font-display`, 2.5rem(≤640px는 1.75rem), 굵기 800, 자간 -0.03em, 줄 높이 1.2, **`--grad-title` 그라데이션 글자**(`background-clip: text`; 강제 색상 모드와 인쇄에서는 일반 글자색).
- 화면 제목(진행·결과): 굵기 800, 자간 -0.02em. 글꼴은 본문 글꼴 그대로(긴 한글 제목에 Outfit 영문이 섞이면 들쭉날쭉해 보인다). 카드·블록 제목: 굵기 700.
- 숫자(현황 타일, 비용, 개수, 단계 번호): `--font-display`, `font-variant-numeric: tabular-nums`.
- 워드마크 "AI Research Agent": `--font-display` 700, 자간 -0.01em. 모달 제목과 보고서 본문 제목(h1~h3)도 `--font-display`.

## 3. 스킨 고르기
- `boot.js`: 첫 화면을 그리기 전에 `document.documentElement.dataset.skin`을 정한다. 순서: URL `?skin=classic|lavender` → `localStorage['ra.skin']` → 기본 `lavender`.
  URL 값은 저장한 뒤 **주소에서 지운다**(`history.replaceState`, 다른 값과 `#` 뒤는 그대로). 남겨 두면 설정에서 디자인을 바꾼 뒤 새로고침할 때 주소의 값이 다시 덮어쓴다. 저장하지 못한 경우에는 지우지 않는다.
  `?skin=`은 주소의 `#` **앞**에 있어야 읽힌다(예: `…/ai-research-agent/?skin=classic`). `#` 뒤에 붙이면 경로의 일부가 되어 읽히지 않는다.
  라벤더일 때 파비콘도 보라(`#6A3DE8`)로 바꾸고(`link[rel=icon]`의 data URL 교체, 두 주소를 `data-href-classic`·`data-href-lavender`로 남겨 둔다), 글꼴 조각 16개를 미리 받는다(2절).
- `store.js`: `loadSkin()`(이미 적용된 `<html data-skin>` → `localStorage` → 기본), `saveSkin(skin)`, 상태 키 `skin`. 값은 `'lavender' | 'classic'`만.
- 설정 창(`openKeyDialog`): "화면 테마" 구역 아래에 **"디자인"** 구역. 2칸 세그먼트 `라벤더` · `클래식`(aria-pressed), 아래 작은 글씨 "클래식은 이전 디자인입니다." 고르면 바로 적용·저장한다(새로고침 없음).
  세그먼트의 버튼은 한 번만 만들고 고를 때는 `aria-pressed`만 바꾼다(테마 세그먼트도 같다). 버튼을 다시 만들면 방금 누른 버튼이 사라져 키보드 초점이 창 밖으로 빠진다.
- `index.html`: `<link rel="stylesheet" href="./assets/fonts/fonts.css">`와 `<link rel="stylesheet" href="./assets/skin-lavender.css">`를 `result.css` 다음에 둔다. CSP는 그대로(`font-src 'self' data:`).

## 4. 구성 요소별 표현 (전부 `:root[data-skin="lavender"]` 아래)

### 4.1 바탕
- `body`: `--bg`. 본문 영역 위쪽에 **옅은 오로라**: `.app-main`에 `background-image`로 radial-gradient 세 개 — 왼쪽 위 보라 `--aurora-violet`, 오른쪽 위 민트 `--aurora-mint`, 가운데 위 살구 `--aurora-apricot`. 화면 위 약 300px 안에서 사라진다(`background-repeat: no-repeat`).
- **처음 화면은 더 진하고 넓게**(`.app-main:has(.home)`, 값은 `--hero-violet`·`--hero-mint`·`--hero-apricot`): 위쪽에 글자가 놓이지 않으므로(안내 카드는 불투명한 카드, 제목은 가운데) 첫인상의 임팩트를 여기서 낸다. 진행·결과 화면은 위쪽에 작은 글자가 놓이므로 옅은 값을 쓴다. `:has()`를 모르는 브라우저는 옅은 값으로 보인다. 인쇄에서는 뺀다.
- `::selection`: 바탕 `--selection`, 글자 `--text`. 스크롤 막대는 얇게, 손잡이 `--border-strong`.

### 4.2 사이드바 `.side` — 진한 보라 (가장 큰 임팩트)
- 바탕 `linear-gradient(180deg, var(--side-top), var(--side-bottom))`, 오른쪽 테두리 없음(어두운 화면에서는 본문과 구분되게 `--side-edge` 가는 선).
- 사이드바 **안에서만 토큰을 다시 정의**해 안쪽 요소(버튼·입력·기록 줄·태그·세그먼트)가 저절로 어두운 바탕용이 되게 한다(밝은/어두운 화면 공통):
  `--text: #F4F0FF; --text-2: #CFC5EE; --text-3: #C3B8E9; --surface: rgba(255,255,255,.06); --surface-2: rgba(255,255,255,.09); --surface-3: rgba(255,255,255,.15); --border: rgba(255,255,255,.12); --border-strong: rgba(255,255,255,.24); --accent: #C9B8FD; --accent-hover: #E0D6FE; --accent-soft: rgba(201,184,253,.18); --accent-ring: rgba(201,184,253,.45); --text-on-accent: #24184D; --focus-ring: 0 0 0 3px rgba(201,184,253,.45); --good: #3FD4BF; --warning: #FFB38F; --critical: #FF8370; --neutral: #B3A6DC;`
- 로고 타일: `linear-gradient(135deg, #B79CFF, #7C4DF0)`, 흰 아이콘. 워드마크 흰색.
- "새 조사" 버튼: **`--side-new-bg` 바탕(밝은 화면 흰색, 어두운 화면 `#EEE8FF`) + 보라 글자(`#4A2BB0`)**, 굵기 700, 그림자 `0 4px 14px rgba(0,0,0,.25)`; 호버 `--side-new-hover`. 접힌 상태의 ＋ 버튼도 같은 규칙. 테마 세그먼트의 고른 칸도 같은 바탕·글자.
- 검색 입력: 반투명 흰 바탕, 흰 글자, 자리표시 `--text-3`, 초점 고리 라벤더.
- 기록 줄: 호버 `--surface-2`; 지금 보는 조사(`is-current`)는 `--surface-3` + 왼쪽 3px 라벤더(`#C9B8FD`) 막대, 제목 흰색. 상태 점: 완료 민트 `--good`, 진행 라벤더 `--accent`, 검토 대기 살구 `--warning`, 오류 코랄 `--critical`, 중단 `--neutral`.
- 태그: 반투명 흰 바탕 + `--text-2`("이어서 가능"은 `--accent-soft` + `--accent-hover`: 마우스를 올린 줄 위에서도 4.5:1이 되게). **지금 보는 줄 안의 태그는 글자 `--text`**(줄 바탕이 한 겹 더 밝아 다른 글자색은 4.5:1에 못 미친다).
- 좁은 화면의 서랍도 같은 모양. 위쪽 바(`header.topbar`)는 `--surface` 유지, 로고 타일만 그라데이션.

### 4.3 버튼·선택
- `.btn-primary`: `background: var(--grad-primary)`, 테두리 없음, 글자 `--text-on-accent` 600(밝은 화면 흰색, 어두운 화면 짙은 보라), 그림자 `--glow`; 호버 밝기 1.06 + 그림자 조금 크게; 누름 밝기 .96; 비활성은 그림자 없음 + 투명도 .5. **진행 중(`is-busy`)은 투명도 .85**(꺼진 버튼처럼 보이지 않게).
- "조사 시작"(`.btn-start`): 알약 모양(`border-radius: var(--r-pill)`), 높이 46px, 좌우 여백 28px(≤640px는 16px: "조사 설정" 버튼과 한 줄을 나눠 쓴다).
- `.btn-secondary`: 바탕·테두리는 공용 규칙 그대로(`--surface`·`--border-strong`), 호버 시 테두리·글자 보라, 누르면 `--accent-soft`. 취소 버튼(`.btn-cancel`)의 빨간 호버는 공용 규칙 그대로.
- 체크 줄 `.ck`: 선택 바탕 `--accent-soft`, 체크 상자 `--grad-primary`. 초점 고리 `--accent-ring`.
- 세그먼트 `.seg`: 바탕 `--surface-2`, 선택 칸 `--seg-on`(밝은 화면 흰색, 어두운 화면 `--surface-3`) + `--shadow-1`, 선택 글자 보라 700.
- 스위치·체크박스(결과 화면 등): 켜짐 색 보라. 카드 `.card`에는 `--shadow-1`.

### 4.4 처음 화면
- 제목 위에 **작은 머리띠** `div.hero-eyebrow`(compose.js가 넣는 마크업; classic에서는 `display: none`): 색 점 세 개(보라·민트·코랄, 6px) + "8단계로 조사하는 AI 연구 에이전트". 알약 모양, 바탕 `--surface`, 테두리 `--border`, 글자 12.5px 600 `--accent`.
- 제목: 2절의 그라데이션 글자. 설명 문장 `--text-2` 1rem.
- 안내 카드 `.onb-card`: 카드, 모서리 `--r-xl`, `--shadow-2`. 단계 번호 원 세 개를 **보라·민트·코랄**로(옅은 바탕 + 진한 숫자: 1 `--accent-soft`/`--accent`, 2 `--good-soft`/`--good`, 3 `--warning-soft`/`--critical`; 완료(`is-done`)는 `--grad-primary` + 체크).
- 프롬프트 카드 `.composer .prompt-card`: 모서리 18px, 테두리 1.5px, 그림자 `--shadow-prompt`; 초점 시 테두리 보라 + `--accent-ring`. 예시 칩: 바탕 `--surface-2`, 호버 시 테두리 보라, 누르면 `--surface-3`(꺼진 칩은 올려도 그대로).
- `.composer` 바탕은 `--bg`(오로라가 비치지 않게 불투명).

### 4.5 조사 설정 패널
- 패널 바탕 `--bg`, 블록 `.sp-block`: 카드, 모서리 `--r-lg`, 테두리 `--border`, 아주 옅은 그림자 `--shadow-1`.
- 블록 제목 앞에 **6px 둥근 점**(보라; 결과물 블록은 민트, 옵션 블록은 코랄 — `nth-of-type`로): 블록을 한눈에 구분하고 세 색을 조금씩 쓴다.
- 아래 예상치 `.sp-foot`: 바탕 `--surface`, 위 테두리 `--border`; 첫 줄 금액은 `--font-display` 800 보라.
- "추천" 배지: 바탕 `--warning-soft`, 글자 `--critical`(코랄) — 보라 선택 줄 안에서 눈에 띄게.

### 4.6 진행 화면
- 단계 표시: 끝난 단계 원은 `--grad-primary` + 체크, 진행 중은 보라 고리 + `--accent-ring` 번짐, 남은 단계는 `--surface-3` 테두리 + `--surface-2` 바탕. 연결선은 끝난 구간 보라, 나머지 `--border`.
- 진행 막대: `linear-gradient(90deg, var(--violet), var(--bar-end))`(보라→민트), 바탕 `--surface-3`. 끝 색 `--bar-end`는 막대 바탕과 3:1 이상 나는 민트다. 비용 한도 근접·도달 색은 공용 규칙 그대로(`--warning`·`--critical`).
- 현황 타일: 카드(`--surface` + 테두리) + 숫자 `--font-display` 800; "예상 비용" 타일 숫자만 보라. 값이 바뀔 때 `--accent-soft`로 잠깐 반짝인다.
- 활동 기록의 단계 태그: `--accent-soft`/`--accent`. 경고 줄 살구, 오류 줄 코랄.
- 계획 검토 띠·종료 카드: 정보 `--accent-soft`, 주의 `--warning-soft`, 오류 `--critical-soft`. **계획 검토를 기다리는 카드(`.plan-card.is-review`)에는 3px `--accent-ring` 고리**(어디를 눌러야 하는지 보이게).

### 4.7 결과 화면
- 탭: 선택 탭 글자 보라 700 + 아래 3px `--grad-primary` 막대. 위에 붙는 탭 줄(`.result-tabs`)은 `--bg` 88% + 흐림(`backdrop-filter`)으로 오로라 위에서 띠가 도드라지지 않게 한다(지원하지 않으면 불투명 `--bg`).
- 보고서 본문: 제목(h1~h3) `--font-display` + 굵기 800/700, h2 왼쪽에 3px 보라 막대는 넣지 않는다(깔끔하게). 링크 보라.
- 인용 칩 `.cite`: 바탕 `--accent-soft`, 글자 `--accent` 600; 호버·펼침 시 바탕 `--cite-hover`, 글자 `--accent-hover`.
- 목차: 현재 항목 보라 + `--accent-soft`.
- 근거 표·필터·차트는 토큰만으로 따라온다. 판정 배지: 지지 민트, 부분 살구, 불일치 코랄.

### 4.8 창·알림·메뉴
- 모달: 모서리 `--r-xl`, 제목 `--font-display` 700; 가림막 `--scrim`.
- 토스트: 바탕 `--toast-bg`(밝은 화면 `#221A3D`, 어두운 화면은 바탕보다 한 단계 밝은 `#2F2456` + 가는 테두리), 흰 글자, 모서리 `--r-lg`; 성공 아이콘 민트 `#3FD4BF`, 오류 코랄 `#FF8370`, 안내 라벤더 `#C9B8FD`.
- 메뉴·팝오버: 모서리 `--r-lg`, `--shadow-pop`. 모달·메뉴·토스트는 `body`에 붙으므로 사이드바의 어두운 토큰을 물려받지 않는다.
- 위쪽 띠(테스트 모드): 바탕 `--accent-soft`, 글자 `--text`.
- 시작 오류·탭 안내 카드: 로고 타일 그라데이션, 제목 `--font-display` 800.

## 5. 확인할 것
- `data-skin="classic"`이면 이전 디자인과 같다(공용 파일에서 바뀐 것이 home.css의 `.hero-eyebrow { display: none; }` 한 줄과 0절 "스킨 두 개"에 적은 두 버그 수정뿐인지 `git diff`로 확인; 설정 창의 "디자인" 구역은 classic에도 보인다). 클래식만 쓰는 브라우저에서는 글꼴 파일을 내려받지 않는다.
- 라벤더: 밝은/어두운 화면 모두에서 글자 대비 AA, 초점 표시가 보인다(사이드바 안은 라벤더 고리), 375px에서 가로 스크롤 없음, 움직임 줄이기 설정 존중(app.css의 공용 규칙이 애니메이션·전환을 끈다).
- 스킨 규칙을 더 강한 선택자로 다시 쓸 때는 공용 규칙의 상태(호버·누름·비활성·진행 중·강조 고리)를 덮지 않는지 확인한다.
- 글꼴 파일이 200으로 오고(`assets/fonts/…`, GitHub Pages는 대소문자를 구분한다), 글꼴이 늦게 와도 글자가 먼저 보인다(`swap`).
- `node --test tests/` 통과(`tests/boot.test.js`: 디자인을 고르는 순서, 주소 정리, 글꼴 미리 받기), 인라인 스크립트 없음.
