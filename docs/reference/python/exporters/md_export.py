"""Markdown 보고서 (노트북 ⑥ 셀의 build_markdown을 result dict 입력으로 옮긴 것)."""
from __future__ import annotations

from exporters import theme
from exporters.common import (VERDICTS, authors_text, included_sources, labels, meta_info, reference_sources,
                              short_cite, verdict_tally)

VERDICT_MARK = {"supported": "✅", "partially supported": "🟡", "not in source text": "⚪", "contradicted": "❌"}
_UNKNOWN = {"ko": "미존재 ID 제거", "en": "unknown ids removed"}
_NONE = {"ko": "없음", "en": "none"}


def _cell(x, n=160) -> str:
    """표 칸에 넣을 글: | 와 줄바꿈을 없애고 n자로 자른다 (노트북 그대로)."""
    return str(x or "").replace("|", "/").replace("\n", " ")[:n]


def _clip(x, n) -> str:
    s = _cell(x, n + 1)
    return s[:n] + "…" if len(s) > n else s


def direction_text(result: dict, d: str) -> str:
    """방향 값 표시: 한국어 보고서는 theme 라벨, 영어는 원래 값."""
    if result.get("lang") == "ko":
        return theme.DIRECTION_LABEL.get(d or "", d or "")
    return d or "-"


def build_markdown(result: dict) -> str:
    L, m = labels(result), meta_info(result)
    lang = "ko" if result.get("lang") == "ko" else "en"
    inc = included_sources(result)
    meta_line = (f"{L['gen']}: {m['date'] or '-'} · {L['model']}: {m['model'] or '-'} · {L['window']}: {m['window']} · "
                 f"{L['stats']}: {m['collected']}/{m['included']} ({L['merged']} {m['merged']}, "
                 f"{L['sent']} {m['report_evidence']}) · {m['minutes']:.1f} {L['minutes']} · "
                 f"{L['calls']} {m['calls']} (in {m['input_tokens']:,} / out {m['output_tokens']:,} {L['tokens']})")
    if m["cost_usd"] is not None:
        meta_line += f" · {L['cost']} ${m['cost_usd']:.2f}"
    md = [f"# {L['title']}", f"**{L['topic']}**: {result.get('topic') or result.get('prompt') or ''}  ", meta_line]
    if m["note"]:
        md += ["", f"> {_cell(m['note'], 400)}"]
    md += ["", "---", "", (result.get("report_markdown") or "").strip(), "", "---", "",
           f"## {L['tableA']}", "", "| " + " | ".join(L["cols"]) + " |", "|" + "---|" * len(L["cols"])]

    # 부록 A: 채택 문헌, 종합 점수 높은 순
    for s in inc:
        score = f"{s['score']:.2f}" if isinstance(s.get("score"), (int, float)) else "-"
        md.append(f"| {s.get('sid', '')} | {_cell(short_cite(s))}<br>{_cell(s.get('study_type'))} "
                  f"| {_cell(s.get('method'), 80)}<br>{_cell(s.get('sample'), 60)} "
                  f"| {_cell(s.get('key_finding'), 220)} | {_cell(direction_text(result, s.get('direction')))}<br>{score} |")

    # 부록 B: 참고문헌, S 번호순
    md += ["", f"## {L['refB']}", ""]
    for s in reference_sources(result):
        cites = s.get("citations") if s.get("citations") is not None else "-"
        md.append(f"- **[{s['sid']}]** {authors_text(s) or s.get('venue') or ''} ({s.get('year') or 'n.d.'}). "
                  f"*{_cell(s.get('title'), 400)}*. {s.get('venue') or ''}. {s.get('url') or s.get('doi') or ''} — "
                  f"{s.get('kind') or ''}, cites={cites}, via {s.get('origin') or ''}")

    # 부록 C: 인용 검증
    v = result.get("verification") or {}
    checks = v.get("checks") or []
    md += ["", f"## {L['verC']}", "",
           f"- {L['cited']}: {v.get('cited_ids', '-')} · {_UNKNOWN[lang]}: {', '.join(v.get('unknown_ids') or []) or _NONE[lang]}"
           f" · {L['claims']}: {v.get('claims_total', '-')} · {L['checked']}: {len(checks)}"]
    if checks:
        def tally(after):
            t = verdict_tally(checks, after)
            return " · ".join(f"{VERDICT_MARK[k]} {k} {t[k]}" for k in VERDICTS)
        md += [f"- {L['before']}: {tally(False)}", f"- {L['after']}: {tally(True)}", ""]
    for c in checks:
        md.append(f"- {VERDICT_MARK.get(c.get('verdict'), '❌')} {c.get('verdict') or '-'} — "
                  f"“{_clip(c.get('claim'), 150)}” — {_cell(c.get('note'), 400)}")
        if c.get("revised"):
            md.append(f"  - → {L['after']}: {VERDICT_MARK.get(c.get('verdict_after'), '❔')} {c.get('verdict_after') or '-'} — "
                      f"“{_clip(c.get('revised'), 150)}” — {_cell(c.get('note_after'), 400)}")

    # 부록 D: 에이전트 수행 기록
    md += ["", f"## {L['traceD']}", ""]
    for t in result.get("trace") or []:
        md.append(f"- `{(t.get('ts') or '')[11:] or '-'}` **{(t.get('stage') or '').capitalize()}** — {_cell(t.get('msg'), 250)}")
    return "\n".join(md) + "\n"
