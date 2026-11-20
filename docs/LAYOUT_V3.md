# 화면 배치 3차 (LAYOUT_V3)

사용자 의견(2026-11-20): "디자인이 너무 별로다."
1. 오른쪽 사이드바의 선택 사항을 **체크 형태로 깔끔하게** 배치한다. 각 선택 분야를 **블록으로 만들어 명확히 구분**하고, **크기를 줄여 메인 화면에 여유**를 준다.
2. 왼쪽에 **펼치고 닫을 수 있는 사이드바**를 만들어 그동안의 **조사 목록**을 볼 수 있게 한다.

LAYOUT_V2에서 바뀌는 점만 적는다. 동작·검증·백엔드 호출·저장 키는 그대로다. 색·간격·모서리는 `tokens.css` 변수만 쓴다.

```
┌─────────────┬──────────────────────────────┬──────────────┐
│ 로고   [«]  │                              │ 조사 설정     │
│ [＋ 새 조사] │                              │ ┌ 모델 ────┐ │
│ 기록  [↻]   │      무엇을 조사할까요?       │ │ ✓ Opus   │ │
│ [검색]      │      (처음 사용 안내)         │ │ ○ Sonnet │ │
│ · 기록 1    │                              │ └──────────┘ │
│ · 기록 2    │                              │ ┌ 조사 깊이 ┐ │
│             │ ┌──────────────────────────┐ │ └──────────┘ │
│ 파일 열기 ? │ │ 연구 주제…    [조사 시작] │ │ ┌ 결과물 ──┐ │
│ ⚙ 설정  ☾  │ └──────────────────────────┘ │ └──────────┘ │
└─────────────┴──────────────────────────────┴──────────────┘
   펼침 264px ↔ 접힘 56px(아이콘 줄)             296px
```

## 1. 왼쪽 사이드바 (셸 담당: main.js, history.js, store.js, ui.js 아이콘, app.css)

`nav.rail`을 **`aside.side`** 하나로 바꾼다. 펼친 상태와 접은 상태가 있다.

```
div.app  (.is-side-open 이면 펼침)          display: flex
 ├ aside.side#side  aria-label="사이드바"   width: var(--rail-w) → 펼치면 var(--side-w)
 ├ div.side-scrim                           좁은 화면 서랍용 가림막
 └ div.app-main (flex: 1; min-width: 0)
     ├ header.topbar                        ≤899px에서만 보임: 메뉴 버튼 · 로고 · 워드마크 · 새 조사
     ├ div.banners
     └ main#main.main > div.view
```

- `--side-w: 264px`, `--rail-w: 56px`(app.css 0번). `aside.side`는 `position: sticky; top: 0; height: 100dvh; display: flex; flex-direction: column; background: var(--surface); border-right: 1px solid var(--border); transition: width 200ms var(--ease)`(움직임 줄이기 설정이면 전환 없음). 내용이 접히는 동안 넘치지 않게 `overflow: hidden`.
- **상태 저장**: `prefs.sidebarOpen`(boolean, `savePrefs`). 저장값이 없으면 `window.innerWidth >= 1280`일 때 펼침으로 시작한다. 좁은 화면(≤899px) 서랍은 저장하지 않고 늘 닫힌 채 시작한다.

### 1.1 펼친 상태 (264px)
위에서부터:
1. `div.side-head`(높이 56px): `a.wordmark[href="#/"]`(로고 + "AI Research Agent") · `button.side-toggle`(아이콘 `panel-left-close` 또는 `chevrons-left`, aria-label "사이드바 접기", `aria-expanded="true"`, `aria-controls="side"`).
2. `a.btn.btn-primary.side-new[href="#/"]` "＋ 새 조사"(가로 꽉 차게). 이미 `#/`이면 화면을 다시 그린다.
3. `mountHistory().el` — 기록(아래 1.3). 남는 높이를 차지하고 목록만 스크롤된다.
4. `div.side-foot`:
   - `div.side-tools`: "조사 파일 열기"(`pickRunFile()`), "도움말"(`openHelp()`) — 작은 ghost 버튼 2개.
   - `button.side-key` — 설정 창을 여는 한 줄 버튼: 톱니 아이콘 + 상태 점, "설정 · API 키 ··1234", 아래 작은 글씨로 상태 문구(예: "확인됨 · 모델 4개 사용 가능"/"조사를 시작하려면 필요합니다"). `openKeyDialog()`.
   - 테마: 3칸 세그먼트(라이트/다크/시스템, 아이콘만) — 설정 창의 것과 같은 상태를 쓴다.

