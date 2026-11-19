# 샘플 데이터 발췌 (구현 참고용)

실제 실행 결과 `data/samples/sample_genai_graduate_research/`에서 뽑았다. **전체 파일(약 740KB)을 읽기 도구로 열지 말 것.**
구조와 값의 생김새는 이 문서로 충분하고, 테스트에서는 `tests/_samples.py`의 `load_sample()`로 불러 쓴다.

## result.json (긴 값은 잘랐고 목록은 앞 2~3개만)

```json
{
 "schema_version": 1,
 "id": "sample_genai_graduate_research",
 "prompt": "생성형 AI 활용이 대학원생의 연구 생산성과 연구 품질에 미치는 영향",
 "topic": "생성형 AI 활용이 대학원생의 연구 생산성과 연구 품질에 미치는 영향",
 "lang": "ko",
 "meta": {
  "model": "claude-opus-5-5",
  "model_label": "Claude Opus 5.5",
  "created_at": "2026-11-02T07:13:35",
  "finished_at": "2026-11-02T07:37:25",
  "elapsed_s": 1428.0,
  "year_from": 2022,
  "year_from_source": "agent",
  "year_from_reason": "ChatGPT's public release in November 2022 marks the start of widespread generative AI use in academic research, so relevant empirical studies appear from late 2022 onward (earlier GPT-3 writing-tool work can be added selectively if needed).",
  "config": {
   "model": "claude-opus-5-5",
   "depth": "standard",
   "min_subq": 4,
   "max_subq": 6,
   "max_reflection_rounds": 2,
   "max_tool_steps": 4,
   "results_per_search": 6,
   "verify_sample": 10,
   "year_from": null,
   "language": "ko",
   "human_in_the_loop": false,
   "parallelism": 1,
   "formats": [
    "md",
    "html"
   ]
  },
  "usage": {
   "calls": 79,
   "input_tokens": 419170,
   "output_tokens": 135059,
   "cost_usd": 4.38
  },
  "counts": {
   "collected": 229,
   "included": 86,
   "merged": 52,
   "report_evidence": 86,
   "sub_questions": 7
  },
  "disabled_tools": [
   "search_semantic_scholar"
  ],
  "app_version": "notebook-midterm",
  "sample": true,
  "demo": false,
  "note": "중간고사 제출 버전(Colab 노트북)으로 실제 실행한 결과를 웹 앱 형식으로 옮긴 샘플입니다."
 },
 "understanding": {
  "language": "ko",
  "topic_en": "The effect of generative AI use on graduate students' research productivity and research quality",
  "discipline": "Higher education research / educational technology, with links to science of science (scientometrics) and human-computer interaction",
  "research_type": "causal-effect",
  "key_concepts": [
   {
    "term": "생성형 AI",
    "english": "generative artificial intelligence",
    "synonyms": [
     "generative AI",
     "GenAI",
     "large language models",
     "…(+5)"
    ]
   },
   {
    "term": "활용",
    "english": "use / adoption",
    "synonyms": [
     "usage",
     "adoption",
     "utilization",
     "…(+3)"
    ]
   },
   {
    "term": "대학원생",
    "english": "graduate students",
    "synonyms": [
     "postgraduate students",
     "doctoral students",
     "PhD students",
     "…(+3)"
    ]
   },
   "…(+3)"
  ],
  "independent_variables": [
   "Generative AI use (whether used, frequency, intensity, duration)",
   "Type of research task supported by AI (literature review, writing/editing, coding, data analysis, ideation, translation)",
   "Mode of use (assistive editing vs. content generation)"
  ],
  "dependent_variables": [
   "Research productivity (number of manuscripts/publications, writing output, time spent per task, thesis progress or completion time, self-rep…",
   "Research quality (expert/rubric-rated writing quality, peer review acceptance, citation impact, methodological rigor, originality, error or …"
  ],
  "moderators_or_context": [
   "Academic discipline (STEM vs. humanities/social sciences)",
   "Degree level (master's vs. doctoral)",
   "AI literacy and prior research experience",
   "…(+5)"
  ],
  "population": "Graduate students (master's and doctoral) enrolled in universities, across disciplines and countries; adjacent populations (early-career res…",
  "ambiguities": [
   "'Generative AI' may mean only LLM chatbots (ChatGPT etc.) or also image/code generators and AI-integrated research tools (Elicit, Consensus,…",
   "'Use' may be binary adoption, frequency, or task-specific use; self-reported use is unreliable",
   "'Research productivity' can be objective output (publications, papers) or perceived efficiency/time savings",
   "…(+4)"
  ],
  "scope_decision": "Define generative AI primarily as LLM-based tools (ChatGPT, Claude, Gemini, Copilot and similar) used for research tasks, including AI resea…",
  "search_start_year": 2022,
  "search_window_reason": "ChatGPT's public release in November 2022 marks the start of widespread generative AI use in academic research, so relevant empirical studie…"
 },
 "plan": {
  "sub_questions": [
   {
    "id": "Q1",
    "question": "How is generative AI use, research productivity, and research quality defined and measured in studies of graduate students and researchers (self-repor…",
    "perspective": "Definitions and measurement",
    "rationale": "Productivity and quality are multidimensional and often self-reported. Knowing which measures exist is needed to compare findings and to judge how val…",
    "search_queries": [
     "measuring generative AI use academic research scale",
     "research productivity measurement LLM-assisted writing",
     "AI-assisted writing quality rubric evaluation graduate"
    ],
    "preferred_tools": [
     "search_openalex",
     "search_semantic_scholar"
    ]
   },
   {
    "id": "Q2",
    "question": "What is the current prevalence and pattern of generative AI adoption among graduate students across research tasks (literature review, writing, coding…",
    "perspective": "Current state / adoption",
    "rationale": "Who uses AI, how, and for which tasks sets the descriptive baseline. It also points to selection effects (more productive students adopting AI) that c…",
    "search_queries": [
     "ChatGPT use doctoral students survey research",
     "postgraduate students generative AI adoption research tasks",
     "대학원생 생성형 AI 활용 연구 실태"
    ],
    "preferred_tools": [
     "search_openalex",
     "search_web",
     "search_semantic_scholar"
    ]
   },
   "…(총 7개)"
  ],
  "inclusion_criteria": [
   "Published from 2022 onward, matching the search window; peer-reviewed articles, preprints, and credible institutional re…",
   "Empirical studies, systematic or scoping reviews, or measurement studies on LLM-based generative AI (ChatGPT, Claude, Ge…",
   "Population of graduate students (master's or doctoral) as core evidence; early-career researchers, academics, or profess…",
   "…(+3)"
  ],
  "success_criteria": [
   "Each sub-question is supported by at least 3 relevant sources, with Q3 including at least 2 experimental, quasi-experime…",
   "Productivity and quality outcomes are reported separately, distinguishing objective from self-reported measures",
   "Counter-evidence (null, negative, or integrity risks) is identified and weighed against positive findings",
   "…(+3)"
  ]
 },
 "syntheses": {
  "Q1": {
   "answer": "제시된 근거에서 생성형 AI 사용, 연구 생산성, 연구 질은 하나의 표준 방식이 아니라 연구마다 서로 다른 방식으로 정의·측정된다. AI 사용은 (1) 자기보고식 채택 여부[S163], (2) 인지적 관여 수준(ICAP 4요인)[S1]이나 리터러시(Marzano 분류체계 기반 5차원·15지표)[S2] 같은 타당화된 척도, (3) 실험적 조건 배정(사용/미사용, 탐지 여부)[S3][S9][S1…",
   "key_findings": [
    {
     "finding": "AI 사용 측정은 단순 채택 여부(응답자의 39%가 사용)[S163]에서 대학원생 대상 다차원 척도로 발전하고 있다. ICAP 기반 척도는 Passive·Active·Constructive·Interactive 4요인으로 구성되며 중국 대학원생 1216명을 대상으로 EFA/CFA로 타당화되었다[S1]. GenAI 리터러시 척도는 5개 1차 차원과 15개 2차 지표로 구성되며 308명 대상으로…",
     "sources": [
      "S163",
      "S1",
      "S2"
     ]
    },
    {
     "finding": "실험·준실험 연구는 AI 사용을 조건 배정으로 조작화한다. 비교 방식은 genAI 미사용 대비 교육 동반 사용[S15], ChatGPT 무작위 노출[S55], ChatGPT 보조 실험군 대비 통제군[S9], ChatGPT 단독 피드백 대비 교수자+ChatGPT 결합 피드백[S7], AI+탐지·AI 무탐지·비AI 통제의 3조건 RCT(계획 단계)[S3] 등이다.",
     "sources": [
      "S15",
      "S55",
      "S9",
      "…(+2)"
     ]
    },
    {
     "finding": "생산성은 주로 과제 소요 시간 같은 객관적 지표로 측정되었다. 작성 시간은 대학원생 대상에서 56.7%[S15], 전문직 대상에서 40%[S55] 감소했다. 반면 학계 설문에서는 연구 생산성이 자기보고된 인지된 산출로 측정되었다[S163]. 한편 [S9]에서는 작성 시간이 점수에 영향을 주지 않았다.",
     "sources": [
      "S15",
      "S55",
      "S163",
      "…(+1)"
     ]
    },
    "…(+2)"
   ],
   "consensus": [
    "AI 사용의 측정 방식은 연구 목적에 따라 다르지만, 대학원생 대상 연구들은 단순 사용 빈도·수용을 넘어 인지적 관여나 리터러시 같은 다차원 구성개념이 필요하다는 데 의견이 모인다[S1][S2].",
    "글쓰기 과제 기반 연구들은 생산성을 시간으로, 질을 평가된 성적이나 품질로 측정하는 공통된 틀을 사용한다[S15][S55][S9][S7]."
   ],
   "disagreements": [
    "측정된 결과는 엇갈린다. [S15][S55][S7]은 질 향상을 보고한 반면, [S9]는 성적 차이가 없다고 보고했다. 차이의 원인으로는 표본 크기([S9]는 18명), 사전 교육 제공 여부([S15]), 과제 유형(에세이 대 전문 글쓰기), 측정 도구의 차이가 가능하다.",
    "[S7]에서는 전반적 질은 향상되었으나 내용 영역에는 변화가 없었다. 이는 질을 총점으로 측정하는지 영역별로 측정하는지에 따라 결론이 달라질 수 있음을 시사한다.",
    "교수의 인식 기반 평가[S134]는 독창성·진실성에 대한 우려를 제기한다. 이는 객관적 성적 기반 평가에서 나타난 긍정적 결과[S15]와 다른 차원의 질을 포착하는 것으로 보인다."
   ],
   "evidence_strength": "moderate",
   "gaps": [
    "대학원생의 실제 연구 산출(논문 수, 게재 학술지 수준, 인용)을 객관적으로 측정한 연구는 없다. 서지계량 연구[S82]는 대학원생 여부가 초록에 명시되지 않았고 결과도 제시되지 않았다.",
    "대부분 연구에서 질 평가 루브릭의 구체적 내용, 평가자 간 신뢰도, 블라인드 여부가 초록에 명시되지 않았다.",
    "[S1][S2] 척도가 생산성이나 질 지표와 어떤 관계인지(준거타당도)는 초록에 명시되지 않았다.",
    "…(+3)"
   ],
   "sources": [
    "S163",
    "S82",
    "S15",
    "…(+7)"
   ]
  },
  "Q2": "…(Q1과 같은 모양, 총 7개)"
 },
 "reflections": [
  {
   "round": 1,
   "final": false,
   "quality_score": 5,
   "subq_assessment": [
    {
     "id": "Q1",
     "coverage": "partial",
     "issue": "The review lists a reasonable range of measures, but rubric details, inter-rater reliability and blinding are not reported. Objective research-output measures come only from one non-graduate bibliomet…"
    },
    {
     "id": "Q2",
     "coverage": "poor",
     "issue": "No usage rate for graduate students is reported, and there is no breakdown by research task. Most studies measure intention to use (TAM/UTAUT-type predictors) rather than actual use. The only figure (…"
    },
    {
     "id": "Q3",
     "coverage": "poor",
     "issue": "The causal core is thin. The graduate-student studies (S15, S7) have unclear randomization and sample sizes. The only graduate RCT (S3) is a protocol with no results. The strongest RCT (S55) uses prof…"
    },
    "…(+3)"
   ],
   "bias_risks": [
    "Graduate-student-specific causal evidence is scarce, so conclusions lean on non-student samples (professionals, crowdworkers, countries).",
    "Evidence on Korea and non-English-native settings rests on a single university study, which is effectively one source counted three times (S32, S36, S37).",
    "Possible double counting of related studies (S113/S19) presented as independent evidence of homogenization.",
    "…(+3)"
   ],
   "should_continue": true,
   "reason": "Q2 (prevalence and task patterns) and Q3 (causal effects on actual research productivity) are both poorly covered and fail the success criteria. The literature probably contains relevant bibliometric …",
   "followup_queries": [
    {
     "subq_id": "Q3",
     "query": "LLM adoption scientists publication output productivity difference-in-differences preprints",
     "tool": "search_arxiv"
    },
    {
     "subq_id": "Q2",
     "query": "doctoral students early-career researchers generative AI use survey prevalence research tasks",
     "tool": "search_openalex"
    },
    {
     "subq_id": "Q2",
     "query": "대학원생 생성형 AI 사용 실태 설문 비율 논문작성 연구",
     "tool": "search_web"
    },
    "…(+1)"
   ],
   "new_sub_questions": [
    {
     "question": "Do generative AI effects on research productivity differ by author language background or country (e.g., Asian or non-English-native researchers) in large-scale publication data?",
     "perspective": "Heterogeneity in bibliometric output",
     "rationale": "This directly links Q3 and Q5 to the Korean context. Bibliometric studies may provide the only objective evidence on productivity at the level of researchers rather than writing tasks.",
     "search_queries": [
      "LLM-assisted writing productivity gains non-native English authors bibliometric",
      "large language models scientific production heterogeneity authors Asia"
     ]
    }
   ]
  },
  "…(총 3개, 마지막은 final=true)"
 ],
 "report_markdown": "(아래 '보고서 본문 발췌' 참조, 전체 18776자)",
 "verification": {
  "cited_ids": 68,
  "unknown_ids": [],
  "claims_total": 193,
  "checks": [
   {
    "claim": "주요 사례는 교육을 동반한 사용 전후 비교 연구 [S15]와 피드백 준실험 [S7]이다.",
    "verdict": "supported",
    "note": "S15는 교육 후 사용 전후 비교, S7은 피드백 집단 비교 연구로 초록과 일치한다."
   },
   {
    "claim": "다만 자기선택된 상관 설계다 [S72].",
    "verdict": "partially supported",
    "note": "사용 여부를 학생이 선택한 비교 설계임은 초록에서 추론되나 '자기선택된 상관 설계'라는 평가는 초록에 명시되어 있지 않다.",
    "revised": "다만 초록에 따르면 ChatGPT 사용 여부에 따라 사용군(33명)과 비사용군(95명)을 비교한 연구이며, 사용군은 기술 사용 빈도와 ChatGPT 사전 경험이 유의하게 높았다; 집단 배정 방식(무작위 여부)은 초록에 명시되어 있지 않다 [S72].",
    "verdict_after": "supported",
    "note_after": "초록에 사용군 33명, 비사용군 95명과 기술 사용 빈도·사전 경험의 유의한 차이가 명시되어 있고, 무작위 배정에 대한 언급은 없다."
   },
   "…(총 10개)"
  ]
 },
 "stats": {
  "total_collected": 229,
  "included": 86,
  "duplicates_merged": 52,
  "by_kind": {
   "peer-reviewed": 60,
   "preprint": 16,
   "web": 9,
   "academic": 1
  },
  "by_study_type": {
   "survey/correlational": 13,
   "mixed methods": 11,
   "RCT/experiment": 11,
   "other": 10,
   "review/commentary": 10,
   "quasi-experiment": 8,
   "longitudinal": 8,
   "qualitative": 6,
   "meta-analysis/systematic review": 5,
   "report/web article": 2,
   "theoretical/conceptual": 2
  },
  "by_direction": {
   "not applicable": 30,
   "mixed": 25,
   "positive": 15,
   "negative": 14,
   "": 2
  },
  "by_year": {
   "2023": 14,
   "2024": 17,
   "2025": 19,
   "2026": 27
  },
  "year_range": [
   2023,
   2026
  ],
  "per_subq": {
   "Q1": 30,
   "Q2": 35,
   "Q3": 33,
   "Q4": 48,
   "Q5": 54,
   "Q6": 33,
   "Q7": 14
  }
 },
 "sources": [
  {
   "sid": "S55",
   "title": "Experimental evidence on the productivity effects of generative artificial intelligence",
   "authors": [
    "Shakked Noy",
    "Whitney Zhang"
   ],
   "year": 2023,
   "venue": "Science",
   "abstract": "We examined the productivity effects of a generative artificial intelligence (AI) technology, the assistive chatbot ChatGPT, in the context of midlevel professional writing tasks. In a preregistered online experiment, we assigned occupation-specific, incentivi…",
   "url": "https://doi.org/10.1126/science.adh2586",
   "doi": "https://doi.org/10.1126/science.adh2586",
   "citations": 2150,
   "origin": "OpenAlex",
   "kind": "peer-reviewed",
   "queries": [
    "experimental evidence productivity effects generative artificial intelligence writing tasks",
    "randomized experiment ChatGPT writing productivity quality"
   ],
   "subqs": [
    "Q1",
    "Q3",
    "Q5",
    "…(+1)"
   ],
   "evaluated": true,
   "relevance": 3,
   "credibility": 1.0,
   "score": 0.985,
   "study_type": "RCT/experiment",
   "method": "사전등록 온라인 무작위 실험, 직업별 인센티브 글쓰기 과제, 시간 및 평가된 품질 측정",
   "sample": "대졸 전문직 종사자 453명(보조 증거, 대학원생 아님)",
   "key_finding": "ChatGPT 노출로 평균 소요 시간이 40% 감소하고 산출물 품질이 18% 향상되었으며 작업자 간 불평등이 감소했다.",
   "direction": "positive",
   "limitation": "대학원생·연구 과제가 아닌 중간 수준 직무 글쓰기이며 단기 과제 기반",
   "included": true,
   "in_report": true,
   "cited": true
  },
  {
   "sid": "S1",
   "title": "Development and Validation of the ICAP GenAI Scale to Measure How Graduate Students Integrate Generative AI Into Academic Research",
   "authors": [
    "Jianzhen Zhang",
    "Weihao Pan",
    "Xiaoyu Liang",
    "…(+1)"
   ],
   "year": 2025,
   "venue": "European Journal of Education",
   "abstract": "ABSTRACT Generative artificial intelligence (GenAI) has profoundly reshaped how graduate students conceptualise, design and conduct academic research in higher education. While current metrics predomi…",
   "url": "https://doi.org/10.1111/ejed.70209",
   "doi": "https://doi.org/10.1111/ejed.70209",
   "citations": 6,
   "origin": "OpenAlex",
   "kind": "peer-reviewed",
   "queries": [
    "generative AI use scale graduate students research"
   ],
   "subqs": [
    "Q1",
    "Q2"
   ],
   "evaluated": true,
   "relevance": 3,
   "credibility": 0.78,
   "score": 0.867,
   "study_type": "survey/correlational",
   "method": "ICAP 프레임워크 기반 척도 개발·타당화(체계적 문헌고찰, 전문가 검토, EFA/CFA)",
   "sample": "중국 대학원생 1216명, 5개 학문 분야",
   "key_finding": "대학원생의 연구 내 GenAI 통합을 Passive, Active, Constructive, Interactive 4요인으로 측정하는 척도가 도출됨.",
   "direction": "not applicable",
   "limitation": "사용 방식 측정 도구일 뿐 생산성·질 결과와의 연관은 초록에 제시되지 않음; 중국 표본에 한정.",
   "included": true,
   "in_report": true,
   "cited": true
  },
  "…(총 229개, 채택 86개)"
 ],
 "trace": [
  {
   "ts": "2026-11-02T07:13:54",
   "stage": "understand",
   "kind": "understanding",
   "msg": "분야=Higher education research / educational technology, with links to science of science (scientometrics) and human-computer interaction | 유형=causal-effect | 개념=generative artificial intelligence, use / adoption, graduate students, research productivity, research quality, research integrity / academic integrity"
  },
  {
   "ts": "2026-11-02T07:13:54",
   "stage": "understand",
   "kind": "window",
   "msg": "검색 기간: 2022년 이후 (에이전트 판단: ChatGPT's public release in November 2022 marks the start of widespread generative AI use in academic research, so relev)"
  },
  {
   "ts": "2026-11-02T07:14:14",
   "stage": "plan",
   "kind": "plan",
   "msg": "하위 질문 6개 수립"
  },
  {
   "ts": "2026-11-02T07:14:48",
   "stage": "act",
   "kind": "subq_done",
   "msg": "Q1 탐색 완료: 관련 후보 25건. I found enough sources to map how studies measure each of the three things in Q1. The main gap is objective, bibliometric measures of productivity at "
  },
  "…(총 22개)"
 ]
}
```

