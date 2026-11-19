"""발표 슬라이드(.pptx) 내보내기.

16:9 빈 레이아웃 위에 격자(여백 · 제목 영역 · 본문 영역 · 꼬리말)를 한 번 정해 두고 모든 도형을 직접 배치한다.
PowerPoint는 글자를 알아서 줄여 주지 않으므로, 글자 수 · 글자 크기 · 상자 너비로 필요한 줄 수를 어림해
글자 크기 단계를 고르고, 넘치면 '(계속)' 슬라이드로 넘긴다."""
from __future__ import annotations

import math
import re
from pathlib import Path

from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LABEL_POSITION, XL_LEGEND_POSITION
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, MSO_AUTO_SIZE, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Inches, Pt

from agent.slides import clip, fallback_outline, normalize_outline
from exporters import theme
from exporters.common import (CITE_RE, VERDICTS, authors_text, cited_ids, meta_info, short_cite,
                              sources_by_id, verdict_tally)

# ---------------------------------------------------------------- 격자 (단위: 인치)
W, H = 13.333, 7.5
ML = 0.6                       # 좌우 여백
CW = W - 2 * ML                # 본문 너비
KICK_Y, KICK_H = 0.36, 0.34    # 머리말 위 작은 글(구역 이름)
TITLE_Y, TITLE_H = 0.70, 0.88  # 슬라이드 제목
RULE_Y = 1.64                  # 제목 아래 강조선
TOP, BOTTOM = 1.9, 6.75        # 본문 영역
CH = BOTTOM - TOP
FOOT_Y, FOOT_H = 6.98, 0.3     # 꼬리말
MX, MY = 0.05, 0.03            # 글상자 안쪽 여백
CELL_MX, CELL_MY = 0.08, 0.05  # 표 칸 안쪽 여백
INDENT = 0.24                  # 글머리 기호 들여쓰기

# 글자 크기 단계 (pt)
TITLE_TIERS = (28, 24, 20)
BODY_TIERS = (20, 18, 16, 14)
SMALL_TIERS = (16, 14, 13, 12)
PER_SLIDE = 5                  # 슬라이드당 글머리 항목 최대 수

# 줄 수 어림값: 한글 등 전각 1em, 영문 0.58em, 줄바꿈 손실 10%, 줄 간격 1.3배(맑은 고딕)
WRAP, LINE = 1.1, 1.3

TXT = {
    "ko": dict(
        product="AI Research Agent", cont="(계속)", none="자료 없음",
        summary_k="핵심 요약", summary_t="한눈에 보는 결론",
        design_k="연구 설계", design_t="에이전트 8단계와 수집 규모", pipeline="에이전트 파이프라인", scale="수집 규모",
        tiles=["수집 문헌", "채택 문헌", "중복 판본 병합", "LLM 호출", "소요 시간(분)"],
        n_subq="하위 질문", unit_q="개", window="검색 기간", model="모델", disabled="제외된 도구",
        stages=[("주제 이해", "개념·변수·기간"), ("계획 수립", "하위 질문 설계"), ("문헌 탐색", "5개 검색 도구"),
                ("근거 평가", "관련성·신뢰도"), ("종합", "하위 질문별"), ("성찰", "재조사 판단"),
                ("보고서", "브리프 작성"), ("인용 검증", "초록 대조")],
        subq_k="하위 질문", subq_t="연구 질문을 나눈 방식", cols_q=["ID", "관점", "하위 질문"],
        ev_k="근거 프로필", ev_t="채택 문헌의 구성", study="연구 유형", year="출판 연도", direction="결과 방향",
        other="기타", included="채택 문헌",
        strength="근거 강도", related="관련 근거", unit_src="건", subq="하위 질문",
        agree_k="일치와 상충", agree_t="연구들이 일치하는 점과 엇갈리는 점", agree="일치하는 점", conflict="상충하는 점",
        gaps_k="연구 공백", gaps_t="아직 답하지 못한 질문",
        future_k="향후 연구", future_t="제안하는 후속 연구",
        fields=[("question", "연구 질문"), ("design", "설계"), ("sample", "표본"), ("contribution", "기대 기여")],
        must_k="필독 문헌", must_t="먼저 읽을 문헌", cols_m=["순위", "문헌", "읽을 이유"],
        lim_k="한계와 인용 검증", lim_t="이 브리프의 한계", check="인용 검증", before="수정 전", after="수정 후",
        verdict="판정", fig=["인용 ID", "없는 ID", "검증 문장"], no_lim="기재된 한계가 없습니다.",
        refs_k="참고문헌", refs_t="슬라이드에 인용한 문헌",
        collected="수집", inc="채택", unit="건"),
    "en": dict(
        product="AI Research Agent", cont="(cont.)", none="No data",
        summary_k="Executive summary", summary_t="Key conclusions at a glance",
        design_k="Research design", design_t="Eight-stage agent pipeline and scale", pipeline="Agent pipeline",
        scale="Scale", tiles=["Collected", "Included", "Duplicates merged", "LLM calls", "Minutes"],
        n_subq="Sub-questions", unit_q="", window="Search window", model="Model", disabled="Disabled tools",
        stages=[("Understand", "concepts, scope"), ("Plan", "sub-questions"), ("Search", "5 search tools"),
                ("Evaluate", "relevance"), ("Synthesize", "per question"), ("Reflect", "re-search?"),
                ("Report", "write brief"), ("Verify", "check citations")],
        subq_k="Sub-questions", subq_t="How the question was broken down", cols_q=["ID", "Perspective", "Sub-question"],
        ev_k="Evidence profile", ev_t="What the included sources look like", study="Study type",
        year="Publication year", direction="Result direction", other="Other", included="Included",
        strength="Evidence strength", related="Related sources", unit_src="", subq="Sub-question",
        agree_k="Agreement and conflict", agree_t="Where studies agree and where they differ", agree="Agreement",
        conflict="Conflict",
        gaps_k="Research gaps", gaps_t="Questions not yet answered",
        future_k="Future research", future_t="Proposed follow-up studies",
        fields=[("question", "Question"), ("design", "Design"), ("sample", "Sample"),
                ("contribution", "Expected contribution")],
        must_k="Must-read sources", must_t="Read these first", cols_m=["Rank", "Source", "Why read it"],
        lim_k="Limitations and citation check", lim_t="Limitations of this brief", check="Citation check",
        before="Before", after="After", verdict="Verdict", fig=["Cited ids", "Unknown ids", "Claims checked"],
        no_lim="No limitations were listed.",
        refs_k="References", refs_t="Sources cited in these slides",
        collected="collected", inc="included", unit=""),
}
STRENGTH_EN = {"strong": "Strong", "moderate": "Moderate", "weak": "Weak", "insufficient": "Insufficient"}
VERDICT_EN = {"supported": "Supported", "partially supported": "Partly supported",
              "not in source text": "Not in abstract", "contradicted": "Contradicted"}
