# 화면 배치 2차 (LAYOUT_V2)

사용자 요청(2026-11-20):
1. 모델 선택, 조사 깊이, 결과물 선택, 고급 설정을 **오른쪽 사이드바**에 둔다.
2. 검색 시작 연도, 보고서 언어 등 고급 설정을 **접었다 펴는 형태가 아니라** 오른쪽 사이드바에 항상 보이게 둔다.
3. **왼쪽 기록 목록과 사이드바는 없앤다.**
4. 처음 화면 **아래쪽에 지난 조사 기록과 프롬프트 입력**을 둔다.
5. **왼쪽의 설정 아이콘**을 누르면 API 키를 입력하는 창이 열린다.

기능(동작·문구·검증 규칙·백엔드 호출)은 그대로 두고 **배치만** 바꾼다. 색·글꼴·간격은 `tokens.css` 토큰과 기존 구성 요소(.btn, .card, .chip, .seg, .switch, .tag, 모달, 토스트)를 그대로 쓴다.

## 1. 전체 틀 (셸)

```
┌────┬───────────────────────────────────────┬──────────────────┐
│rail│ .home-main                            │ aside            │
│로고│  .home-top  안내 카드 · 제목            │ .settings-panel  │
│ ＋ │                                       │  모델            │
│    │  .home-bottom                         │  조사 깊이        │
│    │   최근 조사 (검색 · 조사 파일 열기)      │  결과물           │
│    │   ▢ ▢ ▢ 기록 카드                      │  옵션             │
│ ？ │   주제 다듬기 결과                      │  고급 설정(펼침)   │
│ ⚙ │   ┌ .composer ──────────────────────┐ │   …              │
│ ☾ │   │ 프롬프트 …        [조사 시작]     │ │  ── 예상치(고정)  │
│    │   └──────────────────────────────────┘ │                  │
└────┴───────────────────────────────────────┴──────────────────┘
```

DOM:

```
a.skip-link
div.app                                  grid: var(--rail-w) minmax(0,1fr)
 ├ nav.rail  aria-label="주 메뉴"
 └ div.app-main
     ├ div.banners                       테스트 모드 · 저장 불가 띠(그대로)
     └ main#main.main > div.view
```

- `--rail-w: 56px`는 `app.css` 0번(파생 변수)에 둔다(`tokens.css`는 고치지 않는다). `--sidebar-w`는 더 쓰지 않는다.
- `.main`의 좌우·위 여백은 없앤다(0). 여백은 화면이 정한다: `.page`(진행·결과)는 `padding: var(--sp-8) var(--page-pad) var(--sp-12)`, 처음 화면 `.home`은 스스로 여백을 잡는다.
- `body[data-view]`: 라우터가 `home` 또는 `run`으로 맞춘다(CSS 분기용).

### 1.1 왼쪽 레일 `nav.rail`
세로 아이콘 줄(폭 56px, `position: sticky; top: 0; height: 100dvh`). 모든 항목은 `title`과 `aria-label`이 있는 아이콘 버튼(40×40)이다.

위에서부터:
1. 로고 — `a href="#/"`, aria-label "AI Research Agent 처음 화면".
2. 새 조사 — `a href="#/"`, 아이콘 `plus`, aria-label "새 조사". 이미 `#/`이면 화면을 다시 그린다(지금 `newBtn`과 같은 동작).
3. (빈 공간, `margin-top: auto`)
4. 도움말 — 아이콘 `help`, `openHelp()`.
5. **설정** — 아이콘 `settings`(톱니; `ui.js` ICONS에 없으면 추가), 누르면 `openKeyDialog()`. 아이콘 오른쪽 위에 키 상태 점(`status-dot tone-*`, 지금 `keyButton`의 색 규칙). aria-label은 "설정: API 키 입력, <상태 문구>". 키가 없으면 점이 눈에 띄게(tone-warning) 보인다.
6. 테마 — 아이콘 버튼 하나, 누를 때마다 라이트 → 다크 → 시스템 순환. 아이콘은 현재 값(sun/moon/monitor), aria-label "테마: 라이트(누르면 다크)" 식.

### 1.2 설정 창 (기존 `openKeyDialog`)
- 함수 이름·인자·반환값은 그대로(`openKeyDialog(opts)`): 여러 화면이 부른다.
- 제목을 **"설정"**으로, 본문을 두 구역으로: **API 키**(지금 내용 전부: 안내, 입력, 보기 버튼, "이 브라우저에 저장", 상태, 데모 버튼) / **화면 테마**(지금 `themeControl()`의 3칸 세그먼트).
- 아래 버튼(지우기 · 닫기 · 확인)과 Enter 동작은 그대로.

