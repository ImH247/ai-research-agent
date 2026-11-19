"""근거 기반 후속 질문 (SPEC 4.6). 끝난 실행의 result만 가지고 답한다(새 검색은 하지 않음)."""
from __future__ import annotations

import re

from agent.prompts import ABSTRACT_RULE, SYS_BASE

_CITE = re.compile(r"\[S\d+(?:\s*,\s*S\d+)*\]")


def _cited(text: str) -> list[str]:
    """[S3], [S1, S2] 형식으로 인용된 ID를 처음 나온 순서대로 (pipeline.cited_ids와 같은 규칙)."""
    return list(dict.fromkeys(re.findall(r"S\d+", " ".join(_CITE.findall(text or "")))))


def retrieve(result: dict, question: str, k: int = 8) -> list[dict]:
    """채택 문헌에서 질문과 가까운 근거 상위 k개: TF-IDF 유사도(0.7) + 평가 점수(0.3)."""
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.metrics.pairwise import cosine_similarity
    pool = [s for s in result.get("sources") or [] if s.get("included")]
    if not pool:
        return []
    docs = [f"{s.get('title', '')} {s.get('abstract', '')} {s.get('key_finding', '')}" for s in pool]
    try:
        vec = TfidfVectorizer(stop_words="english", ngram_range=(1, 2), sublinear_tf=True).fit(docs + [question])
        sims = cosine_similarity(vec.transform([question]), vec.transform(docs))[0]
    except ValueError:   # 어휘가 비어 있는 극단적인 경우 → 점수만으로 순위
        sims = [0.0] * len(pool)
    top = max(sims) or 1
    ranked = sorted(zip(pool, sims), key=lambda x: -(0.7 * x[1] / top + 0.3 * float(x[0].get("score") or 0)))
    return [s for s, _ in ranked[:k]]


def _evidence_line(s: dict) -> str:
    authors = s.get("authors") or []
    who = (authors[0] + (" et al." if len(authors) > 1 else "")) if authors else "Unknown"
    return (f"[{s['sid']}] {who} ({s.get('year') or 'n.d.'}) | type: {s.get('study_type') or s.get('kind') or ''} | "
            f"sample: {s.get('sample') or ''} | key finding: {s.get('key_finding') or ''}\n"
            f"    Title: {s.get('title', '')}\n    Abstract: {(s.get('abstract') or '')[:900]}")


def _related_syntheses(result: dict, sids: set, n: int = 2) -> list[str]:
    """검색된 근거를 가장 많이 쓴 하위 질문 종합의 answer (최대 n개)."""
    questions = {q.get("id"): q.get("question", "") for q in (result.get("plan") or {}).get("sub_questions") or []}
    scored = []
    for qid, syn in (result.get("syntheses") or {}).items():
        overlap = len(sids & set(syn.get("sources") or []))
        if overlap and syn.get("answer"):
            scored.append((overlap, qid, syn["answer"]))
    scored.sort(key=lambda x: -x[0])
    return [f"{qid}. {questions.get(qid, '')}\n{answer}" for _, qid, answer in scored[:n]]


def answer_question(llm, result: dict, question: str, history: list[dict] | None = None) -> dict:
    """근거와 보고서 발췌(하위 질문 종합)만으로 답한다. → {"answer_markdown", "sources": [실제로 있는 인용 ID]}"""
    lang = result.get("lang") or "ko"
    evidence = retrieve(result, question)
    sids = {s["sid"] for s in evidence}
    recent = [f"Q: {h.get('question', '')}\nA: {(h.get('answer_markdown') or '')[:600]}" for h in (history or [])[-3:]]
    syntheses = _related_syntheses(result, sids)
    system = (SYS_BASE + " Answer follow-up questions about a finished literature review using ONLY the evidence and "
              "report excerpts given below. Do not use outside knowledge; if the evidence is insufficient, say so plainly. "
              + ABSTRACT_RULE)
    prompt = f"""Research topic: {result.get('topic', '')}
Follow-up question: {question}

Recent Q&A (context only):
{chr(10).join(recent) or '(none)'}

Evidence:
{chr(10).join(_evidence_line(s) for s in evidence) or '(no relevant evidence)'}

Related sub-question syntheses (report excerpts):
{chr(10).join(syntheses) or '(none)'}

Rules: cite evidence IDs like [S3] right after each claim, using only the IDs listed above.
Answer in Markdown, concisely (about 150-400 words). Write the answer in language "{lang}"."""
    text = llm.text(system, prompt, effort="medium", max_tokens=8000)
    known = {s.get("sid") for s in result.get("sources") or []}
    return {"answer_markdown": (text or "").strip(), "sources": [s for s in _cited(text) if s in known]}
