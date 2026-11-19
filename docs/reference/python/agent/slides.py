"""슬라이드 개요: 완성된 브리프를 발표용 개요로 압축한다.

- make_outline(llm, result): LLM 1회 호출로 개요를 만든다(실패하면 None).
- fallback_outline(result): LLM 없이 syntheses · report_markdown에서 규칙으로 만든다(항상 성공).
- normalize_outline(outline, result): 개수·길이 제한을 지키게 다듬고 모든 키를 채운다.
두 개요는 같은 모양이다(SPEC 4.7)."""
from __future__ import annotations

import re

from agent.prompts import ABSTRACT_RULE, SYS_BASE
from agent.schema import A, E, O, S
from exporters.common import CITE_RE, cited_ids, sources_by_id

STRENGTHS = ["strong", "moderate", "weak", "insufficient"]
FUTURE_KEYS = ["title", "question", "design", "sample", "contribution"]

# 개수 · 글자 수 제한 (SPEC 4.7의 개수 + 슬라이드에 들어가는 길이)
LIMITS = {
    "title": 120, "subtitle": 100, "headline": 80,
    "summary": (5, 110), "bullets": (4, 120), "agreements": (4, 130), "conflicts": (4, 130),
    "gaps": (6, 120), "limitations": (5, 130), "must_read": (5, 120), "findings": 10,
    "future_studies": 3,
    "future_field": {"title": 60, "question": 160, "design": 160, "sample": 120, "contribution": 150},
}

OUTLINE_SCHEMA = O(
    title=S, subtitle=S, summary=A(S),
    findings=A(O(subq_id=S, headline=S, bullets=A(S), strength=E(*STRENGTHS))),
    agreements=A(S), conflicts=A(S), gaps=A(S),
    future_studies=A(O(title=S, question=S, design=S, sample=S, contribution=S)),
    must_read=A(O(sid=S, why=S)),
    limitations=A(S),
)

_SENT_END = re.compile(r"[.!?。](?=\s|$)")
_CITE_WS = re.compile(r"\s*" + CITE_RE.pattern)


# ---------------------------------------------------------------- 글자 다듬기

def clean(text) -> str:
    """Markdown 강조·<br>·연속 공백을 걷어 낸 한 줄 문자열."""
    s = str(text or "")
    s = re.sub(r"<br\s*/?>", " ", s, flags=re.I)
    s = s.replace("**", "").replace("__", "").replace("`", "")
    return re.sub(r"\s+", " ", s).strip()


def _cut(s: str, n: int) -> str:
    """n자 이내에서 문장 끝, 없으면 단어 경계에서 자른다."""
    ends = [m.end() for m in _SENT_END.finditer(s) if m.end() <= n]
    if ends and ends[-1] >= n * 0.5:
        return s[:ends[-1]].strip()
    head = s[:n - 1]
    sp = head.rfind(" ")
    if sp >= n * 0.5:
        head = head[:sp]
    return head.rstrip(" ,;:·(—-") + "…"


def clip(text, n: int) -> str:
    """n자 이내로 줄인다. 인용 [S#]는 중간에서 자르지 않고, 잘라야 하면 앞의 3개를 문장 끝에 모아 둔다."""
    s = clean(text)
    if len(s) <= n:
        return s
    ids = cited_ids(s)[:3]
    tail = f" [{', '.join(ids)}]" if ids else ""
    body = _CITE_WS.sub("", s).strip()
    room = max(n - len(tail), 10)
    if len(body) > room:
        body = _cut(body, room)
    if tail and body.endswith("."):
        return body[:-1] + tail + "."
    return body + tail


def _sentences(text: str) -> list[str]:
    return [x for x in re.split(r"(?<=[.!?。])\s+", clean(text)) if x]