## 보고서 본문 발췌 (`report_markdown`)

본문은 `# 제목` → `## 1. …` ~ `## 8. …` 여덟 절로 이루어진다. 굵은 글씨, 중첩 목록, 표, 표 칸 안의 `<br>`, `[S12]` · `[S1][S2]` · `[S3, S4]` 인용이 나온다.

````markdown
# 생성형 AI 활용이 대학원생의 연구 생산성과 연구 품질에 미치는 영향: 연구 브리프

## 1. 핵심 요약

- **대학원생에 대한 인과 근거는 약하다(weak).** 이 브리프를 위해 수집한 근거에서 대학원생을 직접 대상으로 효과를 추정한 연구는 소수다. 주요 사례는 교육을 동반한 사용 전후 비교 연구 [S15]와 피드백 준실험 [S7]이다. 대학원생 대상 무작위 대조시험(RCT)은 프로토콜 단계에 머물러 있다 [S3]. 가장 엄밀한 실험 근거는 대학원생이 아닌 집단에서 나왔다. 대졸 전문직 453명 대상 RCT [S55]와 일반 온라인 작가 실험 [S113]이 그 예다.

- **'과제 수준 시간 절감'은 비교적 일관되지만, '연구 산출 수준 생산성' 증가는 관찰적 연관에 머문다.** 작성 시간은 대학원생에서 56.7% [S15], 전문직에서 40% [S55] 감소했다. 코딩 과제 완료도 55.8% 빨라졌다 [S53]. 반면 논문 수·인용과의 관계는 모두 관찰 연구에서 나온 것이며 대학원생에 특정되지 않는다. 연구자 자기보고에 따른 인지된 생산성 [S163], 생의학 논문의 완만한 연관 [S197], 'AI 증강' 과학자의 논문 3.02배 [S90](프리프린트, 생성형 AI 한정 여부 불명)이 이에 해당한다.

