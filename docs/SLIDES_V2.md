# 발표 자료(PowerPoint) v2 — 발표용으로 따로 만든다 (SLIDES_V2)

사용자 요청(2026-11-21): "제작할 PPT의 퀄리티를 신경쓸 것(기존 보고서를 잘라서 붙이는 방식을 사용하지 않고 따로 프레젠테이션용으로 제작)".

## 0. 무엇이 문제였나, 무엇을 바꾸나

v1은 보고서의 구조를 그대로 줄여 담았다: 요약 글머리표 → 하위 질문마다 글머리표 4~5개 → 일치·상충 → 공백 … 26장. 제목은 보고서 문장을 잘라 붙인 긴 문장이고, 한 장에 다 못 넣으면 "(계속)" 슬라이드가 생긴다. **읽는 문서이지 말하는 자료가 아니다.**

v2는 **발표의 흐름**으로 다시 짠다.

1. **질문 → 한 문장 결론 → 근거 → 핵심 메시지 3~5개 → 엇갈리는 점 → 빈 곳 → 다음 연구 → 주의할 점 → 기억할 세 가지** 순서.
2. **슬라이드 한 장에 주장 하나.** 제목은 주장형 문장(짧게), 본문은 큰 숫자·카드·차트. 긴 설명은 **발표자 노트**로 보낸다.
3. 내용은 보고서를 자르지 않고 **발표용 구성안(deck plan)** 을 따로 만든다.
   - API 키가 있으면 LLM이 구성안을 쓴다(1회 호출).
   - 샘플·데모는 미리 만들어 둔 구성안(`data/samples/<id>/slides.json`)을 쓴다.
   - 둘 다 없으면 규칙으로 구성안을 만든다(문장을 중간에서 자르지 않는다).
4. 디자인은 사이트의 라벤더 디자인과 같은 색(보라 · 민트 · 코랄)으로 한 벌을 새로 만든다.

구성안과 그리기를 나눈다: `assets/js/export/slides.js`(구성안) · `assets/js/export/pptx.js`(그리기).

## 1. 구성안(deck plan) 모양 — `version: 2`

```js
{
  version: 2,
  source: 'llm' | 'sample' | 'rules',   // 누가 만들었나(화면 안내용). normalizeDeck이 채운다
  title: '',          // 표지 제목. 주제를 발표 제목답게(질문형·메시지형 가능)
  subtitle: '',       // 표지 한 줄
  question: '',       // 청중에게 던지는 질문 한 문장
  context: [''],      // 왜 지금 이 질문인가: 짧은 사실 2~3개
  answer: '',         // 한 문장 결론
  answer_caveat: '',  // 그 결론에 붙는 단서 한 줄(근거 수준 · 조건)
  messages: [{        // 핵심 메시지 3~5개. 하위 질문 순서가 아니라 발표 흐름 순서
    headline: '',     // 주장형 제목(완결된 짧은 문장)
    points: [{        // 근거 카드 2~3개
      figure: '',     // 큰 숫자·짧은 값("56.7%", "3.02배", "A- → A"). 없으면 ''
      text: '',       // 그 숫자가 뜻하는 것, 또는 짧은 주장
      detail: '',     // 보충 한 줄: 설계 · 표본 · 조건
      sids: [''],     // 근거 문헌 id(1~3개)
    }],
    takeaway: '',     // 그 장의 한 줄 요지("그래서")
    strength: 'strong' | 'moderate' | 'weak' | 'insufficient',
    subq_ids: [''],   // 이 메시지가 답하는 하위 질문
    notes: '',        // 발표자 노트: 말할 내용 3~5문장. [S12] 인용 표기를 남긴다
  }],
  agree: [''],        // 연구들이 일치하는 점(최대 3)
  conflict: [''],     // 엇갈리는 점(최대 3)
  conflict_why: '',   // 왜 엇갈리는가 한 문장
  gaps: [{ gap: '', why: '' }],                                  // 연구 공백(최대 4)
  next_studies: [{ title: '', design: '', sample: '', payoff: '' }],   // 제안 연구(최대 3)
  cautions: [''],     // 결과를 읽을 때 주의할 점(최대 4)
  takeaways: [''],    // 기억할 세 가지
  closing: '',        // 마지막 한 문장
  must_read: [{ sid: '', why: '' }],          // 필독 문헌(최대 5)
  subq_labels: [{ id: '', label: '' }],       // 하위 질문의 짧은 이름(발표 언어)
  notes: { opening: '', answer: '', landscape: '', strength: '', tension: '', gaps: '', next: '', cautions: '', closing: '' },
}
```

모범 예: `data/samples/sample_genai_graduate_research/slides.json`.

### 1.1 길이 제한 (`DECK_LIMITS`)

길이는 **em 폭**으로 잰다(한글 등 전각 1, 영문·숫자 0.55 — `emLen(text)`). 한글 46자 ≈ 영문 84자.

| 항목 | 개수 | 길이(em) | | 항목 | 개수 | 길이(em) |
|---|---|---|---|---|---|---|
| title | | 44 | | agree · conflict | ≤3 | 58 |
| subtitle | | 60 | | conflict_why | | 110 |
| question | | 70 | | gaps | ≤4 | gap 40 · why 76 |
| context | 2~3 | 56 | | next_studies | ≤3 | title 40 · 나머지 58 |
| answer · answer_caveat | | 84 | | cautions | ≤4 | 66 |
| messages | 3~5 | | | takeaways | 3 | 44 |
| headline | | 46 | | closing | | 60 |
| takeaway | | 78 | | must_read | ≤5 | why 70 |
| points | 2~3 | figure 9 · text 54 · detail 56 · sids ≤3 | | subq_labels.label | | 44 |
| message.notes | | 520 | | notes.* | | 420 |

