"""HTML 보고서: 웹 화면용 본문 조각(render_fragment)과 인쇄·PDF용 단독 문서(build_html).

보안: report_markdown은 LLM이, 문헌 필드는 공개 웹이 만든 글이다. markdown-it의 html 옵션을 끄고(태그는 전부 글자로
이스케이프됨), 부록에 직접 넣는 글은 전부 html.escape, 주소는 common.safe_url(http/https만)을 거친다.
결과에 <script>나 on... 이벤트 속성, javascript: 주소가 들어갈 수 없다(auto_print가 넣는 스크립트 1줄만 예외)."""
from __future__ import annotations

import re
from html import escape

from markdown_it import MarkdownIt
from markdown_it.token import Token

from exporters import theme
from exporters.common import (CITE_RE, VERDICTS, authors_text, included_sources, labels, meta_info, reference_sources,
                              safe_url, short_cite, sources_by_id, verdict_tally)

_BR_RE = re.compile(r"&lt;br\s*/?&gt;", re.I)                    # 이스케이프된 <br>, <br/>, <br />
_CITE_LINK_RE = re.compile(r"(\[S\d+(?:\s*,\s*S\d+)*\])\(")     # [S12](설명) 이 링크로 해석되지 않게
_EXTRA = {
    "ko": dict(duration="소요 시간", request="요청", unknown="미존재 ID", none="없음", link="원문", cites="인용",
               via="출처", relevance="관련성", credibility="신뢰도", limitation="한계", empty="채택된 문헌이 없습니다.",
               no_checks="검증한 문장이 없습니다.", no_trace="기록이 없습니다.", tally="판정 집계"),
    "en": dict(duration="Duration", request="Request", unknown="unknown ids", none="none", link="link", cites="cites",
               via="via", relevance="relevance", credibility="credibility", limitation="Limitation",
               empty="No included sources.", no_checks="No claims were checked.", no_trace="No trace entries.",
               tally="Verdict tally"),
}
_STAGE_KO = {"understand": "주제 이해", "plan": "계획", "act": "탐색", "evaluate": "평가", "synthesize": "종합",
             "reflect": "비평", "report": "보고서", "verify": "검증", "export": "내보내기", "system": "시스템"}
_WEBFONT = ("https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/"
            "pretendardvariable-dynamic-subset.min.css")


# ---------------------------------------------------------------- Markdown 렌더러

def _core_rule(state) -> None:
    """h2·h3에 sec-N id를 달고 목차를 모으며(env["toc"]가 있을 때), 텍스트 속 인용을 링크로 바꾼다."""
    env, n = state.env, 0
    toc, known = env.get("toc"), env.get("known") or ()
    for i, tok in enumerate(state.tokens):
        if tok.type == "heading_open" and tok.tag in ("h2", "h3") and toc is not None:
            n += 1
            tok.attrSet("id", f"sec-{n}")
            inline = state.tokens[i + 1]
            title = "".join(c.content for c in inline.children or [] if c.type in ("text", "code_inline"))
            toc.append({"id": f"sec-{n}", "level": int(tok.tag[1]), "title": title.strip()})
        if tok.type != "inline" or not tok.children:
            continue
        out, in_link = [], 0
        for child in tok.children:
            in_link += child.type == "link_open"
            in_link -= child.type == "link_close"
            if child.type != "text" or in_link or not CITE_RE.search(child.content):
                out.append(child)
                continue
            pos = 0
            for m in CITE_RE.finditer(child.content):
                if m.start() > pos:
                    out.append(_text_token(child.content[pos:m.start()]))
                html_tok = Token("html_inline", "", 0)
                html_tok.content = link_cites(m.group(0), known)
                out.append(html_tok)
                pos = m.end()
            if pos < len(child.content):
                out.append(_text_token(child.content[pos:]))
        tok.children = out


def _text_token(content: str) -> Token:
    t = Token("text", "", 0)
    t.content = content
    return t


def link_cites(text: str, known) -> str:
    """이미 이스케이프된(또는 안전한) 글의 [S12] 인용에서 known에 있는 ID만 링크로 감싼다. 대괄호·쉼표는 그대로.
    목록에 없는 ID는 화면에서 따로 표시할 수 있게 span.cite-unknown으로 감싼다."""
    def one(m):
        sid = m.group(0)
        if sid in known:
            return f'<a class="cite" data-sid="{sid}" href="#ref-{sid}">{sid}</a>'
        return f'<span class="cite-unknown">{sid}</span>'
    # 줄 끝에서 대괄호와 ID가 갈라지지 않게 한 덩어리(span.cites)로 묶는다
    return CITE_RE.sub(lambda m: '<span class="cites">' + re.sub(r"S\d+", one, m.group(0)) + "</span>", text)