def first_sentences(text, n: int) -> str:
    """앞 문장 한두 개(n자 이내). 목록을 예고하는 문장('다음과 같다', ':')은 건너뛴다."""
    out, count = "", 0
    for sent in _sentences(text):
        if out and (sent.endswith(":") or "다음과 같" in sent or "as follows" in sent.lower()):
            continue
        if not out:
            out = sent
        elif len(out) + 1 + len(sent) <= n:
            out += " " + sent
        else:
            break
        count += 1
        if count == 2:
            break
    return clip(out, n)


def _strs(value, k: int, n: int) -> list[str]:
    """문자열 목록: 빈 값·중복 제거, 개수 k, 길이 n."""
    out = []
    for v in value if isinstance(value, list) else []:
        s = clip(v, n) if isinstance(v, str) else ""
        if s and s not in out:
            out.append(s)
    return out[:k]


# ---------------------------------------------------------------- 정규화

def normalize_outline(outline, result: dict) -> dict:
    """개요를 제한(개수 · 글자 수)에 맞추고 모든 키를 채운다. 어떤 입력이 와도 같은 모양을 돌려준다."""
    o = outline if isinstance(outline, dict) else {}
    syn = result.get("syntheses") or {}
    known = sources_by_id(result)
    L = LIMITS
    topic = result.get("topic") or result.get("prompt") or ""

    findings = []
    for f in o.get("findings") or []:
        if not isinstance(f, dict):
            continue
        qid = clean(f.get("subq_id"))[:12]
        strength = f.get("strength")
        if strength not in STRENGTHS:
            strength = (syn.get(qid) or {}).get("evidence_strength")
            strength = strength if strength in STRENGTHS else "insufficient"
        headline = clip(f.get("headline"), L["headline"])
        bullets = _strs(f.get("bullets"), *L["bullets"])
        if headline or bullets:
            findings.append({"subq_id": qid, "headline": headline, "bullets": bullets, "strength": strength})

    future = []
    for st in o.get("future_studies") or []:
        if isinstance(st, dict) and clean(st.get("title")):
            future.append({k: clip(st.get(k) if isinstance(st.get(k), str) else "", L["future_field"][k])
                           for k in FUTURE_KEYS})

    must, seen = [], set()
    for m in o.get("must_read") or []:
        sid = clean(m.get("sid")).strip("[]") if isinstance(m, dict) else ""
        if sid in known and sid not in seen:
            seen.add(sid)
            must.append({"sid": sid, "why": clip(m.get("why") if isinstance(m.get("why"), str) else "",
                                                 L["must_read"][1])})

    return {
        "title": clip(o.get("title") if isinstance(o.get("title"), str) else "", L["title"]) or clip(topic, L["title"]),
        "subtitle": clip(o.get("subtitle") if isinstance(o.get("subtitle"), str) else "", L["subtitle"]),
        "summary": _strs(o.get("summary"), *L["summary"]),
        "findings": findings[:L["findings"]],
        "agreements": _strs(o.get("agreements"), *L["agreements"]),
        "conflicts": _strs(o.get("conflicts"), *L["conflicts"]),
        "gaps": _strs(o.get("gaps"), *L["gaps"]),
        "future_studies": future[:L["future_studies"]],
        "must_read": must[:L["must_read"][0]],
        "limitations": _strs(o.get("limitations"), *L["limitations"]),
    }


# ---------------------------------------------------------------- LLM 개요

def _subq_lines(result: dict) -> str:
    syn = result.get("syntheses") or {}
    rows = []
    for q in (result.get("plan") or {}).get("sub_questions") or []:
        strength = (syn.get(q.get("id")) or {}).get("evidence_strength") or "insufficient"
        rows.append(f"- {q.get('id')}: {q.get('question', '')} (evidence strength: {strength})")
    return "\n".join(rows) or "- (none)"


