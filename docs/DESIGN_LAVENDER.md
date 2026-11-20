# 새 디자인 "라벤더" (DESIGN_LAVENDER)

사용자 요청(2026-11-20): 지금 디자인은 깔끔하지만 **임팩트가 부족**하다. **지금 디자인은 보존**하고 새 디자인을 만든다.
1. 전체 색은 **라벤더·보라**를 쓰고, 어울리는 색 **2가지를 더해 모두 3가지 색**만 쓴다.
2. 그 색에 어울리는 **테마와 글꼴**을 쓴다.
3. 새 디자인도 **알아보기 쉽고, 간결하고, 깔끔**해야 한다.

## 0. 원칙
- **배치(LAYOUT_V3)와 동작은 그대로.** 바뀌는 것은 색·글꼴·모서리·그림자·강조 표현뿐이다.
- **스킨 두 개**: `lavender`(새 디자인, 기본값) · `classic`(지금 디자인, 그대로 보존). `<html data-skin="…">`로 고른다.
  새 디자인의 모든 규칙은 `assets/skin-lavender.css` 한 파일에 있고 **전부 `:root[data-skin="lavender"]` 아래**에 둔다. `classic`일 때는 화면이 지금과 한 픽셀도 달라지지 않아야 한다(공용 CSS·토큰을 고치지 않는다).
- 색은 **세 가지 계열만**: 보라(라벤더~바이올렛) · 민트 · 코랄(살구~주홍). 회색 대신 보라 기운이 도는 중립색(글자·테두리·바탕)을 쓴다. 다른 색상(파랑·초록·노랑·빨강)은 쓰지 않는다.
- 임팩트는 **넓은 면 하나(진한 보라 사이드바)와 큰 제목, 그라데이션 주 버튼**에서 만들고, 나머지는 흰 카드와 옅은 라벤더 바탕으로 조용하게 둔다. 민트·코랄은 **작은 강조**(상태·단계 번호·차트·경고)에만 쓴다.

## 1. 색

### 1.1 세 가지 색
| 계열 | 쓰임 | 값 |
|---|---|---|
| **보라** (주색) | 사이드바, 주 버튼, 선택·초점, 링크, 진행 | 950 `#1E1535` · 900 `#24184D` · 800 `#34226B` · 700 `#5A2FD0` · 600 `#6A3DE8` · 500 `#7C4DF0` · 400 `#A688FA` · 300 `#C9B8FD` · 200 `#E0D6FE` · 100 `#EEE8FF` · 50 `#F7F4FF` |
| **민트** (보조) | 완료·성공, 긍정 방향, 차트 3 | 700 `#0A7F6F` · 500 `#19B8A2` · 300 `#6FDCCB` · 100 `#E1F6F2` |
| **코랄** (강조) | 주의·오류, 차트 2, 숫자 강조 한두 곳 | 700 `#BE3324`(오류) · 600 `#E0503A` · 500 `#F26D50` · 400 `#FF9E7A`(살구, 주의) · 100 `#FFEDE4` |