def _link_open(self, tokens, idx, options, env):
    tok = tokens[idx]
    href = str(tok.attrGet("href") or "")
    if href.lower().startswith(("http://", "https://")):
        tok.attrSet("target", "_blank")
        tok.attrSet("rel", "noopener noreferrer")
    elif not href.startswith("#"):
        # mailto:·ftp:·상대 경로·프로토콜 상대(//host) 등은 살아 있는 링크로 두지 않는다(글자는 남김)
        tok.attrs.pop("href", None)
    return self.renderToken(tokens, idx, options, env)


def _make_md() -> MarkdownIt:
    md = MarkdownIt("commonmark", {"html": False}).enable("table")
    md.core.ruler.push("cite_links", _core_rule)
    md.add_render_rule("link_open", _link_open)
    md.add_render_rule("table_open", lambda self, t, i, o, e: '<div class="tbl"><table>\n')
    md.add_render_rule("table_close", lambda self, t, i, o, e: "</table></div>\n")
    return md


_MD = _make_md()   # 규칙만 담은 객체라 여러 스레드가 함께 써도 된다(실행별 값은 env로 넘김)


def _render(text: str, known=(), toc: list | None = None) -> str:
    env = {"known": set(known), "toc": toc}
    html = _MD.render(_CITE_LINK_RE.sub(r"\1\\(", text or ""), env)
    return _BR_RE.sub("<br>", html)


def render_markdown(text: str, known_ids=()) -> str:
    """안전한 Markdown → HTML (Q&A 답변 등). known_ids에 있는 인용만 링크가 된다. 제목 id는 달지 않는다."""
    return _render(text, known_ids)


def render_fragment(result: dict) -> dict:
    """웹 화면 보고서 탭용 본문 HTML과 목차."""
    toc: list = []
    html = _render(result.get("report_markdown") or "", sources_by_id(result).keys(), toc)
    return {"html": html, "toc": toc}


# ---------------------------------------------------------------- 단독 문서

def _x(result: dict) -> dict:
    return _EXTRA["ko" if result.get("lang") == "ko" else "en"]


def _label(table: dict, key, result: dict) -> str:
    """한국어 보고서만 theme의 한국어 라벨을 쓰고, 영어 보고서는 원래 값."""
    key = key or ""
    return table.get(key, key) if result.get("lang") == "ko" else key


def _badge(verdict: str, result: dict, prefix: str = "", suffix: str = "") -> str:
    color = theme.VERDICT_COLOR.get(verdict, theme.NEUTRAL)
    text = _label(theme.VERDICT_LABEL, verdict, result) or "-"
    return f'<span class="badge" style="--c:#{color}">{escape(prefix + text + suffix)}</span>'


def _cover(result: dict) -> str:
    L, X, m = labels(result), _x(result), meta_info(result)
    topic = result.get("topic") or result.get("prompt") or L["title"]
    items = [(L["gen"], m["date"]), (L["model"], m["model"]), (L["window"], m["window"]),
             (L["stats"], f"{m['collected']} / {m['included']} ({L['merged']} {m['merged']})")]
    if m["minutes"]:
        items.append((X["duration"], f"{m['minutes']:.1f} {L['minutes']}"))
    if m["calls"]:
        items.append((L["calls"], f"{m['calls']}회 · {L['tokens']} {m['input_tokens'] + m['output_tokens']:,}"
                      if result.get("lang") == "ko" else f"{m['calls']} · {m['input_tokens'] + m['output_tokens']:,} {L['tokens']}"))
    if m["cost_usd"] is not None:
        items.append((L["cost"], f"${m['cost_usd']:.2f}"))
    meta = "".join(f"<div><dt>{escape(k)}</dt><dd>{escape(str(v))}</dd></div>" for k, v in items if v not in ("", None))
    prompt = (result.get("prompt") or "").strip()
    out = [f'<header class="cover"><div class="kicker">{escape(L["title"])}</div><h1 class="title">{escape(topic)}</h1>']
    if prompt and prompt != topic:
        out.append(f'<p class="prompt"><span>{escape(X["request"])}</span> {escape(prompt)}</p>')
    out.append(f'<dl class="meta">{meta}</dl>')
    if m["note"]:
        out.append(f'<p class="note">{escape(m["note"])}</p>')
    out.append("</header>")
    return "".join(out)