### 1.3 좁은 화면 (≤ 899px)
- `.app`은 block. `nav.rail`은 **위쪽 가로 바**가 된다(`position: sticky; top: 0; height: var(--topbar-h)`, 가로 정렬: 로고 · 워드마크 글자 · (빈 공간) · 새 조사 · 도움말 · 설정 · 테마). 서랍(drawer)·가림막(scrim)·메뉴 버튼은 없앤다.
- `result.css`의 `--r-top: var(--topbar-h)` 규칙이 계속 맞도록 `--topbar-h`는 유지한다.

### 1.4 진행·결과 화면에서 돌아가기
왼쪽 기록이 없어졌으므로, 라우터가 `run` 화면을 그릴 때 `.view` 맨 위(화면 내용 앞)에 `a.back-link[href="#/"]` "← 처음 화면"(아이콘 `arrow-left`, 없으면 `chevron-left` 또는 추가)을 넣는다. `.page`와 같은 최대 폭·좌우 여백에 맞춘다. `run.js`·`result.js`는 고치지 않는다.

## 2. 기록 모듈 `assets/js/history.js` (새 파일)

`main.js`의 기록 관련 코드(목록, 검색, 항목 메뉴, 이름 바꾸기, 조사 파일 저장, 삭제, 태그)를 옮긴다.

```js
export function mountHistory(opts = {}) -> { el: HTMLElement, destroy(): void }
// opts.limit (기본 6): 처음에 보여 줄 개수
```

`el` 구조:

```
section.home-history  aria-label="조사 기록"
 ├ div.hh-head
 │   ├ h2.hh-title "최근 조사"  + span.hh-count (전체 개수)
 │   └ div.hh-tools: 검색 입력(.hist-search 그대로) · "조사 파일 열기" 버튼 · 새로 고침 버튼
 ├ ul.hist-list.hist-grid        카드 격자: repeat(auto-fill, minmax(260px, 1fr))
 └ button.hh-more "기록 모두 보기 (N개)" / "접기"   (limit보다 많을 때만)
```

- 항목(`li.hist-li > a.hist-item + button.hist-more`)의 내용·태그·메뉴·동작은 지금과 같다. 카드 모양(테두리, 배경 `--surface`)으로만 바꾼다. 메뉴 버튼은 항목 오른쪽 위(`.hist-li > .hist-more { position: absolute }`).
- 최신순. 검색어가 있으면 `limit`을 무시하고 일치 항목을 모두 보여 준다. 펼침 상태는 `store`의 `historyExpanded`(메모리)로 기억한다.
- 비어 있을 때: "아직 조사 기록이 없습니다. 주제를 적고 첫 조사를 시작해 보세요." / 검색 결과 없음: "검색 결과가 없습니다". 불러오는 중: 스켈레톤.
- "조사 파일 열기"는 `main.js`가 내보내는 `pickRunFile()`을 부른다(숨은 file input과 가져오기 로직, 창 전체 끌어다 놓기는 `main.js`에 남긴다).
- 삭제 뒤에는 목록만 새로 고친다(처음 화면에 있으므로 이동 없음).
- `destroy()`는 store 구독과 타이머를 정리한다.

`main.js`가 내보내는 것: `navigate`, `openKeyDialog`, `refreshRuns`, `pickRunFile`.

## 3. 처음 화면 `views/compose.js` (`#/`)

```
div.home
 ├ div.home-main
 │   ├ div.home-top
 │   │   ├ 처음 사용 안내 카드(onboarding, 그대로)
 │   │   ├ header.page-head (h1 "무엇을 조사할까요?" + 설명)
 │   │   └ 미리 채움 안내(note)
 │   └ div.home-bottom
 │       ├ mountHistory().el
 │       ├ div.refine-slot            주제 다듬기 결과
 │       └ div.composer               position: sticky; bottom: 0
 │           ├ div.prompt-card        textarea · 예시 칩 · 주제 다듬기 · 글자 수
 │           ├ 오류 칸(prompt, run)
 │           └ div.composer-foot
 │               ├ button.panel-toggle  "조사 설정" (좁은 화면에서만 보임)
 │               ├ div.composer-est     한 줄 예상치: "약 $4.45 · 12~24분 · 한도 $7"
 │               ├ span.kbd-hint        Ctrl + Enter
 │               └ button.btn-start     "조사 시작"
 └ aside.settings-panel  aria-label="조사 설정"
     ├ div.sp-head   h2 "조사 설정" (+ 좁은 화면: 닫기 버튼)
     ├ div.sp-body   (세로 스크롤)
     │   ├ section.sp-sec  모델          (키 확인 실패 안내, 모델 목록, 사용 불가 안내, 오류 칸)
     │   ├ section.sp-sec  조사 깊이
     │   ├ section.sp-sec  결과물        (오류 칸)
     │   ├ section.sp-sec  옵션          (계획 먼저 검토 · 끝나면 알림)
     │   └ section.sp-sec  고급 설정     항상 펼쳐 둠: 검색 시작 연도 · 보고서 언어 · 최대 비용 · 숫자 5개
     └ div.sp-foot   예상치 자세히(LLM 호출 · 시간 · 비용 · 한도 + 기준 문구), 패널 아래 고정
```