DIRECTIONS = list(theme.DIRECTION_LABEL)        # 고정 순서 → 계열색 고정
STRENGTH_COLOR = {"strong": theme.ACCENT_DARK, "moderate": theme.ACCENT, "weak": theme.INK_2,
                  "insufficient": theme.MUTED}


# ---------------------------------------------------------------- 글자 맞춤 어림

def _em(ch: str) -> float:
    return 1.0 if ord(ch) >= 0x1100 else 0.58


def text_lines(text: str, size: float, width: float) -> int:
    """너비 width(인치) 상자에 size pt로 쓸 때 필요한 줄 수(어림)."""
    per = max(width * 72 / size, 1.0)
    return sum(max(1, math.ceil(sum(map(_em, part)) * WRAP / per)) for part in str(text).split("\n"))


def text_height(paras: list[tuple[str, float]], width: float, gap: float = 0.0, indent: float = 0.0) -> float:
    """문단 [(글, 크기)]에 필요한 높이(인치, 안쪽 여백 포함). gap = 문단 사이 간격(pt)."""
    w = width - 2 * MX - indent
    h = sum(text_lines(t, s, w) * s * LINE / 72 for t, s in paras)
    return h + gap * max(len(paras) - 1, 0) / 72 + 2 * MY


def _bullets_height(items: list[str], size: float, width: float) -> float:
    return text_height([(t, size) for t in items], width, gap=size * 0.5, indent=INDENT)


def fit_text(text: str, width: float, height: float, tiers) -> tuple[str, float]:
    """가장 큰 글자 크기를 고르고, 가장 작은 크기로도 넘치면 글을 줄인다."""
    text = str(text or "")
    for size in tiers:
        if text_height([(text, size)], width) <= height:
            return text, size
    size = tiers[-1]
    while len(text) > 8 and text_height([(text, size)], width) > height:
        text = clip(text, int(len(text) * 0.85))
    return text, size


def paginate(items: list[str], width: float, height: float, tiers, per: int = PER_SLIDE) -> list[tuple[list[str], float]]:
    """글머리 항목을 슬라이드 단위로 나누고 각 묶음의 글자 크기를 고른다 → [(항목들, 크기)]."""
    if not items:
        return []
    n = math.ceil(len(items) / per)
    k = math.ceil(len(items) / n)
    out = []
    for i in range(0, len(items), k):
        chunk = items[i:i + k]
        size = next((s for s in tiers if _bullets_height(chunk, s, width) <= height), None)
        if size is None and len(chunk) > 1:
            half = (len(chunk) + 1) // 2
            out += paginate(chunk[:half], width, height, tiers, per) + paginate(chunk[half:], width, height, tiers, per)
            continue
        if size is None:            # 항목 하나가 너무 길면 줄인다
            text, size = fit_text(chunk[0], width - INDENT, height, tiers[-1:])
            chunk = [text]
        out.append((chunk, size))
    return out


# ---------------------------------------------------------------- 도형 · 글 헬퍼

def _num(v) -> str:
    """정수는 천 단위 쉼표, 그 밖의 값은 그대로(None은 0)."""
    if v is None:
        return "0"
    return f"{v:,}" if isinstance(v, int) else str(v)


def _rgb(hex6: str) -> RGBColor:
    return RGBColor.from_string(hex6)


def set_korean_font(rPr) -> None:
    """라틴 · 동아시아 · 복합 글꼴을 모두 FONT_KO로 지정한다(동아시아를 빼면 한글이 대체 글꼴로 나온다)."""
    for tag in ("a:latin", "a:ea", "a:cs"):
        for el in rPr.findall(qn(tag)):
            rPr.remove(el)
    # 스키마 순서: (ln, fill, effect, highlight, uLn…) 뒤에 latin, ea, cs, 그 뒤 sym, hlinkClick…
    anchor = None
    for tag in ("a:sym", "a:hlinkClick", "a:hlinkMouseOver", "a:rtl", "a:extLst"):
        anchor = rPr.find(qn(tag))
        if anchor is not None:
            break
    for tag in ("a:latin", "a:ea", "a:cs"):
        el = rPr.makeelement(qn(tag), {"typeface": theme.FONT_KO})
        if anchor is not None:
            anchor.addprevious(el)
        else:
            rPr.append(el)