### 1.2 접은 상태 (56px 아이콘 줄)
같은 요소에서 글자를 숨기고 아이콘만 남긴다(40×40 버튼, `title`·`aria-label` 유지):
로고 → `side-toggle`(아이콘 `panel-left-open` 또는 `chevrons-right`, aria-label "사이드바 펼치기 (조사 기록)", `aria-expanded="false"`) → 새 조사(＋) → (빈 공간) → 도움말 → 설정(톱니 + 상태 점) → 테마(누를 때마다 순환하는 버튼 하나).
기록 목록·검색·"조사 파일 열기"는 접은 상태에서 보이지 않고 초점도 받지 않는다(`hidden` 또는 `inert`). 접은 상태에서 기록이 궁금하면 토글을 누른다.

### 1.3 기록 `mountHistory()` (history.js)
카드 격자·"모두 보기"를 없애고 **사이드바용 세로 목록 하나**로 만든다.

```
section.side-history  aria-label="조사 기록"
 ├ div.sh-head: span.sh-title "기록" + span.sh-count · button(새로 고침, 아이콘만)
 ├ div.hist-search (그대로)
 └ ul.hist-list   flex: 1; overflow-y: auto
     └ li.hist-li > a.hist-item + button.hist-more   (항목 내용·태그·메뉴 동작 그대로)
```
- 항목은 한 줄 카드가 아니라 **목록 줄**: 상태 점 · 제목(최대 2줄) · 아래 줄(태그 + 모델·시간). 메뉴 버튼은 줄 오른쪽 위(호버·초점·터치에서 보임).
- **지금 보고 있는 실행**을 표시한다(`is-current`, `aria-current="page"`): `hashchange`와 목록 갱신 때 맞춘다.
- `limit`/`historyExpanded`는 더 쓰지 않는다(전부 보여 주고 스크롤). 삭제한 실행을 보고 있었으면 `#/`로 이동한다.

### 1.4 좁은 화면 (≤ 899px)
- `header.topbar`(높이 `--topbar-h`, sticky)가 보인다: 메뉴 버튼(`aria-controls="side"`, `aria-expanded`) · 로고 · 워드마크 · "새 조사". `aside.side`는 화면 밖 서랍(`position: fixed; left: 0; top: 0; bottom: 0; width: min(var(--side-w), 86vw); transform: translateX(-100%)`), 열리면 `body.drawer-open` + `.side-scrim` 표시. 서랍은 늘 **펼친 모양**이다.
- Esc·가림막·닫기 버튼·화면 이동으로 닫고 초점을 메뉴 버튼으로 돌려준다. 열려 있는 동안 뒤쪽(`.app-main`)은 `inert`.
- `result.js`가 `.topbar` 높이를 재므로 클래스 이름 `topbar`를 유지한다(지금 레일에 붙이던 표시 클래스는 없앤다).

### 1.5 그 밖
- 진행·결과 화면의 "← 처음 화면" 링크는 그대로 둔다.
- `body[data-view]`, 띠, 탭 잠금·넘겨받기, 끌어다 놓기 가져오기, 설정 창(`openKeyDialog`)은 그대로.

## 2. 오른쪽 조사 설정 패널 (처음 화면 담당: views/compose.js, onboarding.js, home.css)

목표: **폭 296px**(`--panel-w: 296px`), 분야마다 **블록(카드)**, 선택은 **체크 줄**, 설명 문장은 화면에서 빼고 `title` 풀이말로. 한눈에 훑을 수 있게 조밀하고 정돈되게.