### 1.2 토큰 (밝은 화면) — `:root[data-skin="lavender"]`
```
--bg: #F7F4FF;  --surface: #FFFFFF;  --surface-2: #F3EFFC;  --surface-3: #E8E1F9;
--border: #E5DEF5;  --border-strong: #CBC1E6;  --scrim: rgba(30, 21, 53, 0.5);
--text: #1E1933;  --text-2: #4B4463;  --text-3: #6C6587;  --text-on-accent: #FFFFFF;
--accent: #6A3DE8;  --accent-hover: #5A2FD0;  --accent-soft: #EEE8FF;  --accent-ring: rgba(106, 61, 232, 0.30);
--good: #0A7F6F;  --good-soft: #E1F6F2;
--warning: #E0703A;  --warning-soft: #FFEDE4;  --serious: #E0503A;
--critical: #BE3324;  --critical-soft: #FDEBE7;
--neutral: #8B84A3;  --neutral-soft: #EFEBF8;
--chart-seq: #7C4DF0;  --chart-1: #7C4DF0;  --chart-2: #F26D50;  --chart-3: #19B8A2;  --chart-4: #C9B8FD;
--chart-none: #CFC9E0;  --chart-grid: #E9E4F5;
--shadow-1: 0 1px 2px rgba(60, 35, 140, 0.08);
--shadow-2: 0 6px 20px rgba(60, 35, 140, 0.10);
--shadow-pop: 0 16px 40px rgba(45, 25, 110, 0.20), 0 2px 8px rgba(45, 25, 110, 0.10);
--r-sm: 8px;  --r-md: 10px;  --r-lg: 14px;  --r-xl: 20px;
```
스킨 전용 변수(같은 선택자에): `--grad-primary: linear-gradient(135deg, #7C4DF0 0%, #5A2FD0 100%)`, `--grad-title: linear-gradient(92deg, #4A2BB0 0%, #7C4DF0 60%, #A688FA 100%)`,
`--side-top: #34226B`, `--side-bottom: #24184D`, `--mint: #19B8A2`, `--coral: #F26D50`, `--lavender: #C9B8FD`.

### 1.3 토큰 (어두운 화면) — `[data-theme="dark"]`와 시스템 어두운 화면 둘 다(tokens.css가 쓰는 두 가지 방식 그대로)
```
--bg: #14111F;  --surface: #1C1830;  --surface-2: #241F3B;  --surface-3: #2E2849;
--border: #2F2A47;  --border-strong: #443D63;  --scrim: rgba(8, 5, 18, 0.65);
--text: #EFEBFA;  --text-2: #BDB5D6;  --text-3: #9A92B5;  --text-on-accent: #1A1330;
--accent: #A78BFA;  --accent-hover: #B9A3FB;  --accent-soft: #2D2452;  --accent-ring: rgba(167, 139, 250, 0.40);
--good: #3FD4BF;  --good-soft: #143D38;  --warning: #FFA873;  --warning-soft: #4A2C1C;  --serious: #FF8E6E;
--critical: #FF8370;  --critical-soft: #4A211B;  --neutral: #8F87AD;  --neutral-soft: #2A2542;
--chart-seq: #A78BFA;  --chart-1: #A78BFA;  --chart-2: #FF8E6E;  --chart-3: #3FD4BF;  --chart-4: #5B4B99;
--chart-none: #4A4366;  --chart-grid: #2F2A47;
--shadow-1: 0 1px 2px rgba(0, 0, 0, 0.45);  --shadow-2: 0 6px 20px rgba(0, 0, 0, 0.5);
--shadow-pop: 0 16px 40px rgba(0, 0, 0, 0.65), 0 2px 8px rgba(0, 0, 0, 0.45);
--grad-primary: linear-gradient(135deg, #B9A3FB 0%, #8F6DF7 100%);
--grad-title: linear-gradient(92deg, #C9B8FD 0%, #A78BFA 60%, #8F6DF7 100%);
--side-top: #221842;  --side-bottom: #150F2B;
```
글자 대비는 모두 WCAG AA(본문 4.5:1) 이상으로 계산해 둔 값이다. 값을 바꾸면 다시 계산한다.

## 2. 글꼴 (사이트에 직접 담는다: CSP가 외부 글꼴을 막는다)
- **본문·UI: Pretendard Variable** (OFL-1.1, npm `pretendard`의 `dist/web/variable/woff2-dynamic-subset/` 92개 조각 + unicode-range).
- **제목·숫자·워드마크의 영문/숫자: Outfit Variable** (OFL-1.1, npm `@fontsource-variable/outfit`의 latin 조각 1개).
- 파일은 `assets/fonts/pretendard/*.woff2`, `assets/fonts/outfit/*.woff2`, 글꼴 선언은 `assets/fonts/fonts.css`. `font-display: swap`.
- **글꼴 이름은 `"RA Pretendard"`, `"RA Outfit"`** 로 선언한다. `classic` 스킨의 `--font-sans`가 "Pretendard Variable"로 시작하므로, 같은 이름으로 선언하면 보존해야 할 지금 디자인의 글꼴이 바뀐다.
- 스킨 토큰: `--font-sans: "RA Pretendard", -apple-system, BlinkMacSystemFont, "Segoe UI", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif;`
  `--font-display: "RA Outfit", "RA Pretendard", -apple-system, "Segoe UI", "Malgun Gothic", sans-serif;` (한글은 Outfit에 없으므로 자동으로 Pretendard가 받는다)