def _run(p, text: str, size: float, color: str, bold: bool = False) -> None:
    r = p.add_run()
    r.text = text
    f = r.font
    f.size = Pt(size)
    f.bold = bold
    f.color.rgb = _rgb(color)
    set_korean_font(r._r.get_or_add_rPr())


def _cite_runs(text: str, size: float, color: str = theme.INK) -> list[tuple[str, float, str, bool]]:
    """본문과 [S#] 인용을 나눈다. 인용은 작고 흐린 글자로."""
    out, pos = [], 0
    for m in CITE_RE.finditer(text):
        if m.start() > pos:
            out.append((text[pos:m.start()], size, color, False))
        out.append((m.group(0), max(size - 4, 9), theme.MUTED, False))
        pos = m.end()
    if pos < len(text):
        out.append((text[pos:], size, color, False))
    return out or [(text, size, color, False)]


def _bullet(p) -> None:
    pPr = p._p.get_or_add_pPr()
    pPr.set("marL", str(int(Inches(INDENT))))
    pPr.set("indent", str(-int(Inches(INDENT))))
    clr = pPr.makeelement(qn("a:buClr"), {})
    clr.append(clr.makeelement(qn("a:srgbClr"), {"val": theme.ACCENT}))
    pPr.append(clr)
    pPr.append(pPr.makeelement(qn("a:buChar"), {"char": "•"}))


def _fill(tf, paras, size=14, color=theme.INK, bold=False, align=None, anchor=MSO_ANCHOR.TOP,
          bullets=False, gap=0.0, margins=(MX, MY)) -> None:
    """글상자 채우기. paras의 각 항목은 문자열 또는 [(글, 크기, 색, 굵게)] 목록."""
    tf.word_wrap = True
    tf.auto_size = MSO_AUTO_SIZE.NONE
    tf.margin_left = tf.margin_right = Inches(margins[0])
    tf.margin_top = tf.margin_bottom = Inches(margins[1])
    tf.vertical_anchor = anchor
    for i, para in enumerate(paras):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        runs = para if isinstance(para, list) else [(para, size, color, bold)]
        for text, s, c, b in runs:
            _run(p, text, s, c, b)
        if align is not None:
            p.alignment = align
        if gap and i < len(paras) - 1:
            p.space_after = Pt(gap)
        if bullets:
            _bullet(p)


def _textbox(slide, x, y, w, h, paras, **kw):
    tb = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    _fill(tb.text_frame, paras, **kw)
    return tb


def _rect(slide, x, y, w, h, fill, rounded=False, line=None):
    s = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE if rounded else MSO_SHAPE.RECTANGLE,
                               Inches(x), Inches(y), Inches(w), Inches(h))
    if rounded:
        s.adjustments[0] = 0.08
    s.fill.solid()
    s.fill.fore_color.rgb = _rgb(fill)
    if line:
        s.line.color.rgb = _rgb(line)
        s.line.width = Pt(0.75)
    else:
        s.line.fill.background()
    s.shadow.inherit = False
    return s


def _bullet_box(slide, x, y, w, h, items, size):
    paras = [_cite_runs(t, size) for t in items]
    return _textbox(slide, x, y, w, h, paras, bullets=True, gap=size * 0.5)


def _table(slide, x, y, widths, rows, header, size=12):
    """표: rows는 칸 문자열(또는 run 목록) 목록. 행 높이는 내용으로 어림해 지정한다."""
    heights = [_row_height(header, widths, size)] + [_row_height(r, widths, size) for r in rows]
    gf = slide.shapes.add_table(len(rows) + 1, len(widths), Inches(x), Inches(y), Inches(sum(widths)),
                                Inches(sum(heights)))
    tbl = gf.table
    for j, w in enumerate(widths):
        tbl.columns[j].width = Inches(w)
    for i, h in enumerate(heights):
        tbl.rows[i].height = Inches(h)
    for i, row in enumerate([header] + rows):
        for j, val in enumerate(row):
            cell = tbl.cell(i, j)
            cell.fill.solid()
            cell.fill.fore_color.rgb = _rgb(theme.ACCENT if i == 0 else
                                            (theme.SURFACE if i % 2 else theme.SURFACE_ALT))
            cell.margin_left = cell.margin_right = Inches(CELL_MX)
            cell.margin_top = cell.margin_bottom = Inches(CELL_MY)
            paras = val if isinstance(val, tuple) else (val,)
            if i == 0:
                paras = [[(str(val), size, theme.SURFACE, True)]]
            else:
                paras = [p if isinstance(p, list) else _cite_runs(str(p), size) for p in paras]
            _fill(cell.text_frame, paras, size=size, margins=(CELL_MX, CELL_MY), anchor=MSO_ANCHOR.MIDDLE)
    return gf


def _cell_paras(val, size):
    paras = val if isinstance(val, tuple) else (val,)
    out = []
    for p in paras:
        if isinstance(p, list):
            out.append(("".join(r[0] for r in p), max(r[1] for r in p)))
        else:
            out.append((str(p), size))
    return out


def _row_height(row, widths, size) -> float:
    need = 0.0
    for val, w in zip(row, widths):
        paras = _cell_paras(val, size)
        h = sum(text_lines(t, s, w - 2 * CELL_MX) * s * LINE / 72 for t, s in paras) + 2 * CELL_MY + 0.02
        need = max(need, h)
    return need