- **품질 효과는 '표면적 언어 품질 향상'과 '심층 품질 불확실성·집단적 비용'으로 나뉜다.** 문법·형식 같은 언어 품질은 향상되었다 [S7][S15][S55]. 그러나 내용 영역은 변화가 없거나 [S7] 점수 효과가 없었다 [S9]. AI에 전적으로 의존한 쓰기는 이해 정확도를 25.1% 낮췄다 [S144]. 개인 수준의 질 향상과 함께 산출물 간 유사성 증가 [S113], 연구 주제 범위 축소 [S90], 비영어권 저자의 의미 신규성 상대적 감소 [S198] 같은 집단 수준 비용 신호도 보고되었다.

- **영어 비모국어(EAL) 지위는 가장 근거가 많은 조절변수이며, 방향은 양날적이다.** 품질 향상은 비원어민 대학원생에서 더 컸다 [S15]. 반면 AI 탐지기는 비원어민 글을 오분류하는 경향을 보였다 [S118][S155]. 이 결과는 언어·탐지기·문체에 따라 달라진다 [S119][S153]. 미국 STEM 박사논문에서는 AI 작성 텍스트가 비영어권 출신에서 더 흔했고, 사용자는 학계 연구직 진입 가능성이 낮았다 [S218](프리프린트, 연관성).