- 라이선스 원문을 `vendor/licenses/`에 넣고 `THIRD_PARTY_NOTICES.md`에 적는다.

글자 규칙(라벤더 스킨):
- 처음 화면 제목: `--font-display`, 2.5rem(≤640px는 1.75rem), 굵기 800, 자간 -0.035em, 줄 높이 1.2, **`--grad-title` 그라데이션 글자**(`background-clip: text`; 강제 색상 모드에서는 일반 글자색).
- 화면 제목(진행·결과): 굵기 800, 자간 -0.03em. 카드·블록 제목: 굵기 700.
- 숫자(현황 타일, 비용, 개수): `--font-display`, `font-variant-numeric: tabular-nums`.
- 워드마크 "AI Research Agent": `--font-display` 700, 자간 -0.01em.

## 3. 스킨 고르기 (틀 담당)
- `boot.js`: 첫 화면을 그리기 전에 `document.documentElement.dataset.skin`을 정한다. 순서: URL `?skin=classic|lavender`(있으면 저장) → `localStorage['ra.skin']` → 기본 `lavender`.
  라벤더일 때 파비콘도 보라(`#6A3DE8`)로 바꾼다(`link[rel=icon]`의 data URL 교체).
- `store.js`: `loadSkin()`, `saveSkin(skin)`, 상태 키 `skin`. 값은 `'lavender' | 'classic'`만.
- 설정 창(`openKeyDialog`): "화면 테마" 구역 아래에 **"디자인"** 구역. 2칸 세그먼트 `라벤더` · `클래식`(aria-pressed), 아래 작은 글씨 "클래식은 이전 디자인입니다." 고르면 바로 적용·저장한다(새로고침 없음).
- `index.html`: `<link rel="stylesheet" href="./assets/fonts/fonts.css">`와 `<link rel="stylesheet" href="./assets/skin-lavender.css">`를 `result.css` 다음에 추가. CSP는 그대로(`font-src 'self'`).

## 4. 구성 요소별 표현 (스킨 담당, 전부 `:root[data-skin="lavender"]` 아래)

### 4.1 바탕
- `body`: `--bg`. 본문 영역 위쪽에 **옅은 오로라**: `.app-main`에 `background-image`로 radial-gradient 세 개 — 왼쪽 위 보라 `rgba(167,139,250,.20)`, 오른쪽 위 민트 `rgba(79,209,190,.14)`, 가운데 위 살구 `rgba(255,158,122,.12)`; 높이 약 420px 안에서 사라지게(`background-repeat: no-repeat`). 어두운 화면에서는 투명도를 절반으로.
- `::selection`: 바탕 `#E0D6FE`, 글자 `--text`. 스크롤 막대는 얇게, 손잡이 `--border-strong`.

### 4.2 사이드바 `.side` — 진한 보라 (가장 큰 임팩트)
- 바탕 `linear-gradient(180deg, var(--side-top), var(--side-bottom))`, 오른쪽 테두리 없음.
- 사이드바 **안에서만 토큰을 다시 정의**해 안쪽 요소(버튼·입력·기록 줄·태그·세그먼트)가 저절로 어두운 바탕용이 되게 한다:
  `--text: #F4F0FF; --text-2: #CFC5EE; --text-3: #B3A6DC; --surface: rgba(255,255,255,.06); --surface-2: rgba(255,255,255,.09); --surface-3: rgba(255,255,255,.15); --border: rgba(255,255,255,.12); --border-strong: rgba(255,255,255,.24); --accent: #C9B8FD; --accent-hover: #E0D6FE; --accent-soft: rgba(201,184,253,.18); --accent-ring: rgba(201,184,253,.45); --text-on-accent: #24184D;`
