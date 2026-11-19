# 웹사이트 버전 화면 변경과 편의 기능 (front 담당 명세)

기존 화면 명세 `docs/FRONTEND.md`(동작·디자인 시스템)는 그대로 유효하다. 이 문서는 **브라우저 버전으로 바뀌는 점**과 **새 편의 기능**의 동작을 정한다.
백엔드 계약은 `docs/SITE_SPEC.md` 5장(`createBackend`의 메서드와 반환 모양)이다. 디자인(색·글꼴·간격)은 바꾸지 않는다: 새 요소도 `tokens.css`의 토큰과
`app.css`의 기존 구성 요소(.btn, .card, .chip, .badge, .switch, 모달, 토스트 …)를 그대로 쓴다.

## 담당 나누기

| 담당 | 파일 | 기능 |
|---|---|---|
| **FA (셸·작성)** | `index.html`, `assets/js/api.js`, `store.js`, `main.js`, `ui.js`, `views/compose.js`, `assets/app.css` | W0, F1, F2, F4(작성 화면 스위치), F5(작성 화면), F6(열기), F7, F9 |
| **FB (진행·결과)** | `views/run.js`, `views/result.js`, `charts.js`, `assets/result.css`, 새 파일 `assets/js/notify.js`, `assets/js/views/rewrite.js`, `assets/run.css`(필요하면, index.html 연결은 FA에게 요청하지 말고 result.css에 넣는다) | F3, F4(알림 실행), F5(진행 화면), F6(저장), F8 |

- 공용 도우미가 더 필요하면 FB는 `ui.js`를 고치지 말고 자기 새 파일에 만든다. FA가 `ui.js`에 새로 만든 것을 FB가 써도 된다(작업이 동시에 진행되므로 기존 export만 믿고 쓴다).
- 저장소 키(`store.js`) 약속: `prefs.notify`(boolean, FA가 작성 화면 스위치로 바꿈, FB가 읽음), `prefs.maxCost`(number|null), `prefs.demoSpeed`(1|5),
  `onboarding.dismissed`(boolean). 키 보관은 기존 규칙(sessionStorage, 옵트인 시 localStorage) 그대로.

## W0. 정적 사이트로 옮기기 [FA]
- `index.html`: 경로를 전부 상대 경로로(`./assets/…`), 웹폰트 CDN 링크 삭제, `SITE_SPEC.md` 6장의 CSP `<meta http-equiv="Content-Security-Policy">` 추가.
  인라인 `<script>`(테마 깜박임 방지 등)는 CSP 때문에 실행되지 않으므로 `assets/js/boot.js` 같은 별도 파일로 옮겨 `<script src>`로 부른다(동기 실행이 필요하면 type="module" 아님).
  파비콘 data URL은 그대로 둬도 된다(img-src data:).
- `api.js`: 지금과 같은 이름(`api`, `ApiError`, `exportUrl` 대신 쓰던 곳은 새 함수로, `download`)을 유지하고 내부를 `createBackend({ storage: new IndexedDBStorage(), llmFactory, tools: TOOL_FUNCS, loadSample })`로 바꾼다.
  - 오류: `BackendError(code, message, status)` → 기존 `ApiError`로 변환. 화면 코드의 `catch` 흐름은 그대로 동작해야 한다.
  - `download(id, fmt)`: `backend.exportFile` → Blob → 임시 `a[download]`로 저장 → `URL.revokeObjectURL`. 반환값은 파일 이름.
  - PDF(`print: true`): 클릭 핸들러 안에서 `window.open('', '_blank')`로 새 창을 열고 HTML을 써 넣은 뒤(스크립트 없음) 로드가 끝나면 그 창의 `print()`를 부른다. 팝업이 막히면 HTML 파일로 내려받고 "파일을 열어 인쇄 → PDF로 저장" 안내.
  - 인쇄용 HTML 보기(기존 `?inline=1`)도 같은 방식으로 새 창.
  - `?mock=1`: `tests/fakes.js`의 `FakeLLM`(`delay` 300ms, `webSearch: true`)과 `makeFakeTools({ fail: [] })`를 쓰는 백엔드, 저장소는 `MemoryStorage`(새로고침하면 사라짐), 화면 위에 "테스트 모드 — 실제 API를 호출하지 않습니다" 띠.
- 서버 전용 개념 정리: `config.demo`(서버 전체 데모)·`server_key`는 이제 항상 false다. 데모는 **실행마다 고르는 방식**이다(F1·F9). 기존 "데모 모드" 띠는 없앤다.
- 키 창 문구: "API 키는 이 브라우저에만 저장되고 Anthropic API(api.anthropic.com)로만 전송됩니다. 이 사이트에는 서버가 없습니다." + 키 발급 링크
  `https://console.anthropic.com/settings/keys`(새 탭, `rel="noopener noreferrer"`). 키 확인은 `backend.checkKey`.