- **측정이 이 분야의 핵심 병목이다.** 탐지기 기반 노출 지표는 위양성률이 탐지기별로 0.0%~100.0%에 이를 만큼 불안정하다 [S153]. 자기공개 방식은 과소보고 위험이 크다(LLM 사용을 밝힌 리뷰 15.1% [S158]). 한국 근거는 두 건뿐이다. 하나는 6명 대상 질적 연구이고 [S221], 다른 하나는 431명 설문인데 결과 수치가 초록에 제시되지 않았다 [S36]. 따라서 한국 특정 결론은 내릴 수 없다.

## 2. 주제 이해

### 2.1 핵심 개념과 조작적 정의

| 개념 | 이 브리프의 조작적 정의 | 수집된 근거에서 관찰된 측정 방식 |
|---|---|---|
| 생성형 AI | ChatGPT·Claude·Gemini·Copilot 등 LLM 기반 도구 및 LLM 기반 연구 보조 도구(비생성형 분석 AI는 제외) | 채택 여부 [S163], 인지적 관여(ICAP 4요인) [S1], 리터러시(5차원·15지표) [S2], 실험 조건 배정 [S9][S15][S55], 텍스트 분류기·어휘 신호 기반 추정 [S20][S74][S82] |
| 활용 | 사용 여부·빈도·강도, 과업 유형(문헌검토·글쓰기·코딩·분석·번역), 사용 방식(편집 대 생성) | 사용 의도 [S26][S30], 습관·실제 사용 [S5], 사용 방식 비교(완전 의존 대 요약 사용 [S144], 직접 내용 생성 보조 [S19]) |
| 대학원생 | 석·박사과정생(핵심). 초기경력 연구자·학계 연구자는 보조 근거로 표시 | 대학원생 표본 [S1][S2][S5][S7][S15][S28][S30][S221][S222][S223], 박사논문 [S218] |
| 연구 생산성 | (a) 객관적 산출(원고·출판·과제 시간·학위 진척)과 (b) 자기보고 효율을 구분 | 과제 소요 시간 [S15][S55], 인지된 생산성 [S163], 출판량 [S90][S197] |
| 연구 품질 | (a) 루브릭·전문가 평가, (b) 동료평가·인용, (c) 오류·진실성 지표, (d) 인식된 품질을 구분 | 성적·평가 등급 [S9][S15][S55], 영역별 평가 [S7], 인용 [S74][S82], 의미 신규성 [S198], 참고문헌 정확도 [S96][S98], 교수 인식 [S134] |