- 로고 타일: `linear-gradient(135deg, #B79CFF, #7C4DF0)`, 흰 아이콘. 워드마크 흰색.
- "새 조사" 버튼: **흰 바탕 + 보라 글자(`#4A2BB0`)**, 굵기 700, 그림자 `0 4px 14px rgba(0,0,0,.25)`; 호버 `#F1ECFF`. 접힌 상태의 ＋ 버튼도 같은 규칙.
- 검색 입력: 반투명 흰 바탕, 흰 글자, 자리표시 `--text-3`.
- 기록 줄: 호버 `--surface-2`; 지금 보는 조사(`is-current`)는 `--surface-3` + 왼쪽 3px 라벤더(`#C9B8FD`) 막대. 상태 점: 완료 민트 `#3FD4BF`, 진행 라벤더 `#C9B8FD`, 검토 대기 살구 `#FFB38F`, 오류 코랄 `#FF8370`, 중단 `--text-3`.
- 태그: 반투명 흰 바탕 + `--text-2`. 설정 줄의 상태 점은 그대로(민트/살구/코랄).
- 좁은 화면의 서랍도 같은 모양. 위쪽 바(`header.topbar`)는 흰 바탕(`--surface`) 유지, 로고 타일만 그라데이션.
- 어두운 화면에서는 `--side-top/bottom`만 더 어둡게(1.3).

### 4.3 버튼·선택
- `.btn-primary`(사이드바 밖): `background: var(--grad-primary)`, 테두리 없음, 흰 글자 600, 그림자 `0 6px 16px rgba(106,61,232,.32)`; 호버 밝기 1.06 + 그림자 조금 크게; 누름 밝기 .96; 비활성은 그림자 없음 + 투명도 .5.
- "조사 시작"(`.btn-start`): 알약 모양(`border-radius: var(--r-pill)`), 높이 46px, 좌우 여백 넉넉히.
- `.btn-secondary`: 흰 바탕, 테두리 `--border-strong`, 호버 시 테두리·글자 보라.
- 체크 줄 `.ck`: 선택 바탕 `--accent-soft`, 체크 상자 `--grad-primary`. 초점 고리 `--accent-ring`.
- 세그먼트 `.seg`: 바탕 `--surface-2`, 선택 칸 흰색 + `--shadow-1`, 선택 글자 보라 700.
- 스위치·체크박스(결과 화면 등): 켜짐 색 보라.

### 4.4 처음 화면
- 제목 위에 **작은 머리띠** `div.hero-eyebrow`(새 마크업, 처음 화면 담당이 compose.js에 추가; classic에서는 `display: none`): 색 점 세 개(보라·민트·코랄, 6px) + "8단계로 조사하는 AI 연구 에이전트". 알약 모양, 바탕 `--surface`, 테두리 `--border`, 글자 12.5px 600 `--accent`.
- 제목: 2.절의 그라데이션 글자. 설명 문장 `--text-2` 1rem.
- 안내 카드 `.onb-card`: 흰 카드, 모서리 `--r-xl`, `--shadow-2`. 단계 번호 원 세 개를 **보라·민트·코랄**로(옅은 바탕 + 진한 숫자: 1 `#EEE8FF`/`#6A3DE8`, 2 `#E1F6F2`/`#0A7F6F`, 3 `#FFEDE4`/`#BE3324`; 완료(`is-done`)는 `--grad-primary` + 흰 체크).
- 프롬프트 카드 `.composer .prompt-card`: 모서리 18px, 테두리 1.5px `--border-strong`, 그림자 `0 10px 30px rgba(60,35,140,.10)`; 초점 시 테두리 보라 + `--accent-ring`. 예시 칩: 바탕 `--surface-2`, 호버 시 테두리 보라.
- `.composer` 바탕은 `--bg`(오로라가 비치지 않게 불투명).