## F1. 처음 사용 안내와 데모 바로 보기 [FA]
- `onboarding.dismissed`가 없으면 작성 화면 맨 위에 "처음 사용하시나요?" 카드(닫기 ×, "다시 보지 않기"):
  1. **데모로 둘러보기** — 버튼 2개 "데모 실행 (약 45초)", "빠르게 (약 10초)": 키 없이 첫 번째 샘플 주제로 데모 실행을 바로 시작(`createRun({ demo: true, demo_speed, prompt: 샘플 주제, … })`).
  2. **API 키 등록** — 키 창 열기 버튼, 등록되면 체크 표시와 "등록됨".
  3. **주제를 적고 조사 시작** — 한 줄 안내: "표준 깊이 + Claude Opus 5.5 기준 약 12~24분, 약 $4(본인 키로 과금). 처음에는 '빠르게' + Claude Haiku 5.5로 시험해 보세요."
- 사이드바 아래쪽에 "도움말" 버튼 → 같은 카드를 다시 보여 준다(모달로 띄워도 된다).
- 키가 없는데 "조사 시작"을 누르면: 키 창을 열되, 창 안에 "키 없이 데모로 보기" 버튼도 둔다(지금 입력한 주제는 그대로 두고 샘플 재생임을 밝힌다).

## F2. 주제 다듬기 [FA]
- 프롬프트 카드 아래 줄(예시 칩 옆)에 "주제 다듬기" 버튼(아이콘 SVG). 프롬프트 10자 이상이고 키가 있을 때 사용 가능; 아니면 비활성 + 이유 툴팁(키 없음이면 클릭 시 키 창).
- 누르면 버튼에 진행 표시 → `backend.refinePrompt({ api_key, prompt, language })` → 프롬프트 카드 바로 아래 패널:
  제안 3개(카드: 초점 라벨 배지, 다듬은 프롬프트, 한 줄 이유, "이걸로 바꾸기"·"아래에 덧붙이기"), `questions`가 있으면 "정해 두면 좋은 점" 목록, 닫기.
  "이걸로 바꾸기"는 원래 글을 되돌릴 수 있게 토스트에 "되돌리기" 버튼. 비용 안내 문구: "Claude Haiku 5.5로 다듬습니다(비용은 거의 없습니다)."
- 오류는 패널 안에 한국어 메시지. 진행 중 다시 누르면 무시.

## F3. 실행 보호와 이어서 진행 [FB, 떠나기 경고는 FA의 main.js]
- **떠나기 경고 [FA]**: `backend.hasActiveRuns()`가 참이면 `beforeunload`에서 기본 확인 창이 뜨게 한다.
- 진행 화면 [FB]: 진행 중에는 머리 아래 한 줄 안내 "이 탭을 닫거나 새로고침하면 조사가 멈춥니다. 단계마다 저장되므로 나중에 이어서 진행할 수 있습니다."
- 종료 카드 [FB]: `status`가 `interrupted`/`error`이고 `resumable`이면 주 버튼 **"이어서 진행"**(`backend.resume(id, { api_key })`; 데모 실행은 키 불필요; 키가 없으면 키 창),
  보조 버튼 "처음부터 다시"(같은 설정으로 새 조사 — 기존 "같은 설정으로 다시 조사" 흐름). 이어하기가 시작되면 같은 화면에서 폴링을 다시 시작하고 활동 기록은 이어서 쌓인다.
  `resumable`이 아니면 지금처럼 다시 조사만.
- 기록 목록 [FA]: `resumable`인 항목에 "이어서 가능" 표시.

## F4. 끝나면 알림 [FA 스위치, FB 동작]
- 작성 화면 옵션에 스위치 "끝나면 알림 받기"(`prefs.notify`). 켤 때 `Notification.requestPermission()`; 거부되면 스위치를 끄고 토스트로 이유 안내. 알림을 지원하지 않는 브라우저면 숨김.
- 진행 화면 머리에도 같은 토글(종 아이콘 버튼, `aria-pressed`).
- `assets/js/notify.js` [FB]: `notifyRunEvent(kind, { topic, runId })` — kind `done`·`error`·`awaiting_plan`. 탭이 숨겨져 있고 `prefs.notify`면 데스크톱 알림(클릭하면 창 포커스 + 해당 실행으로 이동)과
  짧은 소리(WebAudio로 0.15초 두 음, 파일 없음). 탭이 보이면 소리만 생략하고 토스트.
- 탭 제목 [FB]: 진행 중 `"(42%) ③ 자료 탐색 — 주제"`, 검토 대기 `"검토 대기 — 주제"`, 완료 `"조사 완료 — 주제"`.