`[S12]` 같은 인용 표기는 길이에 넣지 않는다.
노트 길이는 구성안 전체가 LLM의 한 번의 답(최대 16,000 토큰)에 들어가도록 잡은 것이다.
`emLen`은 구성안의 길이를 자르는 데만 쓰는 어림이다. 글이 슬라이드의 상자에 실제로 들어가는지는 그리기가 PowerPoint와 같은 방식으로 따로 잰다(3.3).

### 1.2 `normalizeDeck(deck, result, source)` — 어떤 입력이 와도 같은 모양

- 모든 키를 채운다. 문자열은 `clean()` 후 제한에 맞춘다. `clean()`은 먼저 `stripControl()`로 XML에 쓸 수 없는 글자(탭 · 줄바꿈을 뺀 제어 문자, 짝 없는 서로게이트, U+FFFE · U+FFFF)를 빼고, Markdown 강조 · 줄바꿈을 지운다. 그래서 구성안의 어느 칸에도 이런 글자가 남지 않는다(PowerPoint가 파일을 복구해야 한다고 하지 않게).
- **길이를 넘으면**: ① 문장 끝에서 자를 수 있으면 거기서 자른다 ② 아니면 절·단어 경계에서 자르고 `…`을 붙인다(인용 표기는 중간에서 자르지 않는다). LLM에는 제한을 미리 알려 주므로 ②는 드물어야 한다.
- `figure`(큰 숫자)는 자르지 않는다: 9em을 넘으면 비운다(잘린 숫자는 틀린 숫자다).
- `figure`에는 **보고서에 있는 수만** 남긴다(`briefNumbers` · `grounded`): 그 안의 수가 모두 보고서에 있어야 한다. 소수는 같은 표기로(`56.7`), 정수는 같은 값으로(`0`과 `0.0`은 같다) 있어야 하고, 아니면 칸을 비운다(56.7%를 반올림한 57%, 지어낸 수). 천 단위 쉼표는 빼고 비교하며, 인용 표기 `[S12]`와 `S12` · `Q3` 같은 id의 숫자는 수로 세지 않는다. 보고서가 없으면 확인할 수 없으므로 그대로 둔다.
- `text`도 `figure`도 없는 카드는 뺀다. `headline`이 비면 `takeaway`(인용 표기 제외)를 제목으로 쓰고 `takeaway`는 비운다(같은 문장이 두 번 나오지 않게). `takeaway`도 없으면 첫 카드의 `text`(없으면 `figure`). 그래도 제목이 없는 메시지는 뺀다. `title`이 비면 주제를 쓴다.
- 목록은 빈 값·중복을 빼고 개수 제한을 지킨다. `messages`가 5개를 넘으면 앞의 5개. 3개 미만이어도 그대로 둔다(그리기는 1개부터 된다).
- `points[].sids`, `must_read[].sid`, 글 안의 `[S12]`: **인용할 수 있는 문헌**(`citable`)이 아닌 id는 지운다(must_read는 항목째로 뺀다). 글 안의 표기는 그 id만 뺀다. 인용할 수 있는 문헌 = `result.sources`에 있으면서 보고서 Markdown에 인용되었거나 `syntheses[*].sources`에 쓰인 것. 그래서 수집만 하고 채택하지 않은 문헌의 id를 모델이 적어도 슬라이드 · 필독 문헌 · 참고문헌에 오르지 않는다. 보고서도 종합도 없는 결과는 걸러 낼 기준이 없으므로 `result.sources`의 문헌을 모두 받는다.
- `strength`: `subq_ids`의 종합(`result.syntheses[q].evidence_strength`) 가운데 **가장 약한 값**(다른 슬라이드 · 부록과 어긋나지 않게). 그 하위 질문들에 강도가 하나도 없을 때(또는 `subq_ids`가 비었을 때)만 구성안의 값을 쓰고, 그것도 네 값이 아니면 `'insufficient'`.
- `subq_ids`: `result.plan.sub_questions`에 있는 id만.
- `subq_labels`: 계획의 하위 질문마다 하나씩, 계획 순서로. 없으면 규칙으로 채운다(2.2 참고).
- `version: 2`, `source`(인자, 없으면 입력의 source, 그것도 없으면 `'rules'`).
- 이미 정규화한 구성안을 다시 넣으면 그대로 나온다(멱등).

`isDeck(x)`: `x && x.version === 2 && Array.isArray(x.messages)`. v1 개요(저장소에 남아 있는 옛 값)는 false → 버리고 새로 만든다.

## 2. 구성안 만들기

### 2.1 LLM — `makeDeck(llm, result)` (1회 호출, 실패하면 `null`)

`llm.json(SYS_BASE + ' ' + ABSTRACT_RULE, prompt, DECK_SCHEMA, { effort: 'medium', maxTokens: 16000 })`.
`DECK_SCHEMA`는 1절의 모양에서 `version`·`source`를 뺀 것(모든 속성 필수, 추가 속성 없음).