### 4.5 조사 설정 패널
- 패널 바탕 `--bg`, 블록 `.sp-block`: 흰 카드, 모서리 `--r-lg`, 테두리 `--border`, 아주 옅은 그림자 `--shadow-1`.
- 블록 제목 앞에 **4px 둥근 점**(보라; 결과물 블록은 민트, 옵션 블록은 코랄 — `nth-of-type`로): 블록을 한눈에 구분하고 세 색을 조금씩 쓴다.
- 아래 예상치 `.sp-foot`: 바탕 `--surface`, 위 테두리 `--border`; 첫 줄 금액은 `--font-display` 800 보라.
- "추천" 배지: 바탕 `#FFEDE4`, 글자 `#BE3324`(코랄) — 보라 선택 줄 안에서 눈에 띄게.

### 4.6 진행 화면
- 단계 표시: 끝난 단계 원은 `--grad-primary` + 흰 체크, 진행 중은 보라 고리 + `--accent-ring` 번짐, 남은 단계는 `--surface-3` 테두리. 연결선은 끝난 구간 보라, 나머지 `--border`.
- 진행 막대: `linear-gradient(90deg, #7C4DF0, #19B8A2)`(보라→민트), 바탕 `--surface-3`.
- 현황 타일: 흰 카드 + 숫자 `--font-display` 800; "예상 비용" 타일 숫자만 보라.
- 활동 기록의 단계 태그: `--accent-soft`/`--accent`. 경고 줄 살구, 오류 줄 코랄.
- 계획 검토 띠·종료 카드: 정보 `--accent-soft`, 주의 `--warning-soft`, 오류 `--critical-soft`.

### 4.7 결과 화면
- 탭: 선택 탭 글자 보라 700 + 아래 3px `--grad-primary` 막대.
- 보고서 본문: 제목(h1~h3) `--font-display` + 굵기 800/700, h2 왼쪽에 3px 보라 막대는 넣지 않는다(깔끔하게). 링크 보라.
- 인용 칩 `.cite`: 바탕 `--accent-soft`, 글자 `--accent` 600; 호버 시 바탕 `#E0D6FE`.
- 목차: 현재 항목 보라 + `--accent-soft`.
- 근거 표·필터·차트는 토큰만으로 따라온다. 판정 배지: 지지 민트, 부분 살구, 불일치 코랄.

### 4.8 창·알림·메뉴
- 모달: 모서리 `--r-xl`, 제목 `--font-display` 700; 가림막 `--scrim`.
- 토스트: 바탕 `#221A3D`, 흰 글자, 모서리 `--r-lg`; 성공 아이콘 민트 `#3FD4BF`, 오류 코랄 `#FF8370`.
- 메뉴·팝오버: 모서리 `--r-lg`, `--shadow-pop`.
- 위쪽 띠(테스트 모드 등): 바탕 `--accent-soft`, 글자 `--text`.
- 시작 오류·탭 안내 카드: 로고 타일 그라데이션.

## 5. 확인할 것
- `data-skin="classic"`이면 지금 디자인과 완전히 같다(공용 파일의 규칙을 바꾸지 않았는지 `git diff`로 확인; 새 마크업은 classic에서 `display: none`).
- 라벤더: 밝은/어두운 화면 모두에서 글자 대비 AA, 초점 표시가 보인다, 375px에서 가로 스크롤 없음, 움직임 줄이기 설정 존중.
- 글꼴 파일이 200으로 오고(`assets/fonts/…`), 글꼴이 늦게 와도 글자가 먼저 보인다(`swap`).
- `node --test tests/` 128개 통과, 인라인 스크립트 없음.