def _toc(result: dict, toc: list) -> str:
    L = labels(result)
    entries = toc + [{"id": f"appx-{c}", "level": 2, "title": L[k]}
                     for c, k in (("a", "tableA"), ("b", "refB"), ("c", "verC"), ("d", "traceD"))]
    lis = "".join(f'<li class="l{t["level"]}"><a href="#{t["id"]}">{escape(t["title"])}</a></li>' for t in entries)
    return f'<nav class="toc"><h2>{escape(L["contents"])}</h2><ol>{lis}</ol></nav>'


def _appendix_a(result: dict) -> str:
    L, X = labels(result), _x(result)
    rows = []
    for s in included_sources(result):
        score = f"{s['score']:.2f}" if isinstance(s.get("score"), (int, float)) else "-"
        cred = f"{s['credibility']:.2f}" if isinstance(s.get("credibility"), (int, float)) else "-"
        lim = f'<span class="sub">{escape(X["limitation"])}: {escape(s["limitation"])}</span>' if s.get("limitation") else ""
        rows.append(
            f'<tr><td class="sid">{escape(s.get("sid", ""))}</td>'
            f'<td><b>{escape(short_cite(s))}</b><span class="sub">{escape(s.get("title") or "")}</span>'
            f'<span class="tag">{escape(_label(theme.KIND_LABEL, s.get("kind"), result))}</span> '
            f'<span class="sub inline">{escape(s.get("study_type") or "")}</span></td>'
            f'<td>{escape(s.get("method") or "")}<span class="sub">{escape(s.get("sample") or "")}</span></td>'
            f'<td>{escape(s.get("key_finding") or "")}{lim}</td>'
            f'<td><span class="dir">{escape(_label(theme.DIRECTION_LABEL, s.get("direction"), result) or "-")}</span>'
            f'<span class="score">{score}</span><span class="sub">{escape(X["relevance"])} {escape(str(s.get("relevance") or "-"))}'
            f' · {escape(X["credibility"])} {cred}</span></td></tr>')
    body = "".join(rows) or f'<tr><td colspan="5" class="empty">{escape(X["empty"])}</td></tr>'
    head = "".join(f"<th>{escape(c)}</th>" for c in L["cols"])
    return (f'<section class="appendix wide" id="appx-a"><h2>{escape(L["tableA"])}</h2>'
            f'<table class="evidence"><colgroup><col class="c1"><col class="c2"><col class="c3"><col class="c4"><col class="c5">'
            f'</colgroup><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></section>')


def _appendix_b(result: dict) -> str:
    L, X = labels(result), _x(result)
    items = []
    for s in reference_sources(result):
        sid = escape(s["sid"])
        url = safe_url(s)
        link = (f' <a class="out" href="{escape(url)}" target="_blank" rel="noopener noreferrer">{escape(url)}</a>'
                if url else "")
        cites = f"{X['cites']} {s['citations']}" if s.get("citations") is not None else ""
        info = " · ".join(x for x in (cites, f"{X['via']} {s['origin']}" if s.get("origin") else "") if x)
        info_html = f' <span class="sub2">{escape(info)}</span>' if info else ""
        items.append(
            f'<li id="ref-{sid}"><span class="rid">[{sid}]</span><div>'
            f'{escape(authors_text(s) or s.get("venue") or "")} ({escape(str(s.get("year") or "n.d."))}). '
            f'<cite>{escape(s.get("title") or "")}</cite>. '
            f'{"<i>" + escape(s["venue"]) + "</i>. " if s.get("venue") else ""}'
            f'<span class="tag">{escape(_label(theme.KIND_LABEL, s.get("kind"), result))}</span>'
            f'{info_html}{link}</div></li>')
    body = "".join(items) or f'<li class="empty">{escape(X["empty"])}</li>'
    return f'<section class="appendix" id="appx-b"><h2>{escape(L["refB"])}</h2><ol class="refs">{body}</ol></section>'