프롬프트에 넣는 것: 주제, 하위 질문 목록(id · 질문 · 근거 강도 · 근거 수), 수집 규모(수집·중복 병합·채택·기간), 인용해도 되는 문헌 목록(보고서에 인용되었고 `result.sources`에 있는 것: id · 짧은 표기 · 연구 유형), 보고서 Markdown 전문(`"""…"""`로 감싼다. 보고서 안의 `"""`는 `'''`로 바꿔 인용 구역이 일찍 닫히지 않게 한다), 언어, 길이 제한.
길이 제한은 언어에 맞춰 글자 수로 풀어 주되 **제한의 80%만 알려 준다**(`ASK = 0.8`, `chars()`: 한 글자가 1em인 한국어 · 일본어 · 중국어(`wideLang`: `ko` · `ja` · `zh`)는 em × 0.8, 그 밖은 em ÷ 0.55 × 0.8, 소수점 아래는 버린다. 앞의 언어에는 "한글 · 한자 한 글자는 1, 라틴 글자 · 숫자 · 공백 · 문장부호는 약 0.5"라고 세는 법도 알려 준다). 모델은 글자 수를 정확히 세지 못하므로, 조금 넘겨 써도 `normalizeDeck`이 자르지 않게 여유를 둔 것이다. 예: headline 46em → 한국어 36자, 영어 66자.

프롬프트의 핵심 지시(영어로 쓴다 — 엔진의 다른 프롬프트와 같게):

- You are preparing a **talk**, not a summary. Design what the audience should **hear and remember**. Do not copy the brief's section order; order the messages as a story (most solid finding first, the most important caveat last).
- **One claim per slide.** Each `headline` is a short complete sentence that states the claim (not a topic label).
- Each message has 2–3 `points`. Prefer points that carry a **number** from the brief: put the number in `figure` (with its unit; 길이는 아래 길이 제한 목록에 있다), say what it measures in `text`, and give the design/sample/condition in `detail`. If a point has no number, leave `figure` empty. Never invent, round or convert numbers; copy them exactly as the brief states them.
- **Write for a screen, not a page**: `points[].text` and `points[].detail` are short phrases without filler words (the subject is already in the headline). The full explanation belongs in `notes`, not on the slide.
- `takeaway`: the "so what" of that slide in one sentence. `strength` / `subq_ids`: 그 메시지가 답하는 하위 질문과 그 근거 강도(강도는 `normalizeDeck`이 종합의 값으로 다시 정한다, 1.2).
- `notes`: what the presenter would **say** for that slide, 3–5 spoken sentences in a natural register, keeping `[S12]`-style ids on the statements they support.
- `answer`: the bottom line in one sentence. `answer_caveat`: the most important condition on it.
- `context`: 2–3 short facts from the brief that explain why the question matters now.
- `agree` / `conflict` / `conflict_why`, `gaps`, `next_studies`, `cautions`, `takeaways` (exactly three), `closing`, `must_read`, `subq_labels` (a short name for every sub-question, in the output language).
- **Grounding**: use only what the brief says. Do not add facts, numbers, studies or sources. Every id in `sids` / `must_read` must be one of the sources listed (인용해도 되는 문헌 목록) and must support that statement. If the brief gives no basis for an item, return an empty list or an empty string.
- `notes` (deck level): 다른 슬라이드에서 말할 내용 2–4문장씩(opening · answer · landscape · strength · tension · gaps · next · cautions · closing).
- Length limits (80% of `DECK_LIMITS`, see above): "These are hard limits: text over a limit is cut."
- Write all text in the output language. 한국어면: 슬라이드 글은 "…줄어든다" 같은 평서형, 노트는 "…줄었습니다" 같은 말하는 높임말.

결과는 `normalizeDeck(out, result, 'llm')`.

### 2.2 규칙 — `fallbackDeck(result)` (LLM 없이, 항상 성공)

보고서 Markdown과 `result.syntheses`에서 **완결된 문장만 골라** 만든다. 문장이 제한보다 길면 버리고 다음 후보를 쓴다(끝내 없으면 normalizeDeck의 자르기 규칙).

- `title` = 주제. `subtitle` = "채택 문헌 N건으로 본 연구 브리프" / "A research brief from N sources"(N이 0이면 "연구 브리프").
- `question` = 주제 그대로(`?`로 끝나지 않으면 붙이지 않는다). `context` = `[]`(그리기가 조사 범위 카드로 대신한다).
- 보고서의 첫 번째 번호 절(핵심 요약)의 글머리표를 쓴다. 각 글머리표에서 굵은 머리 문장(`**…**`으로 시작하는 부분)이 있으면 그것이 **주장**, 나머지 문장이 **근거**다.
  - `answer` = 첫 글머리표의 주장(없으면 첫 문장). `answer_caveat` = "하위 질문 N개 중 M개는 근거가 '약함' 이하다." (M ≥ 1일 때).
  - `messages` = 글머리표마다 하나(최대 5개. 첫 글머리표도 포함한다):
    - `headline` = 주장. 46em을 넘으면 그 안의 문장, 그다음 "A지만, B"의 B를 차례로 써 본다.
    - `points` = 나머지 문장 · 하위 항목 · 이어지는 문단에서 카드 최대 3개. 54em을 넘는 문장, 인용을 지우면 깨지는 문장("[S9]는 …"), 목록을 예고하는 문장("…다음과 같다", "…:")은 쓰지 않고, 문장 첫머리의 접속어("반면", "그러나" …)는 뗀다. 숫자나 인용이 있는 문장을 먼저 고르고 앞 문장을 가리키는 문장("이는 …")은 마지막에 고르되, 보여 주는 순서는 보고서 순서다. 카드마다 `figure` = 그 문장의 첫 "숫자+단위"(`figureOf`, 9em 이내), `text` = 그 문장(인용 표기 제외), `detail` = `''`, `sids` = 그 문장의 인용 id.
    - `figureOf`의 규칙: 단위는 `%p % 배 명 건 편 쌍 개월 개 점 회 종 곳 시간 분 년 달러 Ω/sq Ω µm(μm) nm mm cm kPa ppm ppb x times pp SD`(긴 것을 먼저 맞춘다: `%p`가 `%`보다, `Ω/sq`가 `Ω`보다 먼저). 앞에 `±`가 붙을 수 있고, `~ – → -`로 이은 범위·변화도 한 덩어리로 잡는다(`6-7 µm`, `7.0→3.5 Ω/sq`, `±2.1%`). **단위 없는 숫자는 쓰지 않는다**(무엇의 수인지 알 수 없고 연도·번호일 때가 많다). 연도만 있는 값(`2025년`, `2023–2026년`)도 쓰지 않는다. 다음도 건너뛴다: 앞에 빼기표(`-` · `−` · `–`)가 붙은 수(부호를 떼면 뜻이 반대가 된다). 한글 단위 뒤에 조사 · 접미사의 첫 글자(`PARTICLE`: 을 · 를 · 이 · 가 · 의 · 에 …)가 아닌 한글이 이어지는 것(더 긴 낱말의 앞부분이다: `3개국`, `4년제`, `2.4 개념적`, `4.3 종합`. 단위 뒤가 끝 · 공백 · 문장부호 · 조사면 쓴다). 단위 뒤에 `/`가 이어지는 것(다른 단위다: `0.5 Ω/cm`). 뒤에 `CI` · `신뢰구간`이 오는 것(`95% CI`는 결과가 아니라 신뢰수준). 범위의 뒤쪽 값만 잡힌 것(`0.2에서 0.5 SD`, `0.2 to 0.5 SD`). 맞는 것이 없으면 `''`.
    - `takeaway` = `''`. `subq_ids` = 인용 id가 가장 많이 겹치는 하위 질문 1개. `strength` = 그 질문의 근거 강도. `notes` = 글머리표 전체(인용 포함).
  - 요약 절이 없거나 글머리표가 없으면 하위 질문별 종합으로 대신한다: `headline` = `syntheses[q].answer`의 첫 문장, `points` = `key_findings` 앞의 3개.