### 2.2 변수 구조

- **독립변수**는 생성형 AI 사용(여부·빈도·강도), 지원 과업 유형, 사용 방식(보조적 편집 대 내용 생성)이다.
- **종속변수**는 연구 생산성(객관 또는 자기보고)과 연구 품질(평가 품질, 출판·인용, 오류·진실성, 인식 품질)이다.
- **조절·맥락 변수**는 학문 분야, 학위 수준, AI 리터러시·사전 경험, EAL 지위, 기관·학술지 정책, 지도교수 지도, 국가 맥락(한국 포함), 도구·모델 버전이다.

### 2.3 범위와 검색 창

- 검색 시작 연도는 2022년이다. ChatGPT가 2022년 11월 공개된 이후 학술 연구에서 생성형 AI 사용이 확산되었기 때문이다. 실제로 포함된 근거의 출판 연도는 2023–2026년이다.
- 총 229건을 수집해 86개 출처를 포함했다. 중복 사본을 정리하면 약 83개 연구다. S201·S202·S203은 동일 연구이고, S36·S37도 동일 연구다.
- 연구 유형 분포는 동료심사 60건, 프리프린트 16건, 웹 9건이다. 설계별로는 RCT/실험 11건, 준실험 8건, 종단 8건, 설문/상관 13건, 혼합방법 11건, 질적 6건 등이다.
- Semantic Scholar 검색 도구를 사용할 수 없었다. 따라서 컴퓨터과학·arXiv 인접 문헌의 포괄성이 제한될 수 있다.
- 인과 주장은 실험·준실험·종단 설계를 우선한다. 설문·질적 연구는 기술적 맥락으로만 사용한다.