def make_outline(llm, result: dict) -> dict | None:
    """완성된 브리프를 발표용 개요로 압축한다(LLM 1회). 호출이 실패하면 None."""
    L = LIMITS
    lang = result.get("lang") or "en"
    prompt = f"""Condense the finished research brief below into an outline for a seminar presentation.

Topic: {result.get('topic') or result.get('prompt') or ''}

Sub-questions (with evidence strength):
{_subq_lines(result)}

Research brief (Markdown):
\"\"\"{result.get('report_markdown') or ''}\"\"\"

Rules:
- Use only what the brief says. Do not add facts, numbers, studies or sources.
- Keep the [S12]-style citation ids on the statements they support. Never invent ids.
- One idea per bullet, written as a short presentable sentence.
- title: the topic as a presentation title (under {L['title']} characters). subtitle: one short line (under {L['subtitle']} characters).
- summary: at most {L['summary'][0]} bullets, each under {L['summary'][1]} characters.
- findings: one item per sub-question in the order above, with its subq_id, a one-line headline (under {L['headline']} characters), at most {L['bullets'][0]} bullets (each under {L['bullets'][1]} characters) and its evidence strength.
- agreements: at most {L['agreements'][0]} points where studies agree; conflicts: at most {L['conflicts'][0]} points where they conflict and why (each under {L['conflicts'][1]} characters).
- gaps: at most {L['gaps'][0]} research gaps (each under {L['gaps'][1]} characters).
- future_studies: at most {L['future_studies']} studies from the brief's future-research section (title, question, design, sample, expected contribution; each field under 150 characters).
- must_read: at most {L['must_read'][0]} sources; every sid must be an id that appears in the brief; why = one sentence on why to read it.
- limitations: at most {L['limitations'][0]} limitations of the brief (each under {L['limitations'][1]} characters).
- Write all text in language "{lang}"."""
    out = llm.json(SYS_BASE + " " + ABSTRACT_RULE, prompt, OUTLINE_SCHEMA, effort="medium", max_tokens=16000)
    if out is None:
        return None
    return normalize_outline(out, result)


# ---------------------------------------------------------------- 규칙 기반 개요

def _sections(md: str) -> list[tuple[str, list[str]]]:
    """'## ' 절 단위로 나눈다 → [(제목, 줄 목록)]."""
    out = []
    for line in (md or "").splitlines():
        if line.startswith("## "):
            out.append((clean(line[3:]), []))
        elif out:
            out[-1][1].append(line)
    return out


def _numbered(md: str) -> list[tuple[str, list[str]]]:
    return [s for s in _sections(md) if re.match(r"\d+[.)]?\s", s[0])]


_ITEM = re.compile(r"^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$")


def _list_items(lines: list[str]) -> list[tuple[str, list[str]]]:
    """맨 위 수준 목록 항목 → [(본문, 하위 항목들)]."""
    items = []
    for line in lines:
        m = _ITEM.match(line)
        if m and not m.group(1):
            items.append((m.group(2), []))
        elif m and items:
            items[-1][1].append(m.group(2))
    return items


def _item_text(top: str, children: list[str]) -> str:
    """짧은 머리 항목(굵은 소제목)이면 첫 하위 항목을 이어 붙인다."""
    top = clean(top)
    if len(top) < 30 and children:
        return f"{top} {clean(children[0])}"
    return top


def _round_robin(lists: list[list[str]]) -> list[str]:
    """여러 하위 질문의 목록에서 번갈아 하나씩 뽑아 중복 없이 모은다."""
    out, i = [], 0
    while any(i < len(x) for x in lists):
        for x in lists:
            if i < len(x):
                s = clean(x[i])
                if s and s not in out:
                    out.append(s)
        i += 1
    return out


_FIELDS = {
    "question": ("연구 질문", "질문", "research question", "question"),
    "design": ("설계", "연구 설계", "design", "study design"),
    "sample": ("표본", "대상", "sample", "participants"),
    "contribution": ("기대 기여", "기여", "expected contribution", "contribution"),
}
_LABEL = re.compile(r"^\*\*(.+?)\*\*\s*[:：]?\s*(.*)$")