- `.home`: `display: grid; grid-template-columns: minmax(0, 1fr) var(--panel-w); min-height: calc(100dvh - 띠 높이)`. `--panel-w: 360px`(home.css).
- `.home-main`: `display: flex; flex-direction: column; min-height: 100dvh; padding: var(--sp-8) var(--page-pad) 0; max-width: 980px; margin: 0 auto; width: 100%`. `.home-bottom { margin-top: auto }` — 기록과 프롬프트가 화면 **아래쪽**에 붙는다. 내용이 길면 가운데 열이 스크롤되고 `.composer`는 아래에 붙어 있다(배경을 깔아 뒤 내용이 비치지 않게, 위쪽에 옅은 그림자·페이드).
- `.settings-panel`: `position: sticky; top: 0; height: 100dvh; display: flex; flex-direction: column; border-left: 1px solid var(--border); background: var(--surface)`. `.sp-body { flex: 1; overflow-y: auto }`.
- **접는 요소(`<details>`)를 쓰지 않는다.** "고급 설정"은 구역 제목일 뿐이고 모든 칸이 항상 보인다. `advanced.open`·`advSummary` 같은 접힘 관련 코드는 없앤다(프리셋과 다른 값에 붙는 "직접 설정" 표시는 유지).
- 패널이 좁으므로 조밀하게: 모델·깊이는 **세로 라디오 줄**(한 줄에 이름 · 배지 · 가격/시간, 아래 작은 설명), 결과물은 그룹별 칩, 숫자 칸은 "이름 — 스테퍼" 한 줄씩(설명은 작은 글씨 한 줄 또는 title), 옵션은 스위치 줄.
- 예상치: 자세한 내용은 `.sp-foot`, 한 줄 요약은 `.composer-est`(둘 다 같은 계산, 같이 갱신).
- 실행 줄(`.run-bar`)은 없앤다. 토스트가 프롬프트를 가리지 않도록 `body.has-runbar` 클래스는 계속 붙인다(토스트 위치 규칙 재사용).
- Ctrl+Enter, 초안 저장, 미리 채움, 검증·오류 표시(오류가 난 칸으로 스크롤: 패널 안의 칸이면 패널을 연 뒤 그 칸으로), 주제 다듬기, 데모 시작, 알림 스위치, 비용 한도 로직은 그대로.
- 처음 화면에 들어오면 프롬프트 입력에 초점(지금과 같음).

### 3.1 좁은 화면 (≤ 1099px)
- `.home`은 한 열. `.settings-panel`은 오른쪽에서 나오는 시트(`position: fixed; right: 0; top: 0; bottom: 0; width: min(380px, 92vw)`, 닫혀 있으면 `visibility: hidden` + `translateX(100%)`), 가림막 `.sp-scrim`.
- `.panel-toggle`("조사 설정", 아이콘 `sliders`, 옆에 현재 선택 요약 "Opus 5.5 · 표준")로 연다. `aria-expanded`, `aria-controls`. Esc·가림막·닫기 버튼으로 닫고 초점을 토글 버튼으로 돌려준다. 열릴 때 패널 제목으로 초점.
- 넓은 화면에서는 `.panel-toggle`과 닫기 버튼을 숨긴다.

## 4. 스타일 파일
- `assets/app.css`(셸 담당): 2번 셸(레일), 기록 카드(.hist-*, .hh-*), 설정 창, 돌아가기 링크, 반응형의 셸 부분. 사이드바·서랍·위쪽 바 전용 규칙은 지운다.
- `assets/home.css`(처음 화면 담당, 새 파일): `.home*`, `.settings-panel`/`.sp-*`, `.composer*`, 패널용 조밀한 선택 줄. `index.html`에서 `app.css` 다음, `result.css` 앞에 연결한다. 기존 19번(작성 화면) 규칙 가운데 새 배치와 충돌하는 것은 home.css에서 덮어쓴다(app.css는 고치지 않는다).
- 다크 모드·움직임 줄이기 설정·키보드 초점 표시를 유지한다. 375px 폭에서 가로 스크롤이 생기지 않아야 한다.

## 5. 확인할 것
- 수정한 JS마다 `node --input-type=module --check < 파일` 무출력, `node --test tests/` 통과.
- `index.html`의 CSP·상대 경로 유지, 인라인 스크립트 없음.
- 부모 폴더에서 정적 서버로 띄워 `…/ai-research-agent/`와 새 파일이 200으로 오는지.