## 3. 하위 질문별 주요 결과

### Q1. 생성형 AI 사용, 연구 생산성, 연구 품질은 어떻게 정의·측정되는가? — 근거 강도: **중간(moderate)**

- **AI 사용 측정 방식**
  - 단순 채택 여부: 응답자의 39%가 사용 [S163].
  - 대학원생 대상 다차원 척도: 중국 대학원생 1,216명으로 타당화한 ICAP 기반 4요인(Passive·Active·Constructive·Interactive) 척도 [S1], 대학원생 308명 대상의 5개 1차 차원·15개 2차 지표 리터러시 척도 [S2].
  - 두 척도가 생산성·품질 지표와 어떤 관계인지(준거타당도)는 초록에 명시되지 않았다.
- **실험적 조작화 방식**
  - genAI 미사용 대비 교육 동반 사용 [S15].
  - ChatGPT 무작위 노출 [S55].
  - 실험군 대 통제군 [S9].
  - ChatGPT 단독 피드백 대 교수자+ChatGPT 결합 피드백 [S7].
  - AI+탐지·AI 무탐지·비AI 통제의 3조건 RCT(계획 단계) [S3].
- **생산성 측정 방식**
  - 과제 시간 같은 객관 지표 [S15][S55].
  - 자기보고된 인지 산출 [S163].
  - 의대생 연구에서는 체계적 문헌고찰 작성 기간이 사용됨(2–3일 내 완료 69.7% 대 48.4%) [S72].
- **품질 측정 방식**
  - 과제 성적(A-→A [S15], 양 집단 모두 평균 C [S9]), 평가 품질(18% 향상 [S55]).
  - 영역별 평가(문법·형식·어조·조직·내용·전반적 질) [S7].
  - 교수 인식 [S134], 체계적 문헌고찰 품질 점수 [S72].
  - 'scientific slop' 지표와 ICLR 평점의 연관 [S152].
  - 대부분 연구에서 루브릭 내용, 평가자 간 신뢰도, 블라인드 여부는 초록에 명시되지 않았다.
- **서지계량 측정 방식**
  - arXiv 논문 234,073편에 텍스트 분류기로 LLM 사용을 추정하고 인용 성과와 연결했다. 다만 초록이 잘려 결과는

…(중략)…

## 3. 하위 질문별 주요 결과

### Q1. 생성형 AI 사용, 연구 생산성, 연구 품질은 어떻게 정의·측정되는가? — 근거 강도: **중간(moderate)**

- **AI 사용 측정 방식**
  - 단순 채택 여부: 응답자의 39%가 사용 [S163].
  - 대학원생 대상 다차원 척도: 중국 대학원생 1,216명으로 타당화한 ICAP 기반 4요인(Passive·Active·Constructive·Interactive) 척도 [S1], 대학원생 308명 대상의 5개 1차 차원·15개 2차 지표 리터러시 척도 [S2].
  - 두 척도가 생산성·품질 지표와 어떤 관계인지(준거타당도)는 초록에 명시되지 않았다.
- **실험적 조작화 방식**
  - genAI 미사용 대비 교육 동반 사용 [S15].
  - ChatGPT 무작위 노출 [S55].
  - 실험군 대 통제군 [S9].
  - ChatGPT 단독 피드백 대 교수자+ChatGPT 결합 피드백 [S7].
  - AI+탐지·AI 무탐지·비AI 통제의 3조건 RCT(계획 단계) [S3].