- `agree` / `conflict` = `syntheses[*].consensus` / `disagreements`를 질문마다 번갈아 뽑은 것의 첫 문장. "직접적인 상충은 없다" 같은 문장은 건너뛰고 그 뒤 문장(실제 차이)을 쓰며, 그런 문장만 있으면 하나만 남긴다. `conflict_why` = `''`.
- `gaps` = 보고서의 "연구 공백" 절 글머리표: `gap` = 굵은 머리 문장(없으면 첫 문장, 40em을 넘으면 그 항목은 뺀다), `why` = 나머지 글(없으면 첫 하위 항목)의 첫 문장. 그 절이 없으면 `syntheses[*].gaps`를 번갈아 뽑은 것(`why` = `''`). 최대 4.
- `next_studies` = 보고서의 "향후 연구" 절에서(v1의 `futureStudies` 해석을 그대로 쓴다): `title`(길면 " — " · ":" 앞의 본제목), `design` ← 설계, `sample` ← 표본, `payoff` ← 기대 기여.
- `cautions` = 보고서의 "한계" 절(없으면 마지막 번호 절)의 글머리표: 굵은 머리 문장 + 다음 한 문장, 66em을 넘으면 다음 문장만, 그것도 넘으면 머리 문장만.
- `takeaways` = 메시지 `headline` 세 개(44em에 들어가는 것을 먼저 고르고, 순서는 메시지 순서). `closing` = `''`.
- `must_read` = 본문에 인용된 문헌을 점수순으로 5개(`why` = `key_finding`).
- `subq_labels`: 보고서의 `### Q3. …` 제목에서 "— 근거 강도" 앞까지. 없으면 `perspective`, 그것도 없으면 `question`.
- `notes` = 모두 `''`(그리기가 숫자로 기본 노트를 만든다).

## 3. 그리기 — `buildPptx(result, deck = null)`

`deck`이 `isDeck`이 아니면 `fallbackDeck(result)`. 항상 `normalizeDeck`을 거친 값을 그린다. 16:9(13.333 × 7.5 in), pptxgenjs.
구성안을 거치지 않은 글(문헌 제목 등)도 있으므로, 모든 글 조각 · 차트 이름표 · 파일 제목에서 `stripControl()`로 제어 문자를 한 번 더 뺀다. 파일 속성(파일 → 정보): 제목 = 구성안의 `title`(비면 주제), 주제 = `subtitle`(비면 `question`), 만든 이 = "AI Research Agent".

### 3.1 디자인 값

| 이름 | 값 | 쓰임 |
|---|---|---|
| INK / INK_2 / MUTED | `1E1933` / `4B4463` / `7A7391` | 본문 · 보조 · 캡션 |
| RULE / TINT / TINT_2 | `E5DEF5` / `F7F4FF` / `EEE8FF` | 선 · 옅은 면 · 조금 진한 면 |
| PURPLE / VIOLET / DEEP / DEEP_2 / LAV | `6A3DE8` / `7C4DF0` / `24184D` / `34226B` / `C9B8FD` | 주색 · 차트 · 어두운 바탕 · 어두운 면 · 어두운 바탕의 글자 |
| MINT / MINT_DARK / MINT_SOFT | `19B8A2` / `097A6B` / `E1F6F2` | 긍정 · 일치 |
| CORAL / CORAL_DARK / CORAL_SOFT | `F26D50` / `BE3324` / `FFEDE4` | 주의 · 상충 |
| GRAY | `CFC9E0` | 해당 없음 |