```
aside.settings-panel            배경 var(--bg), 왼쪽 테두리
 ├ div.sp-head  (높이 44px)  h2 "조사 설정" (+ 좁은 화면: 닫기)
 ├ div.sp-body  (padding 12px; 블록 사이 10px; 세로 스크롤)
 │   ├ section.sp-block  모델
 │   ├ section.sp-block  조사 깊이
 │   ├ section.sp-block  결과물
 │   ├ section.sp-block  옵션
 │   └ section.sp-block  고급 설정
 └ div.sp-foot  예상치(2줄 + 작은 기준 문구)
```

### 2.1 블록
```css
.sp-block { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-md); padding: 10px 12px; }
.sp-block + .sp-block { margin-top: 10px; }
.sp-block-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.sp-block-title { font-size: var(--fs-13); font-weight: 700; color: var(--text); }
.sp-block-aside { font-size: 0.71875rem; color: var(--text-3); white-space: nowrap; }   /* 11.5px */
```
블록 머리 오른쪽(`sp-block-aside`)에는 짧은 보조 정보만: 모델 "입력 · 출력 / 100만 토큰", 조사 깊이 "예상 시간", 결과물 "n개 선택", 고급 설정은 바꾼 값이 있으면 `button.link-btn` "기본값으로"(모든 직접 설정과 비용 한도를 기본으로 되돌림), 없으면 비움.

### 2.2 체크 줄 (모델 · 깊이 · 결과물 · 옵션 공통)
`label.ck` 안에 숨긴 input(`.sr-only`)과 체크 상자를 둔다. 하나만 고르는 것은 `type=radio`(상자 모양 **원**), 여러 개 고르는 것은 `type=checkbox`(상자 모양 **둥근 사각형**). 둘 다 선택되면 강조색으로 채우고 흰 체크 표시(`icon('check', 11)`)를 보인다.

```css
.ck-list { display: flex; flex-direction: column; gap: 2px; margin: 0 -4px; }
.ck-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 4px; margin: 0 -4px; }
.ck { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 30px; padding: 3px 8px;
      border-radius: var(--r-sm); cursor: pointer; font-size: var(--fs-13); color: var(--text);
      transition: background var(--dur) var(--ease); }
.ck:hover { background: var(--surface-2); }
.ck.is-selected { background: var(--accent-soft); }
.ck-box { flex: none; width: 16px; height: 16px; display: grid; place-items: center;
          border: 1.5px solid var(--border-strong); border-radius: 4px; background: var(--surface); color: transparent; }
.ck-radio .ck-box { border-radius: 50%; }
.ck.is-selected .ck-box { background: var(--accent); border-color: var(--accent); color: var(--text-on-accent); }
.ck-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ck.is-selected .ck-label { font-weight: 600; }
.ck-meta { flex: none; font-size: var(--fs-12); color: var(--text-3); font-variant-numeric: tabular-nums; white-space: nowrap; }
.ck.is-disabled { opacity: 0.5; cursor: not-allowed; }
.ck:has(input:focus-visible) { box-shadow: var(--focus-ring); }
```
`role=radiogroup` + `aria-label`은 유지하고, 다시 그린 뒤 초점을 선택된 input으로 돌려주는 지금 동작도 유지한다.

- **모델**(`.ck-list`, radio): `[✓] Claude Opus 5.5 [추천]            $4 · $20`. 배지는 지금 `badge-accent`를 작게. 한 줄 설명(tagline)은 줄에서 빼고 `title`에 "tagline — description"으로. 이 키로 쓸 수 없는 모델은 `is-disabled` + 오른쪽에 "사용 불가". 키 확인 실패 안내·모델 바뀜 안내·오류 칸은 블록 안 목록 위/아래에 그대로 둔다.
- **조사 깊이**(`.ck-list`, radio): `[✓] 표준                12~24분`. 설명은 `title`.
- **결과물**(`.ck-grid`, checkbox, 2열): 짧은 이름으로 — md "Markdown", html "HTML", pdf "PDF", docx "Word", pptx "PowerPoint", bib "BibTeX", ris "RIS", csv "CSV", json "JSON"(목록에 없는 id는 설정의 label). `title`에는 원래 label과 설명. 순서는 지금 그룹 순서(보고서 → 발표 → 참고문헌·데이터), 그룹 제목은 없앤다. "최소 1개" 규칙과 오류 칸은 그대로. PDF를 골랐을 때만 블록 맨 아래 한 줄 안내(11.5px, `var(--text-3)`): "PDF는 인쇄 창에서 'PDF로 저장'으로 만듭니다."
- **옵션**(`.ck-list`, checkbox): "계획 먼저 검토"(title: 지금 설명 문장), "끝나면 알림"(title: 지금 설명 문장; 알림을 지원하지 않으면 숨김). 스위치 대신 체크 줄을 쓰되 `st.hitl`, `toggleNotify()` 권한 흐름은 그대로.