- **생산성 측정 방식**
  - 과제 시간 같은 객관 지표 [S15][S55].
  - 자기보고된 인지 산출 [S163].
  - 의대생 연구에서는 체계적 문헌고찰 작성 기간이 사용됨(2–3일 내 완료 69.7% 대 48.4%) [S72].
- **품질 측정 방식**
  - 과제 성적(A-→A [S15], 양 집단 모두 평균 C [S9]), 평가 품질(18% 향상 [S55]).
  - 영역별 평가(문법·형식·어조·조직·내용·전반적 질) [S7].
  - 교수 인식 [S134], 체계적 문헌고찰 품질 점수 [S72].
  - 'scientific slop' 지표와 ICLR 평점의 연관 [S152].
  - 대부분 연구에서 루브릭 내용, 평가자 간 신뢰도, 블라인드 여부는 초록에 명시되지 않았다.
- **서지계량 측정 방식**
  - arXiv 논문 234,073편에 텍스트 분류기로 LLM 사용을 추정하고 인용 성과와 연결했다. 다만 초록이 잘려 결과는 확인할 수 없다 [S82].
  - 미국 STEM 박사논문에서 AI 작성 텍스트 비율을 추정한 연구가 있다 [S218]. 탐지 방법과 정확도는 제공된 요약에서 확인되지 않는다.

### Q2. 대학원생의 생성형 AI 채택 수준과 과업별 사용 패턴은? — 근거 강도: **약함(weak)**

- **대학원생 사용률**
  - 수집된 근거에서 대학원생만을 대상으로 한 자기보고 사용률(%)은 초록에서 확인되지 않았다.
  - 유일한 대학원생 관련 수치는 텍스트 기반 추정이다. 미국 STEM 박사논문에서 AI 작성 텍스트는 2023년 이전에는 나타나지 않았으나 2026년 논문의 29%에서 나타났다 [S218](프리프린트).
- **인접 모집단의 사용률은 정의·시점·모집단에 따라 차이가 크다.**
  - 독일 대학생 6,300명 이상 중 약 3분의 2 [S31](학위과정 구성은 초록에 명시되지 않음).
  - 이탈리아 학계 연구자 39% [S163].

…(이하 생략)…
````

본문 통계: 전체 18776자, 줄 359개, 표 행 15줄, `###` 제목 16개, `<br>` 0회.

## events.jsonl 발췌 (한 줄 = 한 이벤트)