- 근거 강도 색: strong `MINT_DARK` · moderate `PURPLE` · weak `CORAL` · insufficient `MUTED`. 강도는 **네 칸 막대**(채운 칸 수 4·3·2·1)와 글자로 함께 보인다(색만으로 구분하지 않는다). 글자 칸의 너비는 그 덱의 언어에서 가장 긴 강도 이름이 한 줄에 들어가는 폭이다(`wordWidth` · `meterWidth`. 영어 "Insufficient"도 한 줄). 메시지 슬라이드 · 근거의 단단함 · 부록 A에서는 이 전체 폭으로 막대의 자리를 정해 오른쪽에 맞춘다(메시지 슬라이드와 부록 A는 오른쪽 여백, 근거의 단단함은 근거 수 칸의 왼쪽).
- 글꼴: `맑은 고딕`(theme.FONT_KO) 한 가지. 제목·숫자는 굵게.
- 글자 크기(pt)는 단계 목록에서 들어가는 가장 큰 것을 고른다(3.3): 표지 제목 40~32 · 슬라이드 제목 30~24(부록 24~20) · 큰 문장(질문 · 결론) 34~26 · 근거 카드의 큰 숫자 44~20(카드끼리 같은 크기, 한 줄에 들어가는 크기) · 본문 13~20 · 보조 12~13 · 꼬리말 9~10. **본문에 12pt보다 작은 글자를 쓰지 않는다.** 작은 보조 글(구역 이름 · 칸 이름 · 단계 설명 · 출처 줄 · 차트 글자 · 표지 아래 정보 · 결론 슬라이드의 하위 질문 칩 · 부록의 원래 질문과 문헌 제목)만 11pt까지 쓴다. 글 안의 인용 표기 `[S#]`는 그 글보다 4pt 작게(MUTED), 11pt 아래로는 내리지 않는다.
- 다른 결과물(HTML · Word)의 색(`theme.js`)은 건드리지 않는다. 발표 자료의 색은 `pptx.js` 안에 따로 둔다.

### 3.2 공통 틀

- 흰 바탕 슬라이드: 왼쪽 위 작은 **구역 이름**(11~12pt 굵게, PURPLE) → **제목**(주장, 30~24pt 굵게, 최대 2줄) → 본문 영역 → 꼬리말(왼쪽 발표 제목, 오른쪽 쪽 번호, 9~10pt MUTED).
- 어두운 슬라이드(표지 · 기억할 세 가지 · Q & A): 바탕 DEEP, 글자 흰색·LAV, 오른쪽에 반투명 원 두 개(VIOLET · MINT)와 작은 코랄 점 — 사이트 첫 화면의 오로라·색 점과 같은 인상.
- 모든 본문 슬라이드에 **발표자 노트**를 넣는다(구성안의 notes, 없으면 숫자로 만든 기본 문장).
- 글이 상자를 넘지 않게: 줄 수를 PowerPoint와 같은 방식으로 세어(3.3) 글자 크기 단계를 고르고, 가장 작은 단계로도 넘치면 줄인다(끝에 `…`). "(계속)" 슬라이드는 만들지 않는다(부록 A와 참고문헌만 여러 장으로 나눈다).

### 3.3 글 맞춤 — PowerPoint가 글을 놓는 방식을 그대로 따라 센다

글을 그리기 전에 "이 상자에 몇 줄이 되는가"를 셈해서 글자 크기와 자리를 정한다. 예전에는 (글 전체 폭 ÷ 줄 폭)으로 어림했는데, 낱말이 통째로 다음 줄로 넘어가며 생기는 빈자리를 놓쳐 실제보다 한 줄 적게 세는 일이 있었다. 그러면 카드의 주장(굵게)이 그 아래 보충 글과 겹쳤다. 지금은 다음처럼 한다(`pptx.js`의 "글자 맞춤 어림" 부분).

- **글자 폭은 잰 값**: 맑은 고딕을 PowerPoint에서 100pt로 10자와 40자 그려, 그 차이로 한 글자의 폭을 잰 표(em × 1000)를 쓴다. 보통 글자 `ASCII_W`와 굵은 글자 `ASCII_WB`(ASCII 0x20~0x7E), 자주 나오는 그 밖의 글자 `GLYPH_W`(`· ± × µ Ω – — “ ” … ≤ ≥ ℃` 등, 보통/굵게). 한글 · 한자 · 전각 기호는 1.000em. 표에 없는 글자는 종류별 어림값: 수학 기호(U+2200~U+22FF) 0.78em, U+2000 이상의 재지 않은 기호(※ · 위아래 첨자 …)는 넉넉하게 1em, 그 밖(라틴 확장 · 그리스 · 키릴 문자)은 0.70em(굵게 0.74em).
- **줄 높이** = 글자 크기 × 1.2(`LINE`, PowerPoint로 잰 값).
- **줄바꿈은 낱말 단위로 직접 놓아 본다**(`wrapCount`): 한글도 띄어쓰기에서만 줄을 바꾼다. 낱말을 차례로 놓고 들어가지 않으면 다음 줄로 넘긴다. 한 줄보다 긴 낱말(긴 영문 · 주소)만 새 줄에서 시작해 글자 단위로 끊는다.
- **2% 여유**: 자리를 잡을 때 쓰는 줄 수 `textLines()`는 줄 폭의 98%만 쓰는 것으로 센다(`WRAP = 0.98`). 그래서 PowerPoint보다 적게 세는 일이 없다(6.1).
- `fitText(text, w, h, tiers)`: 단계 `tiers`에서 높이(줄 수 × 줄 높이 + 안쪽 여백)가 들어가는 가장 큰 크기. 가장 작은 크기로도 넘치면 15%씩 줄인다(`clip`, 끝에 `…`). 여러 칸에 같은 크기를 쓸 때는 `commonSize`(모두가 들어가는 가장 큰 단계). 큰 숫자 · 칩처럼 한 줄로만 쓰는 글은 `oneLine`(굵은 글자 폭 + 3% 여유)으로 고른다. 큰 숫자는 줄이지 않는다(잘린 숫자는 틀린 숫자다).
- **줄 길이 고르게** `balancedWidth()` (`fit(..., { balance: true })`): 여러 줄이 되는 큰 글은 줄 수가 늘지 않는 가장 좁은 상자 너비를 이분 탐색으로 찾아 그 너비로 그린다. 마지막 줄에 낱말 하나만 남지 않게 하려는 것이다. 이때 줄 수는 여유 없이(100%) 세고, 찾은 너비에 2% 여유를 더해 돌려준다(여유를 두고 세면 한 줄에 들어가는 글을 두 줄로 잘못 나눈다). 한 줄짜리 글은 그대로 둔다. 쓰는 곳: 표지 제목 · 부제, 오늘의 질문, 한 문장 결론과 그 단서, 슬라이드 제목, "그래서" 띠, "왜 엇갈리나" 띠, 기억할 세 가지와 마지막 문장, Q & A 줄.
- **주장 + 보충은 글상자 하나에** `pair()`: 굵은 주장과 보충 글을 한 글상자의 두 문단(사이 5~7pt)으로 쓴다. 따로 놓으면 줄 수가 한 줄만 어긋나도 겹치지만, 한 상자 안에서는 PowerPoint가 차례로 이어 놓으므로 겹칠 수 없다. 높이를 넘치면 주장은 보충 한 줄 자리를 남기고 맞추고, 보충을 남은 자리에 맞춰 줄인다(대개 보충이 먼저 줄어든다). 근거 카드(`pointCards`)와 연구 공백(`gaps`)에 쓴다.
- 이 방식은 Windows의 PowerPoint와 맑은 고딕에 맞춘 것이다. 다른 프로그램이나 글꼴이 없는 컴퓨터에서는 줄이 다르게 바뀔 수 있다(6.1).