def _appendix_c(result: dict, known) -> str:
    L, X = labels(result), _x(result)
    v = result.get("verification") or {}
    checks = v.get("checks") or []
    stats = [(L["cited"], v.get("cited_ids", "-")), (X["unknown"], ", ".join(v.get("unknown_ids") or []) or X["none"]),
             (L["claims"], v.get("claims_total", "-")), (L["checked"], len(checks))]
    out = [f'<section class="appendix" id="appx-c"><h2>{escape(L["verC"])}</h2><dl class="kv">',
           "".join(f"<div><dt>{escape(k)}</dt><dd>{escape(str(val))}</dd></div>" for k, val in stats), "</dl>"]
    if checks:
        out.append('<div class="tallies">')
        for name, after in ((L["before"], False), (L["after"], True)):
            t = verdict_tally(checks, after)
            out.append(f'<div class="tally"><span class="tl">{escape(name)}</span>'
                       + "".join(_badge(k, result, suffix=f" {t[k]}") for k in VERDICTS) + "</div>")
        out.append("</div>")
    else:
        out.append(f'<p class="empty">{escape(X["no_checks"])}</p>')
    for c in checks:
        verdict = c.get("verdict") or ""
        color = theme.VERDICT_COLOR.get(verdict, theme.NEUTRAL)
        card = [f'<div class="claim" style="--c:#{color}">{_badge(verdict, result)}',
                f'<p class="ct">“{link_cites(escape(c.get("claim") or ""), known)}”</p>']
        if c.get("note"):
            card.append(f'<p class="cn">{escape(c["note"])}</p>')
        if c.get("revised"):
            card.append(f'<div class="revised">{_badge(c.get("verdict_after") or "not checked", result, L["after"] + ": ")}'
                        f'<p class="ct">“{link_cites(escape(c["revised"]), known)}”</p>'
                        + (f'<p class="cn">{escape(c["note_after"])}</p>' if c.get("note_after") else "") + "</div>")
        out.append("".join(card) + "</div>")
    out.append("</section>")
    return "".join(out)


def _appendix_d(result: dict) -> str:
    L, X = labels(result), _x(result)
    ko = result.get("lang") == "ko"
    items = []
    for t in result.get("trace") or []:
        stage = t.get("stage") or ""
        name = _STAGE_KO.get(stage, stage) if ko else stage.capitalize()
        items.append(f'<li><time>{escape((t.get("ts") or "")[11:19])}</time><span class="stage">{escape(name)}</span>'
                     f'<span class="msg">{escape(t.get("msg") or "")}</span></li>')
    body = f'<ol class="timeline">{"".join(items)}</ol>' if items else f'<p class="empty">{escape(X["no_trace"])}</p>'
    return f'<section class="appendix" id="appx-d"><h2>{escape(L["traceD"])}</h2>{body}</section>'


