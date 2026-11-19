"""내보내기 공통 헬퍼: 문헌 표기, 메타 정보, 라벨. 모든 형식(md · html · docx · pptx · 참고문헌)이 같은 표기를 쓰게 한다.
입력은 항상 result dict(SPEC 3.2)이고, 키가 없거나 빈 값이어도 죽지 않는다."""
from __future__ import annotations

import re

VERDICTS = ["supported", "partially supported", "not in source text", "contradicted"]
CITE_RE = re.compile(r"\[S\d+(?:\s*,\s*S\d+)*\]")      # 본문 인용 표기: [S3] 또는 [S3, S12]

# 보고서 언어별 고정 문구 (노트북 ⑥ 셀의 LABELS)
LABELS = {
    "ko": dict(title="연구 조사 보고서", topic="연구 주제", gen="생성", model="모델", stats="수집/채택 문헌",
               window="검색 기간", nolimit="제한 없음", since="년 이후", merged="중복 판본 병합", sent="보고서 전달 근거",
               tableA="부록 A. 근거 비교표", refB="부록 B. 참고문헌", verC="부록 C. 인용 검증", traceD="부록 D. 에이전트 수행 기록",
               after="수정 후", before="수정 전", cols=["ID", "문헌 · 유형", "방법 · 표본", "핵심 결과", "방향 · 점수"],
               contents="목차", minutes="분", calls="LLM 호출", tokens="토큰", cost="예상 비용", checked="검증 문장",
               cited="인용 ID", claims="인용 문장"),
    "en": dict(title="Research Brief", topic="Topic", gen="Generated", model="Model", stats="Collected/included sources",
               window="Search window", nolimit="no limit", since=" onward", merged="duplicate versions merged",
               sent="sources given to report", tableA="Appendix A. Evidence table", refB="Appendix B. References",
               verC="Appendix C. Citation check", traceD="Appendix D. Agent trace", after="after revision", before="before",
               cols=["ID", "Source · type", "Method · sample", "Key finding", "Direction · score"],
               contents="Contents", minutes="min", calls="LLM calls", tokens="tokens", cost="est. cost", checked="claims checked",
               cited="cited ids", claims="claims with citations"),
}


def labels(result: dict) -> dict:
    return LABELS.get(result.get("lang"), LABELS["en"])


def short_cite(s: dict) -> str:
    """'Smith et al. (2024)' 형태의 짧은 표기 (노트북 Source.short_cite와 같은 규칙)."""
    names = [n for n in (s.get("authors") or []) if n and n.split()]
    parts = names[0].replace(",", " ").split() if names else []
    # "John Smith" → Smith, "Kim J"(Europe PMC 형식) → Kim
    a = (parts[-1] if len(parts[-1].strip(".")) > 2 or len(parts) == 1 else parts[0]) if parts else (s.get("venue") or "n.a.")
    etal = " et al." if len(names) > 1 else ""
    return f"{a}{etal} ({s.get('year') or 'n.d.'})"


def authors_text(s: dict, n: int = 3) -> str:
    authors = [a for a in (s.get("authors") or []) if a]
    return ", ".join(authors[:n]) + (" et al." if len(authors) > n else "")


def safe_url(s: dict) -> str:
    """http(s) 주소만 돌려준다 (그 외는 빈 문자열)."""
    url = (s.get("url") or s.get("doi") or "").strip()
    return url if url.startswith(("http://", "https://")) else ""


def sources_by_id(result: dict) -> dict[str, dict]:
    return {s["sid"]: s for s in result.get("sources") or [] if s.get("sid")}


def included_sources(result: dict) -> list[dict]:
    """채택 문헌(관련성 ≥ 2), 종합 점수 높은 순."""
    return sorted([s for s in result.get("sources") or [] if s.get("included")], key=lambda s: -(s.get("score") or 0))


def reference_sources(result: dict) -> list[dict]:
    """참고문헌 목록용: 채택 문헌, S 번호순."""
    return sorted(included_sources(result), key=lambda s: int(s["sid"][1:]))


def cited_ids(text: str) -> list[str]:
    """글에서 인용된 S 번호를 처음 나온 순서대로."""
    return list(dict.fromkeys(re.findall(r"S\d+", " ".join(CITE_RE.findall(text or "")))))


def window_label(result: dict) -> str:
    L, y = labels(result), (result.get("meta") or {}).get("year_from")
    return f"{y}{L['since']}" if y else L["nolimit"]


def meta_info(result: dict) -> dict:
    """머리말·표지에 쓰는 값 모음 (문자열/숫자, 없으면 빈 값)."""
    meta = result.get("meta") or {}
    usage, counts = meta.get("usage") or {}, meta.get("counts") or {}
    stamp = (meta.get("finished_at") or meta.get("created_at") or "")[:16].replace("T", " ")
    return {
        "date": stamp, "model": meta.get("model_label") or meta.get("model") or "", "window": window_label(result),
        "collected": counts.get("collected", len(result.get("sources") or [])),
        "included": counts.get("included", len(included_sources(result))),
        "merged": counts.get("merged", 0), "report_evidence": counts.get("report_evidence", 0),
        "minutes": round((meta.get("elapsed_s") or 0) / 60, 1),
        "calls": usage.get("calls", 0), "input_tokens": usage.get("input_tokens", 0),
        "output_tokens": usage.get("output_tokens", 0), "cost_usd": usage.get("cost_usd"),
        "note": meta.get("note") or "",
    }


def verdict_tally(checks: list[dict], after: bool = False) -> dict[str, int]:
    """판정별 문장 수. after=True면 수정된 문장은 재검증 판정으로 센다."""
    out = {v: 0 for v in VERDICTS}
    for c in checks or []:
        v = (c.get("verdict_after") if after else None) or c.get("verdict")
        if v in out:
            out[v] += 1
    return out