### 3.4 슬라이드 순서

| # | 슬라이드 | 내용 |
|---|---|---|
| 1 | **표지** (어두움) | 제품 이름 줄, `title`, `subtitle`, 아래에 날짜 · 모델 · 수집/채택 건수 · 검색 기간 |
| 2 | **오늘의 질문** | 왼쪽: `question`을 크게. 오른쪽: "왜 지금인가" `context` 카드 2~3개(번호 원 + 글). context가 없으면 "조사 범위" 카드(검색 기간 · 채택 문헌 수 · 하위 질문 수) |
| 3 | **한 문장 결론** (옅은 바탕) | 큰 카드에 `answer`. 아래에 `answer_caveat`. 맨 아래 "하위 질문별 근거 강도" 띠(질문마다 칩: id + 강도. 9개 이상이면 두 줄) |
| 4 | **조사 방법** | 제목: "AI 에이전트가 문헌 N건을 모아 M건을 추렸습니다". 8단계 흐름 + 숫자 흐름(수집 → 중복 병합 → 채택 → 본문 인용) + 한 줄 정보(기간 · 모델 · 소요 시간 · LLM 호출 수 · 제외된 도구) |
| 5 | **근거 지형** | 카드 3개: 연구 유형(가로 막대) · 출판 연도(세로 막대) · 결과 방향(도넛 또는 쌓은 막대). 카드마다 숫자로 만든 한 줄 설명 |
| 6… | **핵심 메시지 i/k** (메시지마다 한 장) | 제목 = `headline`. 오른쪽 위 근거 강도 막대. 근거 카드 2~3개(큰 `figure` — 없으면 번호 배지, 그 아래 `text`(굵게)와 `detail`을 `pair()`로 한 글상자에, 맨 아래 출처 줄 "Pensky et al. (2025) · S15", 넘치는 문헌은 "외 n건". 출처 줄은 하나하나가 늘 한 줄이다: 저자가 없어 학술지 · 사이트 이름이 들어간 긴 표기는 `citeFit()`이 연도는 남기고 이름 부분을 줄인다(끝에 `…`)). 아래 띠에 `takeaway`. 카드 배치는 두 가지를 차례로 해 보고 **글을 줄이지 않고 들어가는 첫 배치**를 쓴다: ① 넉넉하게(큰 숫자 최대 44pt, 출처 두 줄) ② 촘촘하게(큰 숫자 최대 28pt, 출처 한 줄). 주장 18~14pt · 보충 13~12pt는 모든 카드에 들어가는 가장 큰 조합. 둘 다 안 되면 가장 작은 크기로 쓰고 `pair()`가 보충부터 줄인다 |
| | **근거의 단단함** | 하위 질문마다 한 줄(최대 8줄, 나머지는 "부록 A에 있습니다"): id 칩 · 짧은 이름(`subq_labels`) · 강도 네 칸 막대 · 근거 수 |
| | **일치와 상충** | 두 칸(일치: MINT / 상충: CORAL, 두 칸에 같은 글자 크기 17~13pt) + 아래 "왜 엇갈리나" 띠(`conflict_why`, 16~13pt). 둘 다 비면 이 장을 뺀다 |
| | **연구 공백** | 번호 카드(`gap` 굵게 + `why`를 `pair()`로 한 글상자에): 2개 이하 → 한 줄(번호는 왼쪽), 3개 → 세 칸(번호는 위), 4개 → 2×2(번호는 왼쪽). 한 줄뿐이면 카드 높이를 글에 맞춘다. 없으면 뺀다 |
| | **다음 연구 제안** | 연구마다 가로 카드 한 장(최대 3): 번호 · `title`(제목 칸 너비 2.7in) │ 설계 │ 표본 │ 기대 기여. 칸 이름은 맨 위에 한 번만 쓴다. 없으면 뺀다 |
| | **주의할 점** | 왼쪽: `cautions`(번호 원). 오른쪽: 인용 검증 요약(인용 문헌 수 · 검증 문장 수 · 고친 문장 수 · 판정별 수정 전/후) |
| | **기억할 세 가지** (어두움) | 01 · 02 · 03과 `takeaways`(없으면 메시지 제목). 아래에 `closing` |
| | **Q & A** (어두움) | "질문과 토론" + "이 발표 자료는 AI Research Agent가 수집한 문헌 N건 중 채택한 M건을 바탕으로 만들었습니다" + 구성안의 출처 한 줄(AI · 샘플 · 규칙) |
| | **부록 표지** (옅은 바탕) | "부록" + 들어 있는 것 목록 |
| | 부록 A **하위 질문** | 하위 질문마다 한 칸: 첫 줄 = id 칩 · 짧은 이름(굵게) · 강도 막대. 그 아래에 **원래 질문 전문**(11pt, 가로 전체, 최대 5줄. 이름과 같으면 쓰지 않는다). 넘치면 여러 장 |
| | 부록 B **필독 문헌** | `must_read`: 순위 · 문헌(짧은 표기 + id, 그 아래 제목. 짧은 표기 줄은 `citeFit()`으로 한 줄) · 읽을 이유 |
| | 부록 C **참고문헌** | 슬라이드와 노트에 인용한 문헌 전체(S 번호순, 여러 장 가능) |