def _css() -> str:
    t = theme
    return f"""
:root{{--accent:#{t.ACCENT};--accent-dark:#{t.ACCENT_DARK};--accent-soft:#{t.ACCENT_SOFT};--ink:#{t.INK};--ink2:#{t.INK_2};
--muted:#{t.MUTED};--rule:#{t.RULE};--surface:#{t.SURFACE};--alt:#{t.SURFACE_ALT}}}
*{{box-sizing:border-box}}
html{{-webkit-text-size-adjust:100%}}
body{{margin:0;background:var(--alt);color:var(--ink);font-family:{t.FONT_STACK_CSS};font-size:15px;line-height:1.7;
word-break:keep-all;overflow-wrap:break-word;-webkit-print-color-adjust:exact;print-color-adjust:exact}}
.doc{{max-width:860px;margin:32px auto;padding:56px 64px;background:var(--surface);border-radius:8px;
box-shadow:0 1px 3px rgba(21,23,28,.06),0 8px 24px rgba(21,23,28,.05)}}
a{{color:var(--accent);text-underline-offset:2px}}
.cover{{padding-bottom:22px;margin-bottom:28px;border-bottom:2px solid var(--accent)}}
.kicker{{color:var(--accent);font-weight:700;font-size:.8em;letter-spacing:.08em}}
.cover h1.title{{font-size:1.9em;line-height:1.35;margin:.3em 0 .5em;letter-spacing:-.015em;font-weight:800}}
.prompt{{color:var(--ink2);font-size:.92em;margin:0 0 12px}}
.prompt span{{color:var(--muted);font-weight:600;margin-right:4px}}
dl.meta,dl.kv{{display:flex;flex-wrap:wrap;gap:6px 22px;margin:0;font-size:.85em}}
dl.meta div,dl.kv div{{display:flex;gap:6px}}
dl.meta dt,dl.kv dt{{color:var(--muted)}}
dl.meta dd,dl.kv dd{{margin:0;font-weight:600}}
.note{{margin:16px 0 0;padding:10px 14px;background:var(--accent-soft);border-left:3px solid var(--accent);
font-size:.87em;color:var(--ink2);border-radius:0 4px 4px 0}}
.toc{{margin:0 0 36px}}
.toc h2{{font-size:1.05em;border:0;margin:0 0 8px;padding:0;color:var(--muted);letter-spacing:.04em}}
.toc ol{{list-style:none;margin:0;padding:0;columns:2;column-gap:36px;font-size:.9em}}
.toc li{{break-inside:avoid;margin:0 0 3px}}
.toc li.l3{{padding-left:14px;font-size:.92em;color:var(--ink2)}}
.toc a{{color:inherit;text-decoration:none}}
.toc a:hover{{color:var(--accent)}}
h1,h2,h3,h4{{line-height:1.4;letter-spacing:-.01em}}
.report h1{{font-size:1.45em;margin:0 0 .8em}}
h2{{font-size:1.4em;margin:2.2em 0 .7em;padding-bottom:.3em;border-bottom:1px solid var(--rule)}}
h3{{font-size:1.13em;margin:1.8em 0 .6em;color:var(--accent-dark)}}
h4{{font-size:1em;margin:1.4em 0 .5em}}
p{{margin:0 0 .8em}}
ul,ol{{margin:0 0 .9em;padding-left:1.4em}}
li{{margin:.2em 0}}
li>ul,li>ol{{margin:.25em 0}}
blockquote{{margin:0 0 1em;padding:.2em 1em;border-left:3px solid var(--rule);color:var(--ink2)}}
hr{{border:0;border-top:1px solid var(--rule);margin:2em 0}}
code{{font-family:{t.FONT_MONO},ui-monospace,monospace;font-size:.88em;background:var(--alt);padding:.1em .35em;border-radius:3px}}
pre{{background:var(--alt);padding:12px 14px;border-radius:6px;overflow-x:auto}}
pre code{{padding:0;background:none}}
.cites{{white-space:nowrap;color:var(--muted)}}
a.cite{{display:inline-block;padding:0 .35em;margin:0 .1em;border-radius:4px;background:var(--accent-soft);
color:var(--accent-dark);font-size:.76em;font-weight:600;line-height:1.55;text-decoration:none;vertical-align:.1em}}
a.cite:hover{{background:var(--accent);color:#fff}}
.tbl{{overflow-x:auto;margin:1em 0 1.3em}}
table{{border-collapse:collapse;width:100%;font-size:.86em;line-height:1.55}}
th,td{{border:1px solid var(--rule);padding:.45em .6em;vertical-align:top;text-align:left}}
thead th{{background:var(--alt);font-weight:700;white-space:nowrap}}
.appendix{{margin-top:3.5em}}
.appendix h2{{margin-top:0;border-bottom:2px solid var(--accent)}}
table.evidence{{font-size:.78em;table-layout:fixed}}
.evidence col.c1{{width:6%}} .evidence col.c2{{width:24%}} .evidence col.c3{{width:22%}}
.evidence col.c4{{width:36%}} .evidence col.c5{{width:12%}}
.evidence td.sid{{font-weight:700;color:var(--accent-dark);white-space:nowrap}}
.sub{{display:block;color:var(--muted);font-size:.92em;margin-top:2px}}
.sub.inline{{display:inline}}
.sub2{{color:var(--muted);font-size:.9em}}
.tag{{display:inline-block;padding:0 .45em;margin-top:3px;border:1px solid var(--rule);border-radius:3px;
font-size:.85em;color:var(--ink2);background:var(--surface)}}
.dir{{display:block;font-weight:600}}
.score{{display:block;font-variant-numeric:tabular-nums}}
.empty{{color:var(--muted)}}
ol.refs{{list-style:none;padding:0;margin:0;font-size:.88em}}
.refs li{{display:grid;grid-template-columns:3.8em 1fr;gap:.6em;padding:.45em .4em;margin:0;border-bottom:1px solid var(--alt)}}
.refs li:target{{background:var(--accent-soft)}}
.refs .rid{{font-weight:700;color:var(--accent-dark)}}
.refs cite{{font-style:normal;font-weight:600}}
.refs a.out{{display:block;font-size:.9em;word-break:break-all}}
.tallies{{margin:14px 0 18px;display:grid;gap:6px}}
.tally{{display:flex;flex-wrap:wrap;align-items:center;gap:6px}}
.tally .tl{{min-width:5em;font-size:.85em;color:var(--muted);font-weight:600}}
.badge{{display:inline-flex;align-items:center;gap:5px;padding:0 .6em;border:1px solid var(--rule);border-radius:999px;
font-size:.76em;font-weight:700;line-height:1.8;color:var(--ink);background:var(--surface);white-space:nowrap}}
.badge::before{{content:"";width:.6em;height:.6em;border-radius:50%;background:var(--c)}}
.claim{{border:1px solid var(--rule);border-left:4px solid var(--c);border-radius:6px;padding:10px 14px;margin:10px 0;font-size:.92em}}
.claim .ct{{margin:.4em 0 .2em}}
.claim .cn{{margin:0;color:var(--ink2);font-size:.92em}}
.revised{{margin-top:8px;padding:8px 12px;background:var(--alt);border-radius:4px}}
ol.timeline{{list-style:none;margin:0 0 0 6px;padding:0;border-left:2px solid var(--rule);font-size:.84em}}
.timeline li{{position:relative;margin:0;padding:.25em 0 .45em 1.2em;line-height:1.55}}
.timeline li::before{{content:"";position:absolute;left:-6px;top:.6em;width:10px;height:10px;border-radius:50%;
background:var(--surface);border:2px solid var(--accent)}}
.timeline time{{font-family:{t.FONT_MONO},monospace;color:var(--muted);margin-right:.6em}}
.timeline .stage{{font-weight:700;color:var(--accent-dark);margin-right:.5em}}
@media (max-width:720px){{.doc{{margin:0;padding:28px 18px;border-radius:0}} .toc ol{{columns:1}}}}
@page{{size:A4;margin:18mm 16mm}}
@page wide{{size:A4 landscape;margin:12mm 12mm}}
@media print{{
body{{background:#fff;font-size:10.5pt;line-height:1.65}}
.doc{{max-width:none;margin:0;padding:0;box-shadow:none;border-radius:0}}
.toc{{break-after:page}}
.tbl{{overflow:visible}}
thead{{display:table-header-group}}
tr,.claim,.refs li,.timeline li,.tally{{break-inside:avoid}}
h1,h2,h3,h4{{break-after:avoid}}
.appendix{{break-before:page;margin-top:0}}
.wide{{page:wide}}
a{{text-decoration:none}}
a.cite:hover{{background:var(--accent-soft);color:var(--accent-dark)}}
}}
"""