## F5. 비용 한도와 남은 시간 [FA 작성, FB 진행]
- 작성 화면 고급 설정 [FA]: "최대 비용(USD)" 숫자 입력(0.5 단위, 0~100) + "한도 없음" 체크. 기본값 = 선택한 깊이의 예상 비용 × 1.5를 0.5 단위로 올림
  (사용자가 직접 바꾸지 않았다면 모델·깊이를 바꿀 때 다시 계산). 예상치 줄 끝에 "· 한도 $6.5". `createRun`에 `max_cost_usd`로 보낸다(데모는 무시).
  설명: "한도에 닿으면 추가 조사를 멈추고 그때까지 모은 근거로 보고서를 씁니다."
- 진행 화면 [FB]: 카운터 옆 또는 아래에 비용 막대(현재 / 한도, 한도 없으면 막대 없이 금액만). `budget` 이벤트가 오면 경고 카드.
- 남은 시간 [FB]: "약 N분 남음". 단계 가중치(이해 2, 계획 2, 탐색 25, 평가 25, 종합 10, 비판·재조사 20, 보고서 12, 검증 4 — 합 100)와 진행률로 완료 비율을 추정하고,
  경과 시간 ÷ 완료 비율로 남은 시간을 계산한다(처음 1분은 깊이 프리셋의 예상 시간 중간값을 쓴다). 데모는 재생 속도에 맞춰진 실제 경과 시간으로 같은 계산.
  계획 검토 대기 중에는 "검토를 기다리는 중".

## F6. 조사 파일 저장·열기 [FA 열기, FB 저장]
- 결과 화면 [FB]: 내려받기 줄에 "조사 파일 저장" 버튼 → `backend.exportRunFile(id)` → 다운로드. 툴팁: "이 사이트의 '조사 파일 열기'로 다른 컴퓨터에서도 결과를 다시 볼 수 있습니다."
- 사이드바 [FA]: "조사 파일 열기" 버튼(숨은 `<input type="file" accept=".json,application/json">`) + 창 어디에든 `.json` 파일을 끌어다 놓으면 가져오기(끌고 있는 동안 화면 전체에 안내 오버레이).
  `backend.importRunFile(text)` → 기록 갱신 → 그 결과 화면으로 이동. 실패하면 토스트(파일 형식이 아님 등).
- 가져온 항목은 기록에서 "가져옴" 태그. 삭제 가능, 이름 변경 가능(샘플만 둘 다 불가).

## F7. 기록 관리 [FA]
- 기록 제목 줄에 검색 입력(돋보기 아이콘, 지우기 버튼): 주제·프롬프트·사용자 제목에 부분 일치(대소문자 무시). 결과가 없으면 "검색 결과가 없습니다".
- 항목 메뉴: "이름 바꾸기"(모달 입력, 80자, `backend.rename`), "조사 파일 저장"(끝난 실행만), "삭제"(확인 창; 진행 중이면 비활성). `custom_title`이 있으면 그것을 제목으로.

## F8. 보고서 다시 쓰기 [FB]
- 결과 화면 머리 버튼 "보고서 다시 쓰기"(샘플·데모·가져온 실행 포함, 키 필요) → 대화상자(`views/rewrite.js`):
  언어(한국어/English, 기본 원래 언어), 분량(간단히/보통/자세히, 기본 보통), 모델(기본 원래 모델; `config.models`), 추가 요청(선택, 500자, 예: "정책 시사점을 더 자세히"),
  예상 비용(모델 가격 × 입력 약 60k 토큰 + 출력 간단히 10k / 보통 25k / 자세히 40k 토큰, "대략치"). "다시 쓰기 시작" → `backend.rewriteReport(id, {...})` → 새 실행의 진행 화면으로 이동(⑦⑧만 진행).
- 결과 화면에 `parent_id`가 있으면 메타 줄에 "원래 결과 보기" 링크.

## F9. 데모 속도 [FA]
- 작성 화면에서 데모 실행을 시작하는 모든 곳(F1 카드, 키 창의 "데모로 보기")은 `prefs.demoSpeed`(기본 1) 또는 버튼이 정한 속도를 보낸다.

## 검증 (각 담당)
- 수정한 JS 파일마다 `node --input-type=module --check < 파일`이 아무것도 출력하지 않아야 한다.
- 정적 서버로 사이트를 띄워 확인할 수 있다: PROJECT의 **부모** 폴더에서 `python -m http.server <포트> --bind 127.0.0.1`로 띄우면 `http://127.0.0.1:<포트>/ai-research-agent/`가
  GitHub Pages의 하위 경로(`/<repo>/`)와 같은 조건이 된다. `curl`로 index.html과 자산이 200으로 오는지만 확인하고, 브라우저 확인은 리드가 한다. 띄운 서버는 PID로 끈다.