부록 A와 참고문헌을 여러 장으로 나눌 때는 먼저 채워 넣기로 장 수를 정하고, 같은 장 수로 고르게 나눠도 들어가면 그쪽을 쓴다(마지막 장에 한두 줄만 남지 않게).

차트는 PowerPoint에서 고칠 수 있는 진짜 차트로 넣는다. 통계가 없으면 그 카드는 "자료 없음".

### 3.5 기본 노트(구성안의 notes가 비었을 때)

숫자로 만든 한두 문장. 예(ko): 조사 방법 "AI 에이전트가 8단계로 문헌 229건을 수집해 중복 52건을 합치고 86건을 채택했습니다. 검색 기간은 2022년 이후, 모델은 Claude Opus 5.5입니다." 메시지 슬라이드는 `message.notes`, 비었으면 제목 + 카드마다 "숫자 글 [S12]" + 요지를 이은 것.
구성안에 칸이 없는 슬라이드는 늘 정해진 문장을 쓴다: 표지("제목. 부제"), 조사 방법(위의 예), Q & A, 부록 표지, 부록 A · B · C.

## 4. 백엔드 · 화면

- `backend._exportStage`: PowerPoint를 골랐으면 ① `run.llm`이 있으면 `makeDeck`(예외가 나거나 null을 돌려주면 "발표 구성안 생성 실패 → 규칙으로 구성 (…)" 경고 이벤트를 과정 기록에 남기고 넘어간다. 취소는 그대로 던진다. 성공하든 실패하든 구성안 호출도 LLM 사용량이므로, 그 뒤 `result.meta.usage`를 `run.liveUsage()`로 고쳐 결과를 다시 저장한다 — 결과 화면의 비용에 구성안 호출이 들어간다) ② 실패·없음이면 샘플·데모의 미리 만든 구성안(정규화한 뒤 메시지가 하나 이상일 때만) ③ 그것도 없으면 `fallbackDeck`. 결과를 `meta: slides:<id>`에 저장(샘플도 저장소에 직접 써서 새로고침 뒤에도 쓴다).
- `backend._deck(run, result)`(옛 `_outline`): 메모리 → 저장소(`isDeck`인 것만) → **샘플·데모면 `data/samples/<샘플 id>/slides.json`**(`_loadSample`. 데모는 데모 샘플의 것, 조사 파일로 가져온 샘플은 원래 샘플의 것) → `fallbackDeck`.
- `backend.slides(id, { api_key, model })`: 키로 `makeDeck`을 다시 부른다(샘플·데모도 키가 있으면 된다). 키가 없으면 `no_api_key` 오류(데모·샘플 포함 — 미리 만든 구성안은 이미 쓰이고 있다). 구성안을 만들지 못하면 `slides_failed` 오류이고 지금 구성안은 그대로 둔다. 성공하면 구성안을 저장하고 PowerPoint를 다시 만든 뒤 `{ ok: true, llm: true, source: 'llm' }`.
- `backend.result(id)`에 `slides_source: 'llm' | 'sample' | 'rules'`를 넣는다(지금 PowerPoint를 받으면 쓰일 구성안).
- 결과 화면:
  - "다른 형식" 메뉴 맨 아래에 **"발표 자료 다시 구성 (AI)…"**(메뉴 안 설명: "지금: <구성안 출처> · API 키 필요". PowerPoint를 만드는 동안은 "준비 중…"으로 막힌다). 누르면 작은 창: 지금 구성안의 출처, 무엇을 하는지, 모델 선택, 예상 비용(모델 단가 × (입력 약 4천 토큰 + 보고서 글자 ÷ 2) + 출력 약 1만 토큰으로 어림), [취소] [구성하고 내려받기]. 키가 없으면 창 대신 키 창을 연다. 출처 설명 중 샘플 구성안의 것: "샘플에 미리 넣어 둔 발표용 구성안입니다. 실제 조사에서 AI가 받는 것과 같은 지침으로 준비했고, 숫자와 문헌은 모두 보고서에 있는 것입니다."
  - 요청이 끝나기 전에 창을 닫아도 요청은 계속된다. 닫은 뒤에 끝나면: 성공 → 파일을 내려받지 않고 "발표 자료를 다시 구성했습니다. '발표 슬라이드'를 내려받으면 새 구성이 쓰입니다." 알림만 띄운다. 실패 → 닫힌 창 안의 오류 칸은 보이지 않으므로 오류를 알림으로 띄운다.
  - PowerPoint를 내려받았는데 구성안이 `rules`이면 알림에 한 줄을 덧붙인다: "규칙으로 구성한 발표 자료입니다. API 키가 있으면 '다른 형식 → 발표 자료 다시 구성'으로 다듬을 수 있습니다."