### 2.3 고급 설정 블록 (항상 펼쳐 둠)
한 줄에 "이름 — 조작부". 설명 문장은 이름의 `title`과 `aria-describedby`가 가리키는 `.sr-only` 문장으로 옮긴다.

```css
.adv-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 30px; }
.adv-row + .adv-row { margin-top: 4px; }
.adv-row-label { font-size: var(--fs-13); color: var(--text-2); white-space: nowrap; }
.adv-row.is-custom .adv-row-label::after { content: ""; display: inline-block; width: 5px; height: 5px; margin-left: 5px;
                                           border-radius: 50%; background: var(--accent); vertical-align: middle; }
```
- 검색 시작 연도: 작은 세그먼트 `자동 | 제한 없음 | 직접`(높이 26px, 글자 12px). "직접"이면 바로 아래 줄에 `[2022] 년 이후` 입력과 오류 칸.
- 보고서 언어: 세그먼트 `자동 | 한국어 | 영어`.
- 최대 비용: `$ [7]` + 체크 "한도 없음"(작은 `.ck` 하나, 줄 안에).
- 숫자 5개(재조사 횟수 · 검색 라운드 · 검색당 문헌 수 · 인용 검증 문장 · 병렬 실행 수): 작은 스테퍼 `[−] 2 [+]`(높이 26px). 프리셋과 다른 값이면 `is-custom`(이름 옆 강조색 점). 단위·범위·설명은 `title`.
- 블록 맨 아래 한 줄(11.5px): "한도에 닿으면 추가 조사를 멈추고 그때까지 모은 근거로 보고서를 씁니다."

### 2.4 아래 고정 예상치 `.sp-foot`
```
약 $4.45 · 12~24분                    ← 13px, 굵게
LLM 호출 약 77회 · 한도 $7             ← 12px, var(--text-2)
실제 실행 2회 평균 · 가격 기준 2026-11-03  ← 11.5px, var(--text-3)
```
padding 10px 14px, 위 테두리, 배경 `var(--surface)`.

### 2.5 좁은 화면
≤1099px에서는 지금처럼 오른쪽 시트(폭 `min(320px, 92vw)`), `.panel-toggle`로 연다. 동작은 그대로.

## 3. 처음 화면 가운데 열 (처음 화면 담당)
- **기록 카드를 가운데 열에서 뺀다**(`mountHistory` 호출과 `.home-history` 관련 스타일 제거): 기록은 왼쪽 사이드바에 있다.
- `.home-main`: `max-width: 860px`. `.home-top`(안내 카드 + 제목)은 남는 세로 공간의 **가운데**에 둔다(`margin: auto 0`). 제목 `h1`과 설명은 가운데 정렬. 안내 카드는 폭을 다 쓴다.
- `.home-bottom`: 주제 다듬기 결과 → `.composer`(아래 고정, 지금 구조 그대로). 시작 버튼·한 줄 예상치·`Ctrl+Enter`·좁은 화면의 "조사 설정" 버튼 그대로.
- 미리 채움 안내, 오류 칸, 초점·스크롤 처리(scroll-padding, 다듬기 결과 보이기)는 그대로.

## 4. 확인할 것
- 수정한 JS마다 `node --input-type=module --check < 파일` 무출력, `node --test tests/` 128개 통과.
- 1366×768에서 처음 화면이 스크롤 없이 들어온다(사이드바 펼침 264 + 가운데 + 패널 296).
- 375px 폭에서 가로 스크롤 없음, 다크 모드, 움직임 줄이기, 키보드 초점 표시.