def _future_studies(md: str) -> list[dict]:
    sec = next((s for s in _sections(md) if "향후" in s[0] or "future" in s[0].lower()), None)
    if not sec:
        return []
    studies, cur = [], None
    for line in sec[1]:
        if line.startswith("### "):
            title = re.sub(r"^(연구|Study)\s*\d+\s*[:.．]\s*", "", clean(line[4:]), flags=re.I)
            cur = {"title": title, "_items": []}
            studies.append(cur)
        elif cur is not None:
            m = _ITEM.match(line)
            if m and not m.group(1):
                cur["_items"].append([m.group(2), []])
            elif m and cur["_items"]:
                cur["_items"][-1][1].append(clean(m.group(2)))
    out = []
    for st in studies:
        row = {k: "" for k in FUTURE_KEYS}
        row["title"] = st["title"]
        for top, kids in st["_items"]:
            m = _LABEL.match(top.strip())
            if not m:
                continue
            label = clean(m.group(1)).rstrip(":：").strip().lower()
            for key, names in _FIELDS.items():
                if label in names and not row[key]:
                    row[key] = clean(m.group(2)) or " ".join(kids)
        out.append(row)
    return out


def fallback_outline(result: dict) -> dict:
    """LLM 없이 규칙으로 개요를 만든다. 어떤 result가 와도 같은 모양을 돌려준다."""
    L = LIMITS
    md = result.get("report_markdown") or ""
    syn = result.get("syntheses") or {}
    plan_ids = [q.get("id") for q in (result.get("plan") or {}).get("sub_questions") or [] if q.get("id")]
    order = [q for q in plan_ids if q in syn] + [q for q in syn if q not in plan_ids]
    numbered = _numbered(md)

    findings = []
    for qid in order:
        s = syn.get(qid) or {}
        bullets = []
        for kf in s.get("key_findings") or []:
            ids = [x for x in kf.get("sources") or [] if isinstance(x, str)][:3]
            tail = f" [{', '.join(ids)}]" if ids else ""
            body = first_sentences(_CITE_WS.sub("", clean(kf.get("finding"))), L["bullets"][1] - len(tail))
            if body:
                bullets.append(body.rstrip(".") + tail + ("." if body.endswith(".") else ""))
        findings.append({"subq_id": qid, "headline": first_sentences(s.get("answer"), L["headline"]),
                         "bullets": bullets, "strength": s.get("evidence_strength")})

    summary = []
    if numbered:
        summary = [first_sentences(_item_text(t, k), L["summary"][1]) for t, k in _list_items(numbered[0][1])]
    if not summary:
        summary = [f["headline"] for f in findings if f["headline"]]

    limitations = []
    if len(numbered) > 1:
        limitations = [first_sentences(_item_text(t, k), L["limitations"][1]) for t, k in _list_items(numbered[-1][1])]

    sources = result.get("sources") or []
    in_text = set(cited_ids(md))
    cited = [s for s in sources if s.get("sid") and (s.get("cited") or s.get("sid") in in_text)]
    cited.sort(key=lambda s: -(s.get("score") or 0))
    must = [{"sid": s["sid"], "why": s.get("key_finding") or s.get("title") or ""} for s in cited[:5]]

    lang = result.get("lang")
    n_q, n_inc = len(order), sum(1 for s in sources if s.get("included"))
    subtitle = (f"연구 브리프 · 하위 질문 {n_q}개 · 채택 문헌 {n_inc}건" if lang == "ko"
                else f"Research brief · {n_q} sub-questions · {n_inc} included sources")

    vals = [syn[q] for q in order]
    return normalize_outline({
        "title": result.get("topic") or result.get("prompt") or ("연구 브리프" if lang == "ko" else "Research brief"),
        "subtitle": subtitle,
        "summary": summary,
        "findings": findings,
        "agreements": _round_robin([v.get("consensus") or [] for v in vals]),
        "conflicts": _round_robin([v.get("disagreements") or [] for v in vals]),
        "gaps": _round_robin([v.get("gaps") or [] for v in vals]),
        "future_studies": _future_studies(md),
        "must_read": must,
        "limitations": limitations,
    }, result)