```json
{"seq": 1, "ts": "2026-11-02T07:13:35", "stage": "system", "kind": "log", "msg": "연구 주제: 생성형 AI 활용이 대학원생의 연구 생산성과 연구 품질에 미치는 영향", "data": null}
{"seq": 2, "ts": "2026-11-02T07:13:54", "stage": "understand", "kind": "understanding", "msg": "분야=Higher education research / educational technology, with links to science of science (scientometrics) and human-computer interaction | 유형=causal-effect | 개념=generative artificial intelligence, use …", "data": {"topic": "생성형 AI 활용이 대학원생의 연구 생산성과 연구 품질에 미치는 영향", "discipline": "Higher education research / educational technology, with links to science of science (scientometrics) and human-computer interaction", "research_type": "causal-effect", "concepts": ["generative artificial intelligence", "use / adoption", "graduate students", "…(+3)"], "requirements": []}}
{"seq": 3, "ts": "2026-11-02T07:13:54", "stage": "understand", "kind": "window", "msg": "검색 기간: 2022년 이후 (에이전트 판단: ChatGPT's public release in November 2022 marks the start of widespread generative AI use in academic research, so relev)", "data": {"year_from": 2022, "source": "agent", "reason": "ChatGPT's public release in November 2022 marks the start of widespread generative AI use in academic research, so relevant empirical studies appear from late 2022 onward (earlier GPT-3 writing-tool w…"}}
{"seq": 4, "ts": "2026-11-02T07:14:14", "stage": "plan", "kind": "plan", "msg": "하위 질문 6개 수립", "data": {"sub_questions": [{"id": "Q1", "question": "How is generative AI use, research productivity, and research quality defined and measured in studies of graduate students and researchers (self-report scales, objective output, rubric ratings, biblio…", "perspective": "Definitions and measurement"}, {"id": "Q2", "question": "What is the current prevalence and pattern of generative AI adoption among graduate students across research tasks (literature review, writing, coding, analysis, translation), including in Korea?", "perspective": "Current state / adoption"}, {"id": "Q3", "question": "What do experimental, quasi-experimental, and longitudinal/bibliometric studies show about the causal effect of generative AI use on research or writing productivity and quality among graduate student…", "perspective": "Empirical causal effects"}, "…(+3)"], "revised": false}}
{"seq": 5, "ts": "2026-11-02T07:14:32", "stage": "act", "kind": "tool", "msg": "Q1 · search_openalex('generative AI use scale graduate students research') → 6건 (누적 6)", "data": {"subq": "Q1", "tool": "search_openalex", "query": "generative AI use scale graduate students research", "count": 6, "total": 6}}
{"seq": 6, "ts": "2026-11-02T07:14:32", "stage": "act", "kind": "tool_error", "msg": "search_semantic_scholar('LLM-assisted writing scientific productivity bibliometric') 오류: 요청 실패: 429 rate limited", "data": {"subq": "", "tool": "search_semantic_scholar", "query": "LLM-assisted writing scientific productivity bibliometric", "error": "요청 실패: 429 rate limited"}}
{"seq": 11, "ts": "2026-11-02T07:14:48", "stage": "act", "kind": "subq_done", "msg": "Q1 탐색 완료: 관련 후보 25건. I found enough sources to map how studies measure each of the three things in Q1. The main gap is objective, bibliometric measures of productivity at ", "data": {"subq": "Q1", "found": 25, "summary": "I found enough sources to map how studies measure each of the three things in Q1. The main gap is objective, bibliometric measures of productivity at "}}
{"seq": 19, "ts": "2026-11-02T07:15:38", "stage": "act", "kind": "tool_disabled", "msg": "search_semantic_scholar 연속 3회 실패 → 이번 실행에서 제외", "data": {"tool": "search_semantic_scholar"}}
{"seq": 51, "ts": "2026-11-02T07:23:38", "stage": "evaluate", "kind": "evaluate", "msg": "평가 168건 → 채택(관련성≥2) 누적 63건 / 전체 168건 (중복 판본 병합 누적 34건)", "data": {"evaluated": 168, "included": 63, "total": 168, "merged": 34}}
{"seq": 52, "ts": "2026-11-02T07:24:04", "stage": "synthesize", "kind": "synthesis", "msg": "Q1 종합 완료 (근거 10건, 강도=moderate)", "data": {"subq": "Q1", "n": 10, "strength": "moderate"}}
{"seq": 58, "ts": "2026-11-02T07:26:34", "stage": "reflect", "kind": "reflection", "msg": "라운드 1: 품질 5/10, 계속=True — Q2 (prevalence and task patterns) and Q3 (causal effects on actual research productivity) are both poorly covered and fail the success criteria. The l", "data": {"round": 1, "final": false, "quality_score": 5, "should_continue": true, "reason": "Q2 (prevalence and task patterns) and Q3 (causal effects on actual research productivity) are both poorly covered and fail the success criteria. The literature probably contains relevant bibliometric …", "bias_risks": ["Graduate-student-specific causal evidence is scarce, so conclusions lean on non-student samples (professionals, crowdworkers, countries).", "Evidence on Korea and non-English-native settings rests on a single university study, which is effectively one source counted three times (S32, S36, S37).", "Possible double counting of related studies (S113/S19) presented as independent evidence of homogenization.", "…(+3)"]}}
{"seq": 63, "ts": "2026-11-02T07:26:38", "stage": "reflect", "kind": "replan", "msg": "새 하위 질문 추가 Q7: Do generative AI effects on research productivity differ by author language background or country (e.g., Asian or non-English-native researchers) in large-scale publication data?", "data": {"subq": "Q7", "question": "Do generative AI effects on research productivity differ by author language background or country (e.g., Asian or non-English-native researchers) in large-scale publication data?"}}
{"seq": 88, "ts": "2026-11-02T07:33:41", "stage": "report", "kind": "report", "msg": "보고서 근거 86건 전달 (종합에서 다룬 48건 전부 포함, 채택 86건 중)", "data": {"evidence": 86, "used": 48}}
{"seq": 90, "ts": "2026-11-02T07:37:12", "stage": "verify", "kind": "verify", "msg": "인용 ID 68개, 미존재 0개, 표본 10문장 중 완전 지지 6", "data": {"cited_ids": 68, "unknown": 0, "checked": 10, "supported": 6}}
{"seq": 91, "ts": "2026-11-02T07:37:25", "stage": "verify", "kind": "repair", "msg": "미지지·부분지지 4문장 중 4문장 수정 → 재검증 후 완전 지지 10/10", "data": {"bad": 4, "fixed": 4, "supported_after": 10, "checked": 10}}
```

## run.json (상태 스냅샷)

```json
{
 "id": "sample_genai_graduate_research",
 "status": "done",
 "prompt": "생성형 AI 활용이 대학원생의 연구 생산성과 연구 품질에 미치는 영향",
 "topic": "생성형 AI 활용이 대학원생의 연구 생산성과 연구 품질에 미치는 영향",
 "model": "claude-opus-5-5",
 "model_label": "Claude Opus 5.5",
 "config": {
  "model": "claude-opus-5-5",
  "depth": "standard",
  "min_subq": 4,
  "max_subq": 6,
  "max_reflection_rounds": 2,
  "max_tool_steps": 4,
  "results_per_search": 6,
  "verify_sample": 10,
  "year_from": null,
  "language": "ko",
  "human_in_the_loop": false,
  "parallelism": 1,
  "formats": [
   "md",
   "html"
  ]
 },
 "created_at": "2026-11-02T07:13:35",
 "started_at": "2026-11-02T07:13:35",
 "finished_at": "2026-11-02T07:37:25",
 "elapsed_s": 1428.0,
 "stage": "done",
 "round": 2,
 "progress": null,
 "counts": {
  "collected": 229,
  "included": 86,
  "merged": 52,
  "report_evidence": 86,
  "sub_questions": 7
 },
 "usage": {
  "calls": 79,
  "input_tokens": 419170,
  "output_tokens": 135059,
  "cost_usd": 4.38
 },
 "awaiting": null,
 "error": null,
 "formats": [
  "md",
  "html"
 ],
 "has_result": true,
 "sample": true,
 "demo": false,
 "note": "중간고사 제출 버전(Colab 노트북)으로 실제 실행한 결과를 웹 앱 형식으로 옮긴 샘플입니다."
}
```