def _table_pages(rows, widths, height, size, per=6):
    """행을 슬라이드 단위로 나눈다(행 수 per 이하, 높이 height 이하)."""
    pages, cur, used = [], [], _row_height(["가"] * len(widths), widths, size)
    head = used
    for r in rows:
        h = _row_height(r, widths, size)
        if cur and (len(cur) >= per or used + h > height):
            pages.append(cur)
            cur, used = [], head
        cur.append(r)
        used += h
    if cur:
        pages.append(cur)
    return pages


def _fit_cell(text, width, size, max_lines):
    """표 칸 글을 max_lines 줄 안으로 줄인다."""
    text = str(text or "")
    while len(text) > 8 and text_lines(text, size, width - 2 * CELL_MX) > max_lines:
        text = clip(text, int(len(text) * 0.85))
    return text


# ---------------------------------------------------------------- 차트

def _chart(slide, kind, x, y, w, h, cats, series, colors, legend=False, labels_inside=False):
    data = CategoryChartData()
    data.categories = cats
    for name, vals in series:
        data.add_series(name, vals)
    gf = slide.shapes.add_chart(kind, Inches(x), Inches(y), Inches(w), Inches(h), data)
    ch = gf.chart
    ch.has_title = False
    ch.font.size = Pt(11)
    ch.font.name = theme.FONT_KO
    ch.font.color.rgb = _rgb(theme.INK_2)
    set_korean_font(ch.font._rPr)
    ch.has_legend = legend
    if legend:
        ch.legend.position = XL_LEGEND_POSITION.BOTTOM
        ch.legend.include_in_layout = False
        ch.legend.font.size = Pt(11)
    plot = ch.plots[0]
    plot.gap_width = 45 if not labels_inside else 30
    if labels_inside:
        plot.overlap = 100
    plot.has_data_labels = True
    dl = plot.data_labels
    dl.number_format = "0"
    dl.number_format_is_linked = False
    dl.font.size = Pt(11)
    dl.position = XL_LABEL_POSITION.CENTER if labels_inside else XL_LABEL_POSITION.OUTSIDE_END
    va = ch.value_axis
    va.has_major_gridlines = False
    va.has_minor_gridlines = False
    va.visible = False
    va.minimum_scale = 0
    if not labels_inside:
        va.maximum_scale = max([max(v) for _, v in series] + [1]) * 1.18
    ca = ch.category_axis
    ca.has_major_gridlines = False
    ca.format.line.color.rgb = _rgb(theme.RULE)
    ca.tick_labels.font.size = Pt(11)
    for i, s in enumerate(plot.series):
        s.format.fill.solid()
        s.format.fill.fore_color.rgb = _rgb(colors[i])
        s.invert_if_negative = False
        if labels_inside:     # 밝은 계열색에는 진한 글자
            dark = colors[i] in ("EDA100", "E87BA4", "1BAF7A")
            s.data_labels.font.color.rgb = _rgb(theme.INK if dark else theme.SURFACE)
            s.data_labels.font.size = Pt(11)
            s.data_labels.number_format = "0"
            s.data_labels.number_format_is_linked = False
            s.data_labels.position = XL_LABEL_POSITION.CENTER
    return ch


def study_type_rows(stats: dict, other: str, labels: dict | None = None) -> list[tuple[str, int]]:
    """연구 유형: 많은 순으로 최대 7개 + 나머지를 합친 '기타' 한 줄. labels가 있으면 표시 이름으로 바꾼다.
    원래 유형이 'other'이거나 비어 있는 것도 '기타'에 합쳐 같은 이름이 두 번 나오지 않게 한다."""
    labels = labels or {}
    named, rest = [], 0
    for k, v in sorted((stats.get("by_study_type") or {}).items(), key=lambda kv: -int(kv[1] or 0)):
        k, v = str(k), int(v or 0)
        if v <= 0:
            continue
        if k in ("", "other") or len(named) >= 7:
            rest += v
        else:
            named.append((labels.get(k, k), v))
    return named + ([(other, rest)] if rest else [])


def year_rows(stats: dict) -> list[tuple[str, int]]:
    rows = [(str(k), int(v or 0)) for k, v in (stats.get("by_year") or {}).items()]
    return sorted(rows, key=lambda kv: kv[0])


def direction_rows(stats: dict) -> list[tuple[str, int, int]]:
    """결과 방향: (키, 개수, 고정 색 순번). 개수 0은 뺀다."""
    d = stats.get("by_direction") or {}
    keys = DIRECTIONS + [k for k in d if k not in DIRECTIONS]
    return [(k, int(d.get(k) or 0), i) for i, k in enumerate(keys) if int(d.get(k) or 0) > 0]


# ---------------------------------------------------------------- 덱