- 형식 설명: `'보고서를 요약한 발표용 PowerPoint'` → `'발표용으로 따로 구성한 PowerPoint(발표자 노트 포함)'`.
- `?mock=1`: FakeLLM이 `DECK_SCHEMA`에도 답한다(유효한 v2 구성안).

## 5. 샘플

`data/samples/<id>/slides.json` 두 개. 실제 실행 기록이 아니라 **LLM에 주는 것과 같은 지침(2.1의 지시 · 길이 제한 · 근거 규칙)으로 손으로 미리 만들어 둔 구성안**이다(README에 적는다). 2.2의 규칙 구성안과는 다르다. `source: 'sample'`. 모든 숫자와 문헌 id는 그 샘플의 보고서에 있는 것만 쓴다. 숫자는 보고서의 표기 그대로 쓰고(예: 탐지기 카드의 "0.0%~100.0%"), 카드의 문헌은 그 주장을 실제로 뒷받침하는 것만 붙인다(대학원생 성적 "A- → A" 카드에는 S15 · S7. 전문직 대상 연구 S55는 붙이지 않는다).

## 6. 확인 · 검증 방법

- `node --test tests/` 통과(190개). 구성안: 정규화(멱등 · 제한 · 없는 id 제거 · 채택하지 않은 문헌 제거 · 근거 강도 · 보고서에 없는 큰 숫자 비우기 · 제어 문자 제거), `figureOf`(단위 · 범위 · 연도 건너뛰기 · 빼기표 · 더 긴 낱말의 앞부분 · 신뢰수준과 범위의 뒤쪽 값), 규칙 구성안(두 샘플), `makeDeck`(스키마·옵션 전달, 프롬프트의 길이 = 제한의 80%, 일본어 · 중국어도 em 기준, 보고서 안의 `"""`, 노트 길이가 한 번의 답에 들어가는지, null 처리). PowerPoint: 두 샘플 × (샘플 구성안 · 규칙 구성안) 빌드, 슬라이드 수, 노트, 차트, XML 안전성. 글 맞춤(`tests/export-pptx-fit.test.js`): `textLines`의 낱말 단위 줄바꿈과 긴 낱말 끊기, `textHeight`, `balancedWidth`, `fitText`, 카드의 주장과 보충이 한 글상자의 두 문단인지, 부록 A가 원래 질문을 줄이지 않는지, 손으로 쓴 두 샘플 구성안이 `…` 없이 들어가는지. 검토에서 찾은 넘치기 쉬운 글: 저자 없는 문헌의 출처 줄이 한 줄인지(연도는 남는다), 영어 "Insufficient"가 강도 글자 칸에 한 줄로 들어가는지, 제어 문자가 슬라이드 XML에 들어가지 않는지, `[S#]`가 11pt보다 작지 않은지, 제목이 빈 메시지가 요지나 첫 카드의 글로 제목을 얻는지. `tests/check_office.py`는 만든 파일을 python-pptx로 다시 열어 구조를 검사한다.
- 보고서(Markdown · HTML · Word)는 바뀌지 않는다. 사이트 화면은 4절의 메뉴 항목 · 창 · 알림 한 줄만 늘었다.

### 6.1 배치 검증 (실제 PowerPoint)

글 넘침과 겹침은 실제 PowerPoint로 확인했다.

- **덱 일곱 개**: 두 샘플 × (미리 만든 구성안 · 규칙 구성안) 네 개, 영어 덱, 모든 항목을 길이 제한까지 채운 덱(가장 긴 글), 최소 덱(항목을 거의 비운 것).
- 각 덱을 PowerPoint의 자동화 기능(automation interface)으로 열고, 모든 글상자에 대해 PowerPoint가 실제로 글을 놓은 사각형을 읽었다.
  - **넘침**: 글이 놓인 사각형이 그 글상자(도형) 밖으로 나가는가 → **0건**.
  - **겹침**: 글이 놓인 사각형이 같은 슬라이드의 다른 글 사각형과 겹치는가 → **0건**.
- **줄 수**: 문단이 하나인 글상자 2,442개에서 `textLines()`가 센 줄 수와 PowerPoint가 실제로 나눈 줄 수를 비교했다 → `textLines()`가 PowerPoint보다 **적게 센 경우는 한 번도 없다**(많게 세는 쪽의 실수는 자리가 조금 남을 뿐 겹치지 않는다).
- 검토에서 찾은 것을 고친 뒤 같은 검증을 다시 했고, 이번에도 넘침 0건 · 겹침 0건이었다. 사이트의 "발표 자료 다시 구성" 창으로 테스트 모드(`?mock=1`)에서 만든 덱(20장)도 같은 검증을 통과했다.
- 이 검증은 PowerPoint가 있어야 하므로 `node --test`에는 들어 있지 않다(저장소에 그 스크립트도 없다). 글 맞춤 규칙을 바꾸면 다시 해야 한다.
- 이 검증은 **Windows의 PowerPoint와 맑은 고딕 글꼴**로 한 것이다. 다른 프로그램(Keynote · Google 슬라이드 · LibreOffice · 한컴오피스 한쇼)이나 맑은 고딕이 없는 컴퓨터에서는 글자 폭과 줄바꿈이 달라 줄이 다르게 나뉠 수 있다(글이 넘치거나 겹칠 수 있다).