def build_html(result: dict, auto_print: bool = False, *, webfont: bool = True) -> str:
    """단독으로 열리는 완성 HTML 문서. webfont=False면 Pretendard 웹폰트 링크를 넣지 않는다(PDF 변환용)."""
    L = labels(result)
    known = {s["sid"] for s in reference_sources(result)}     # 부록 B에 있는 문헌만 링크 (끊긴 링크 방지)
    body = re.sub(r"\A\s*#\s[^\n]*\n", "", result.get("report_markdown") or "")   # 본문 첫 제목은 표지와 겹쳐 뺀다
    toc: list = []
    report = _render(body, known, toc)
    topic = result.get("topic") or result.get("prompt") or L["title"]
    font = f'<link rel="stylesheet" href="{_WEBFONT}">' if webfont else ""
    script = ('<script>window.addEventListener("load",function(){setTimeout(function(){window.print()},400)})</script>'
              if auto_print else "")
    lang = "ko" if result.get("lang") == "ko" else "en"
    return (f'<!doctype html><html lang="{lang}"><head><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>{escape(topic)} · {escape(L["title"])}</title>{font}<style>{_css()}</style></head><body>'
            f'<main class="doc">{_cover(result)}{_toc(result, toc)}<article class="report">{report}</article>'
            f'{_appendix_a(result)}{_appendix_b(result)}{_appendix_c(result, known)}{_appendix_d(result)}</main>'
            f'{script}</body></html>')