class _Deck:
    def __init__(self, result: dict, outline: dict):
        self.r, self.o = result, outline
        self.lang = "ko" if result.get("lang") == "ko" else "en"
        self.T = TXT[self.lang]
        self.prs = Presentation()
        self.prs.slide_width, self.prs.slide_height = Inches(W), Inches(H)
        self.blank = self.prs.slide_layouts[6]
        self.topic = result.get("topic") or result.get("prompt") or outline.get("title") or ""
        self.sources = sources_by_id(result)
        self.syn = result.get("syntheses") or {}
        self.plan = [q for q in (result.get("plan") or {}).get("sub_questions") or [] if isinstance(q, dict)]

    # --- 공통 틀
    def _strength_label(self, s):
        return (theme.STRENGTH_LABEL if self.lang == "ko" else STRENGTH_EN).get(s, s or "-")

    def _verdict_label(self, v):
        return (theme.VERDICT_LABEL if self.lang == "ko" else VERDICT_EN).get(v, v)

    def _direction_label(self, d):
        if self.lang == "ko":
            return theme.DIRECTION_LABEL.get(d, d)
        return {"": "Unclassified", "null": "No effect"}.get(d, d.capitalize())

    def slide(self, kicker: str, title: str):
        """머리말(구역 이름 · 제목 · 강조선)과 꼬리말(주제 · 쪽 번호)이 있는 슬라이드."""
        s = self.prs.slides.add_slide(self.blank)
        n = len(self.prs.slides)
        k, ks = fit_text(kicker, CW, KICK_H, (12,))
        _textbox(s, ML, KICK_Y, CW, KICK_H, [k], size=ks, color=theme.ACCENT, bold=True)
        t, ts = fit_text(title, CW, TITLE_H, TITLE_TIERS)
        _textbox(s, ML, TITLE_Y, CW, TITLE_H, [t], size=ts, color=theme.INK, bold=True, anchor=MSO_ANCHOR.BOTTOM)
        _rect(s, ML, RULE_Y, 0.9, 0.05, theme.ACCENT)
        _rect(s, ML + 0.9, RULE_Y + 0.02, CW - 0.9, 0.01, theme.RULE)
        foot, fs = fit_text(self.topic, CW - 1.2, FOOT_H, (10,))
        _textbox(s, ML, FOOT_Y, CW - 1.2, FOOT_H, [foot], size=fs, color=theme.MUTED)
        _textbox(s, W - ML - 1.0, FOOT_Y, 1.0, FOOT_H, [str(n)], size=10, color=theme.MUTED, align=PP_ALIGN.RIGHT)
        return s

    def bullet_slides(self, kicker, title, items, tiers=BODY_TIERS):
        for i, (chunk, size) in enumerate(paginate(items, CW, CH, tiers)):
            s = self.slide(kicker, title if i == 0 else f"{title} {self.T['cont']}")
            _bullet_box(s, ML, TOP, CW, CH, chunk, size)

    # --- a. 표지
    def title_slide(self):
        T, m = self.T, meta_info(self.r)
        s = self.prs.slides.add_slide(self.blank)
        _rect(s, 0, 0, 0.22, H, theme.ACCENT)
        _rect(s, 0.22, H - 0.9, W - 0.22, 0.9, theme.SURFACE_ALT)
        _textbox(s, 1.0, 0.9, 8.0, 0.4, [T["product"]], size=14, color=theme.ACCENT, bold=True)
        title, size = fit_text(self.o.get("title") or self.topic, 11.3, 2.7, (40, 36, 32, 28, 24))
        _textbox(s, 1.0, 1.55, 11.3, 2.7, [title], size=size, color=theme.INK, bold=True, anchor=MSO_ANCHOR.BOTTOM)
        _rect(s, 1.0, 4.45, 1.2, 0.06, theme.ACCENT)
        if self.o.get("subtitle"):
            sub, ss = fit_text(self.o["subtitle"], 11.3, 0.9, (20, 18, 16))
            _textbox(s, 1.0, 4.7, 11.3, 0.9, [sub], size=ss, color=theme.INK_2)
        parts = [m["date"], m["model"], f"{T['collected']} {_num(m['collected'])}{T['unit']}",
                 f"{T['inc']} {_num(m['included'])}{T['unit']}", f"{T['window']}: {m['window']}"]
        line, ls = fit_text(" · ".join(p for p in parts if p), 11.3, 0.62, (13, 12))
        _textbox(s, 1.0, H - 0.78, 11.3, 0.62, [line], size=ls, color=theme.INK_2, anchor=MSO_ANCHOR.MIDDLE)

    # --- b. 핵심 요약
    def summary(self):
        items = self.o.get("summary") or []
        if items:
            self.bullet_slides(self.T["summary_k"], self.T["summary_t"], items)
        else:
            s = self.slide(self.T["summary_k"], self.T["summary_t"])
            _textbox(s, ML, TOP, CW, 0.5, [self.T["none"]], size=16, color=theme.MUTED)

    # --- c. 연구 설계
    def design(self):
        T, m = self.T, meta_info(self.r)
        s = self.slide(T["design_k"], T["design_t"])
        _textbox(s, ML, TOP, CW, 0.36, [T["pipeline"]], size=13, color=theme.MUTED, bold=True)
        gap, n = 0.12, len(T["stages"])
        cw, cy, chh = (CW - gap * (n - 1)) / n, TOP + 0.45, 1.3
        _rect(s, ML, cy + chh / 2 - 0.01, CW, 0.02, theme.RULE)
        for i, (label, desc) in enumerate(T["stages"]):
            x = ML + i * (cw + gap)
            chip = _rect(s, x, cy, cw, chh, theme.ACCENT_SOFT, rounded=True)
            _fill(chip.text_frame, [[(f"{i + 1:02d}", 11, theme.ACCENT, True)], [(label, 14, theme.INK, True)],
                                    [(desc, 10, theme.INK_2, False)]], align=PP_ALIGN.CENTER,
                  anchor=MSO_ANCHOR.MIDDLE)
        ty = TOP + 2.15
        _textbox(s, ML, ty, CW, 0.36, [T["scale"]], size=13, color=theme.MUTED, bold=True)
        vals = [m["collected"], m["included"], m["merged"], m["calls"], m["minutes"]]
        gap, n = 0.2, len(vals)
        tw = (CW - gap * (n - 1)) / n
        for i, (label, v) in enumerate(zip(T["tiles"], vals)):
            x = ML + i * (tw + gap)
            tile = _rect(s, x, ty + 0.45, tw, 1.35, theme.SURFACE_ALT, rounded=True)
            _fill(tile.text_frame, [[(_num(v), 30, theme.ACCENT_DARK, True)], [(label, 12, theme.INK_2, False)]],
                  align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
        disabled = (self.r.get("meta") or {}).get("disabled_tools") or []
        parts = [f"{T['n_subq']} {len(self.plan)}{T['unit_q']}", f"{T['window']}: {m['window']}",
                 f"{T['model']}: {m['model'] or '-'}"]
        if disabled:
            parts.append(f"{T['disabled']}: {', '.join(map(str, disabled))}")
        line, ls = fit_text(" · ".join(parts), CW, 0.6, (14, 13, 12))
        _textbox(s, ML, BOTTOM - 0.6, CW, 0.6, [line], size=ls, color=theme.INK_2)

    # --- d. 하위 질문 표
    def subquestions(self):
        T = self.T
        if not self.plan:
            return
        widths = [0.9, 2.9, CW - 3.8]
        rows = [(clip(q.get("id"), 8), _fit_cell(clip(q.get("perspective"), 80), widths[1], 12, 3),
                 _fit_cell(clip(q.get("question"), 260), widths[2], 12, 5)) for q in self.plan]
        for i, page in enumerate(_table_pages(rows, widths, CH, 12)):
            s = self.slide(T["subq_k"], T["subq_t"] if i == 0 else f"{T['subq_t']} {T['cont']}")
            _table(s, ML, TOP, widths, list(page), T["cols_q"])

    # --- e. 근거 프로필
    def evidence(self):
        T, stats = self.T, self.r.get("stats") or {}
        labels = theme.STUDY_TYPE_LABEL if self.lang == "ko" else None
        studies, years, dirs = study_type_rows(stats, T["other"], labels), year_rows(stats), direction_rows(stats)
        if not (studies or years or dirs):
            return
        s = self.slide(T["ev_k"], T["ev_t"])
        lw, rx = 6.2, ML + 6.6
        rw = CW - 6.6

        def title(x, y, w, text):
            _textbox(s, x, y, w, 0.4, [text], size=14, color=theme.INK, bold=True)

        def empty(x, y, w):
            _textbox(s, x, y, w, 0.4, [T["none"]], size=12, color=theme.MUTED)

        title(ML, TOP, lw, T["study"])
        if studies:
            ch = _chart(s, XL_CHART_TYPE.BAR_CLUSTERED, ML, TOP + 0.45, lw, CH - 0.45,
                        [k for k, _ in studies], [(T["included"], [v for _, v in studies])], [theme.SEQUENTIAL])
            ch.category_axis.reverse_order = True      # 많은 것이 위로
        else:
            empty(ML, TOP + 0.45, lw)
        title(rx, TOP, rw, T["year"])
        if years:
            _chart(s, XL_CHART_TYPE.COLUMN_CLUSTERED, rx, TOP + 0.45, rw, 2.2,
                   [k for k, _ in years], [(T["included"], [v for _, v in years])], [theme.SEQUENTIAL])
        else:
            empty(rx, TOP + 0.45, rw)
        title(rx, TOP + 2.85, rw, T["direction"])
        if dirs:
            ch = _chart(s, XL_CHART_TYPE.BAR_STACKED, rx, TOP + 3.3, rw, CH - 3.3, [T["included"]],
                        [(self._direction_label(k), [v]) for k, v, _ in dirs],
                        [theme.DIRECTION_COLOR.get(k, theme.NEUTRAL_FILL) for k, _, _ in dirs], legend=True, labels_inside=True)
            ch.category_axis.visible = False
        else:
            empty(rx, TOP + 3.3, rw)

    # --- f. 하위 질문별 결과
    def findings(self):
        T = self.T
        plan = {q.get("id"): q for q in self.plan}
        bw, px = 8.4, ML + 8.8
        pw = CW - 8.8
        for f in self.o.get("findings") or []:
            qid, q = f.get("subq_id") or "", plan.get(f.get("subq_id")) or {}
            syn = self.syn.get(qid) or {}
            kicker = f"{qid} · {clean_one(q.get('question') or q.get('perspective') or '')}".strip(" ·")
            headline = f.get("headline") or qid
            pages = paginate(f.get("bullets") or [], bw, CH, BODY_TIERS) or [([], BODY_TIERS[0])]
            for i, (chunk, size) in enumerate(pages):
                s = self.slide(kicker, headline if i == 0 else f"{headline} {T['cont']}")
                if chunk:
                    _bullet_box(s, ML, TOP, bw, CH, chunk, size)
                self._strength_panel(s, px, pw, f, syn, q)
                notes = syn.get("answer") or ""
                if notes:
                    tf = s.notes_slide.notes_text_frame
                    _fill(tf, [notes], size=12)

    def _strength_panel(self, s, x, w, f, syn, q):
        T = self.T
        _rect(s, x, TOP, w, 1.75, theme.SURFACE_ALT, rounded=True)
        _textbox(s, x + 0.2, TOP + 0.15, w - 0.4, 0.34, [T["strength"]], size=12, color=theme.MUTED, bold=True)
        st = f.get("strength") or "insufficient"
        badge = _rect(s, x + 0.2, TOP + 0.55, 1.6, 0.5, STRENGTH_COLOR.get(st, theme.MUTED), rounded=True)
        _fill(badge.text_frame, [self._strength_label(st)], size=16, color=theme.SURFACE, bold=True,
              align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
        n = len(syn.get("sources") or [])
        _textbox(s, x + 0.2, TOP + 1.2, w - 0.4, 0.36, [f"{T['related']} {n}{T['unit_src']}"], size=12,
                 color=theme.INK_2)
        question = clean_one(q.get("question") or "")
        if question:
            y, h = TOP + 1.95, CH - 1.95
            _rect(s, x, y, w, h, theme.SURFACE, rounded=True, line=theme.RULE)
            _textbox(s, x + 0.2, y + 0.12, w - 0.4, 0.34, [T["subq"]], size=12, color=theme.MUTED, bold=True)
            text, size = fit_text(question, w - 0.4, h - 0.6, (13, 12, 11))
            _textbox(s, x + 0.2, y + 0.48, w - 0.4, h - 0.6, [text], size=size, color=theme.INK_2)

    # --- g. 일치와 상충
    def agreement(self):
        T = self.T
        agree, conflict = self.o.get("agreements") or [], self.o.get("conflicts") or []
        if not (agree or conflict):
            return
        cw = (CW - 0.4) / 2
        iw, ih = cw - 0.5, CH - 0.85
        tiers = (16, 14)               # 두 칸이라 좁으므로, 14pt로도 넘치면 다음 슬라이드로 넘긴다
        pa, pc = paginate(agree, iw, ih, tiers, 4), paginate(conflict, iw, ih, tiers, 4)
        for i in range(max(len(pa), len(pc))):
            s = self.slide(T["agree_k"], T["agree_t"] if i == 0 else f"{T['agree_t']} {T['cont']}")
            sizes = [p[i][1] for p in (pa, pc) if i < len(p)]
            for j, (label, pages, color) in enumerate(((T["agree"], pa, theme.ACCENT), (T["conflict"], pc, theme.INK_2))):
                x = ML + j * (cw + 0.4)
                _rect(s, x, TOP, cw, CH, theme.SURFACE_ALT, rounded=True)
                _rect(s, x + 0.25, TOP + 0.2, 0.5, 0.06, color)
                _textbox(s, x + 0.25, TOP + 0.3, iw, 0.42, [label], size=16, color=color, bold=True)
                if i < len(pages):
                    _bullet_box(s, x + 0.25, TOP + 0.8, iw, ih, pages[i][0], min(sizes))

    # --- h. 연구 공백
    def gaps(self):
        if self.o.get("gaps"):
            self.bullet_slides(self.T["gaps_k"], self.T["gaps_t"], self.o["gaps"])

    # --- i. 향후 연구
    def future(self):
        T, studies = self.T, self.o.get("future_studies") or []
        if not studies:
            return
        cw = (CW - 0.3 * (len(studies) - 1)) / len(studies)
        iw = cw - 0.4

        def card_paras(st, size):
            paras = [[(st["title"], size + 2, theme.INK, True)]]
            for key, label in T["fields"]:
                if st.get(key):
                    paras += [[(label, size - 1, theme.ACCENT, True)], [(st[key], size, theme.INK_2, False)]]
            return paras

        def fits(st, size):
            flat = [("".join(r[0] for r in p), p[0][1]) for p in card_paras(st, size)]
            return text_height(flat, iw, gap=4) <= CH - 0.3

        size = next((sz for sz in (13, 12, 11) if all(fits(st, sz) for st in studies)), None)
        if size:
            s = self.slide(T["future_k"], T["future_t"])
            for i, st in enumerate(studies):
                x = ML + i * (cw + 0.3)
                _rect(s, x, TOP, cw, CH, theme.SURFACE_ALT, rounded=True)
                _rect(s, x + 0.2, TOP + 0.15, 0.5, 0.06, theme.ACCENT)
                _textbox(s, x + 0.2, TOP + 0.25, iw, CH - 0.35, card_paras(st, size), gap=4)
            return
        for i, st in enumerate(studies):        # 글이 길면 연구 하나에 슬라이드 하나
            s = self.slide(f"{T['future_k']} {i + 1}/{len(studies)}", st["title"])
            fields = [(label, st.get(key)) for key, label in T["fields"] if st.get(key)]
            colw = (CW - 0.4) / 2
            for j, (label, text) in enumerate(fields):
                x, y = ML + (j % 2) * (colw + 0.4), TOP + (j // 2) * (CH / 2)
                bh = CH / 2 - 0.2
                _rect(s, x, y, colw, bh, theme.SURFACE_ALT, rounded=True)
                _textbox(s, x + 0.2, y + 0.12, colw - 0.4, 0.38, [label], size=13, color=theme.ACCENT, bold=True)
                body, bs = fit_text(text, colw - 0.4, bh - 0.62, (18, 16, 14, 13))
                _textbox(s, x + 0.2, y + 0.52, colw - 0.4, bh - 0.62, [body], size=bs, color=theme.INK)

    # --- j. 필독 문헌
    def must_read(self):
        T, items = self.T, self.o.get("must_read") or []
        rows = []
        widths = [0.8, 5.4, CW - 6.2]
        for i, m in enumerate(items):
            src = self.sources.get(m.get("sid")) or {}
            cite = f"[{m['sid']}] {short_cite(src)}"
            title = _fit_cell(clip(src.get("title"), 140), widths[1], 11, 3)
            rows.append((str(i + 1), ([(cite, 12, theme.INK, True)], [(title, 11, theme.INK_2, False)]),
                         _fit_cell(m.get("why") or "", widths[2], 12, 4)))
        if not rows:
            return
        for i, page in enumerate(_table_pages(rows, widths, CH, 12)):
            s = self.slide(T["must_k"], T["must_t"] if i == 0 else f"{T['must_t']} {T['cont']}")
            _table(s, ML, TOP, widths, list(page), T["cols_m"])

    # --- k. 한계와 인용 검증
    def limitations(self):
        T = self.T
        lw, px = 7.3, ML + 7.7
        pw = CW - 7.7
        pages = paginate(self.o.get("limitations") or [], lw, CH, SMALL_TIERS + (11,)) or [([], 14)]
        for i, (chunk, size) in enumerate(pages):
            s = self.slide(T["lim_k"], T["lim_t"] if i == 0 else f"{T['lim_t']} {T['cont']}")
            if chunk:
                _bullet_box(s, ML, TOP, lw, CH, chunk, size)
            else:
                _textbox(s, ML, TOP, lw, 0.5, [T["no_lim"]], size=16, color=theme.MUTED)
            self._check_panel(s, px, pw)

    def _check_panel(self, s, x, w):
        T, v = self.T, self.r.get("verification") or {}
        checks = v.get("checks") or []
        _rect(s, x, TOP, w, CH, theme.SURFACE_ALT, rounded=True)
        _textbox(s, x + 0.25, TOP + 0.15, w - 0.5, 0.42, [T["check"]], size=16, color=theme.INK, bold=True)
        figs = [v.get("cited_ids") or 0, len(v.get("unknown_ids") or []), len(checks)]
        fw = (w - 0.5) / 3
        for i, (label, n) in enumerate(zip(T["fig"], figs)):
            _textbox(s, x + 0.25 + i * fw, TOP + 0.65, fw, 0.95,
                     [[(_num(n), 24, theme.ACCENT_DARK, True)], [(label, 11, theme.MUTED, False)]])
        before, after = verdict_tally(checks), verdict_tally(checks, after=True)
        y, cols = TOP + 1.85, [w - 0.5 - 2.0, 1.0, 1.0]
        hx = [x + 0.25, x + 0.25 + cols[0], x + 0.25 + cols[0] + cols[1]]
        for j, label in enumerate([T["verdict"], T["before"], T["after"]]):
            _textbox(s, hx[j], y, cols[j], 0.34, [label], size=11, color=theme.MUTED, bold=True,
                     align=PP_ALIGN.LEFT if j == 0 else PP_ALIGN.RIGHT)
        _rect(s, x + 0.25, y + 0.38, w - 0.5, 0.01, theme.RULE)
        for i, key in enumerate(VERDICTS):
            ry = y + 0.48 + i * 0.5
            _rect(s, hx[0], ry + 0.12, 0.14, 0.14, theme.VERDICT_COLOR[key])
            _textbox(s, hx[0] + 0.22, ry, cols[0] - 0.22, 0.4, [self._verdict_label(key)], size=13, color=theme.INK)
            _textbox(s, hx[1], ry, cols[1], 0.4, [str(before[key])], size=13, color=theme.INK_2, align=PP_ALIGN.RIGHT)
            _textbox(s, hx[2], ry, cols[2], 0.4, [str(after[key])], size=13, color=theme.INK, bold=True,
                     align=PP_ALIGN.RIGHT)

    # --- l. 참고문헌
    def references(self):
        T = self.T
        texts = [self.o.get("title", ""), self.o.get("subtitle", "")]
        for key in ("summary", "agreements", "conflicts", "gaps", "limitations"):
            texts += self.o.get(key) or []
        for f in self.o.get("findings") or []:
            texts += [f.get("headline", "")] + (f.get("bullets") or [])
        for st in self.o.get("future_studies") or []:
            texts += list(st.values())
        ids = set(cited_ids("\n".join(texts))) | {m["sid"] for m in self.o.get("must_read") or []}
        ids = sorted((i for i in ids if i in self.sources), key=lambda i: int(i[1:]))
        if not ids:
            return
        entries = []
        for sid in ids:
            src = self.sources[sid]
            body = f"{authors_text(src) or src.get('venue') or 'n.a.'} ({src.get('year') or 'n.d.'}). " \
                   f"{src.get('title') or ''}. {src.get('venue') or ''}".strip()
            entries.append(f"[{sid}] " + clip(body.rstrip(". ") + ".", 230))
        for i, (chunk, size) in enumerate(paginate(entries, CW, CH, (13, 12, 11), per=9)):
            s = self.slide(T["refs_k"], T["refs_t"] if i == 0 else f"{T['refs_t']} {T['cont']}")
            paras = []
            for line in chunk:
                m = re.match(r"(\[S\d+\] )(.*)$", line)
                head, rest = (m.group(1), m.group(2)) if m else ("", line)
                paras.append([(head, size, theme.ACCENT, True), (rest, size, theme.INK, False)] if head
                             else [(rest, size, theme.INK, False)])
            _textbox(s, ML, TOP, CW, CH, paras, gap=size * 0.5)

    def build(self, path: Path) -> Path:
        self.prs.core_properties.title = clip(self.topic, 200)
        self.prs.core_properties.author = "AI Research Agent"
        for step in (self.title_slide, self.summary, self.design, self.subquestions, self.evidence, self.findings,
                     self.agreement, self.gaps, self.future, self.must_read, self.limitations, self.references):
            step()
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self.prs.save(str(path))
        return path


def clean_one(text) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


def build_pptx(result: dict, outline: dict | None, path) -> Path:
    """result(SPEC 3.2)와 슬라이드 개요로 발표 슬라이드를 만든다. outline이 None이면 규칙 기반 개요를 쓴다."""
    outline = normalize_outline(outline, result) if outline else fallback_outline(result)
    return _Deck(result, outline).build(Path(path))
