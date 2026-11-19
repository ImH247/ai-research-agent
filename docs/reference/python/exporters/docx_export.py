"""Word(.docx) 보고서 내보내기. result dict(SPEC 3.2) 하나로 표지 · 목차 · 본문 · 부록 A~D를 python-docx로 만든다.

- 본문 Markdown은 정규식이 아니라 markdown-it-py 토큰을 차례로 읽어 Word 단락 · 목록 · 표로 바꾼다.
- [S12] 같은 인용은 부록 B 참고문헌 항목의 책갈피(ref_S12)로 가는 문서 내부 링크가 된다.
- 목차는 Word가 채우는 TOC 필드다(문서를 열 때 필드 업데이트를 묻도록 설정).
"""
from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path

from docx import Document
from docx.enum.section import WD_ORIENT, WD_SECTION
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.opc.constants import RELATIONSHIP_TYPE as RT
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import nsdecls, qn
from docx.shared import Cm, Pt, RGBColor
from markdown_it import MarkdownIt

from exporters.common import (CITE_RE, VERDICTS, authors_text, included_sources, labels, meta_info,
                              reference_sources, short_cite, verdict_tally)
from exporters.theme import (ACCENT, ACCENT_DARK, DIRECTION_LABEL, FONT_KO, FONT_MONO, INK, INK_2, KIND_LABEL,
                             MUTED, RULE, SURFACE_ALT, VERDICT_COLOR, VERDICT_LABEL)

MD = MarkdownIt("commonmark", {"html": False}).enable("table")
BAD_XML = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff￾￿]")   # XML 1.0에서 쓸 수 없는 문자
BR_RE = re.compile(r"<br\s*/?>", re.I)                                          # 표 칸 안의 <br> (이스케이프된 것도 토큰에서는 같은 글자)
SID_RE = re.compile(r"S\d+")

PAGE_W, PAGE_H, MARGIN = 21.0, 29.7, 2.2          # A4, cm
TEXT_W = PAGE_W - 2 * MARGIN                       # 세로 페이지 본문 폭 16.6cm
TEXT_W_LAND = PAGE_H - 2 * MARGIN                  # 가로 페이지 본문 폭 25.3cm
HEADING = {1: (20, ACCENT_DARK, 18, 8), 2: (15, ACCENT_DARK, 16, 6), 3: (12.5, INK, 12, 4), 4: (11, INK_2, 10, 3)}
LIST_INDENT, LIST_HANG = 425, 283                  # 목록 수준별 들여쓰기 · 내어쓰기 (twip)

# 이 형식에만 필요한 문구 (나머지는 common.labels)
TEXT = {
    "ko": dict(duration="소요 시간", tokens_fmt="입력 {i} · 출력 {o}", calls_fmt="{n}회", count_fmt="{a} / {b}건",
               toc_wait="(목차를 만들려면 필드를 업데이트하세요)",
               toc_hint="목차가 비어 있거나 쪽 번호가 맞지 않으면 목차를 마우스 오른쪽 단추로 누르고 '필드 업데이트'를 고르세요.",
               empty_body="보고서 본문이 없습니다.", no_sources="채택된 문헌이 없습니다.", no_checks="검증한 문장이 없습니다.",
               no_trace="수행 기록이 없습니다.", verdict="판정", unknown="목록에 없는 인용 ID", cites="피인용 {n}회",
               trace_cols=["시각", "단계", "내용"]),
    "en": dict(duration="Duration", tokens_fmt="in {i} · out {o}", calls_fmt="{n}", count_fmt="{a} / {b}",
               toc_wait="(update fields to build the table of contents)",
               toc_hint="If the contents are empty or page numbers are wrong, right-click the table of contents and choose 'Update Field'.",
               empty_body="The report body is empty.", no_sources="No included sources.", no_checks="No claims were checked.",
               no_trace="No trace recorded.", verdict="Verdict", unknown="Cited ids not in the list", cites="cited by {n}",
               trace_cols=["Time", "Stage", "Message"]),
}
STAGE_KO = {"understand": "주제 이해", "plan": "계획 수립", "act": "자료 탐색", "evaluate": "문헌 평가", "synthesize": "종합",
            "reflect": "비평", "report": "보고서 작성", "verify": "인용 검증", "export": "내보내기", "system": "시스템"}


def clean(text) -> str:
    """XML에 넣을 수 없는 제어 문자를 지운 문자열."""
    return BAD_XML.sub("", "" if text is None else str(text))


def _num(v) -> str:
    return f"{v:,}" if isinstance(v, (int, float)) and not isinstance(v, bool) else clean(v)


# ---------- 낮은 수준 XML 헬퍼 ----------

def _el(tag: str, **attrs):
    e = OxmlElement(tag)
    for k, v in attrs.items():
        e.set(qn(f"w:{k}"), str(v))
    return e


def _fonts(rfonts, name: str, east: str = FONT_KO):
    """rFonts에 라틴·한글 글꼴을 직접 지정하고 테마 글꼴 지정은 지운다(안 지우면 한글이 다른 글꼴로 바뀐다)."""
    for a in ("asciiTheme", "hAnsiTheme", "eastAsiaTheme", "cstheme"):
        rfonts.attrib.pop(qn(f"w:{a}"), None)
    for a in ("ascii", "hAnsi", "cs"):
        rfonts.set(qn(f"w:{a}"), name)
    rfonts.set(qn("w:eastAsia"), east)


def _run(text: str, fmt: dict):
    """w:r 요소. fmt: bold, italic, code, color, size(pt), underline. 글 속 \\n은 줄바꿈, \\t는 탭."""
    r, rpr = OxmlElement("w:r"), OxmlElement("w:rPr")
    if fmt.get("code"):
        rf = OxmlElement("w:rFonts")
        _fonts(rf, FONT_MONO)
        rpr.append(rf)
    if fmt.get("bold"):
        rpr.append(_el("w:b"))
    if fmt.get("italic"):
        rpr.append(_el("w:i"))
    if fmt.get("color"):
        rpr.append(_el("w:color", val=fmt["color"]))
    if fmt.get("size"):
        rpr.append(_el("w:sz", val=round(fmt["size"] * 2)))
        rpr.append(_el("w:szCs", val=round(fmt["size"] * 2)))
    if fmt.get("underline"):
        rpr.append(_el("w:u", val="single"))
    if fmt.get("code"):
        rpr.append(_el("w:shd", val="clear", color="auto", fill=SURFACE_ALT))
    if len(rpr):
        r.append(rpr)
    for k, line in enumerate(clean(text).split("\n")):
        if k:
            r.append(OxmlElement("w:br"))
        for j, piece in enumerate(line.split("\t")):
            if j:
                r.append(OxmlElement("w:tab"))
            if piece:
                t = OxmlElement("w:t")
                t.set(qn("xml:space"), "preserve")
                t.text = piece
                r.append(t)
    return r


_PPR_AFTER_SHD = ("w:tabs", "w:suppressAutoHyphens", "w:kinsoku", "w:wordWrap", "w:overflowPunct", "w:topLinePunct",
                  "w:autoSpaceDE", "w:autoSpaceDN", "w:bidi", "w:adjustRightInd", "w:snapToGrid", "w:spacing", "w:ind",
                  "w:contextualSpacing", "w:mirrorIndents", "w:suppressOverlap", "w:jc", "w:textDirection",
                  "w:textAlignment", "w:textboxTightWrap", "w:outlineLvl", "w:divId", "w:cnfStyle", "w:rPr",
                  "w:sectPr", "w:pPrChange")


def _border(ppr, side="bottom", color=RULE, sz=6, space=1):
    """단락 테두리(구분선 · 인용 왼쪽 선)."""
    bdr = ppr.find(qn("w:pBdr"))
    if bdr is None:
        bdr = OxmlElement("w:pBdr")
        ppr.insert_element_before(bdr, "w:shd", *_PPR_AFTER_SHD)
    bdr.append(_el(f"w:{side}", val="single", sz=sz, space=space, color=color))


def _shade_par(ppr, fill=SURFACE_ALT):
    ppr.insert_element_before(_el("w:shd", val="clear", color="auto", fill=fill), *_PPR_AFTER_SHD)


def _pfmt(p, before=None, after=None, line=None, left=None, first=None, keep=False, align=None):
    f = p.paragraph_format
    if before is not None:
        f.space_before = Pt(before)
    if after is not None:
        f.space_after = Pt(after)
    if line is not None:
        f.line_spacing = line
    if left is not None:
        f.left_indent = Cm(left)
    if first is not None:
        f.first_line_indent = Cm(first)
    if keep:
        f.keep_with_next = True
    if align is not None:
        f.alignment = align
    return p


def _field(p, instr: str, placeholder: str, fmt: dict):
    """복합 필드(begin · instrText · separate · 자리 글자 · end)를 단락에 넣는다."""
    p._p.append(_wrap(_el("w:fldChar", fldCharType="begin")))
    r = OxmlElement("w:r")
    it = OxmlElement("w:instrText")
    it.set(qn("xml:space"), "preserve")
    it.text = instr
    r.append(it)
    p._p.append(r)
    p._p.append(_wrap(_el("w:fldChar", fldCharType="separate")))
    p._p.append(_run(placeholder, fmt))
    p._p.append(_wrap(_el("w:fldChar", fldCharType="end")))


def _wrap(child):
    r = OxmlElement("w:r")
    r.append(child)
    return r


# ---------- 문서 작성기 ----------

class _Writer:
    def __init__(self, result: dict):
        # 문헌은 S 번호가 올바른 dict만 쓴다 (이상한 항목 때문에 공통 헬퍼가 죽지 않게)
        sources = [s for s in result.get("sources") or [] if isinstance(s, dict) and SID_RE.fullmatch(str(s.get("sid") or ""))]
        self.result = result = {**result, "sources": sources}
        self.L = labels(result)
        self.T = TEXT.get(result.get("lang"), TEXT["en"])
        self.included = included_sources(result)
        self.refs = reference_sources(result)
        self.ref_ids = {s["sid"] for s in self.refs}
        self.doc = Document()
        self.bm_id = 0
        self.break_next = False
        self.numbering = self.doc.part.numbering_part.element
        self.bullet_abs = self.ordered_abs = self.bullet_num = None

    # --- 문서 설정 ---
    def setup(self):
        doc = self.doc
        sec = doc.sections[0]
        sec.page_width, sec.page_height = Cm(PAGE_W), Cm(PAGE_H)
        sec.orientation = WD_ORIENT.PORTRAIT
        for side in ("left_margin", "right_margin", "top_margin", "bottom_margin"):
            setattr(sec, side, Cm(MARGIN))
        sec.header_distance = sec.footer_distance = Cm(1.1)

        styles = doc.styles
        defaults = styles.element.find(qn("w:docDefaults"))
        if defaults is not None:
            rf = defaults.find(f"{qn('w:rPrDefault')}/{qn('w:rPr')}/{qn('w:rFonts')}")
            if rf is not None:
                _fonts(rf, FONT_KO)
            lang = defaults.find(f"{qn('w:rPrDefault')}/{qn('w:rPr')}/{qn('w:lang')}")
            if lang is not None:
                lang.set(qn("w:eastAsia"), "ko-KR")        # 한글 줄바꿈 · 문장 부호 규칙을 한국어로
        normal = styles["Normal"]
        normal.font.name, normal.font.size = FONT_KO, Pt(10.5)
        normal.font.color.rgb = RGBColor.from_string(INK)
        _fonts(normal.element.get_or_add_rPr().get_or_add_rFonts(), FONT_KO)
        _pfmt(normal, after=6, line=1.35)
        for level, (size, color, before, after) in HEADING.items():
            st = styles[f"Heading {level}"]
            st.font.name, st.font.size, st.font.bold, st.font.italic = FONT_KO, Pt(size), True, False
            st.font.color.rgb = RGBColor.from_string(color)
            for a in ("themeShade", "themeTint"):           # 기본 서식의 테마 색 보정값 제거
                st.element.rPr.color.attrib.pop(qn(f"w:{a}"), None)
            _fonts(st.element.get_or_add_rPr().get_or_add_rFonts(), FONT_KO)
            _pfmt(st, before=before, after=after, line=1.2, keep=True)
            if level == 1:
                _border(st.element.get_or_add_pPr(), color=RULE, sz=6, space=4)

        core = doc.core_properties
        core.title = clean(self.result.get("topic") or self.result.get("prompt") or "")[:250]
        core.author = core.last_modified_by = "AI Research Agent"
        core.subject, core.comments, core.keywords = self.L["title"], "", ""
        core.created = core.modified = datetime.now()

        # 문서를 열 때 Word가 필드(목차) 업데이트를 묻게 한다
        settings = doc.settings.element
        upd = _el("w:updateFields", val="true")
        later = ("w:hdrShapeDefaults", "w:footnotePr", "w:endnotePr", "w:compat", "w:docVars", "w:rsids",
                 "m:mathPr", "w:attachedSchema", "w:themeFontLang", "w:clrSchemeMapping")
        settings.insert_element_before(upd, *later)

        # 머리말: 짧은 주제, 꼬리말: 가운데 쪽 번호
        topic = clean(self.result.get("topic") or "")
        short = topic if len(topic) <= 40 else topic[:39].rstrip() + "…"
        hp = sec.header.paragraphs[0]
        hp._p.append(_run(short, {"size": 8.5, "color": MUTED}))
        _pfmt(hp, after=0, line=1.0)
        _border(hp._p.get_or_add_pPr(), color=RULE, sz=4, space=4)
        fp = sec.footer.paragraphs[0]
        _pfmt(fp, after=0, line=1.0, align=WD_ALIGN_PARAGRAPH.CENTER)
        _field(fp, "PAGE", "1", {"size": 9, "color": MUTED})

    # --- 단락 · 인라인 ---
    def para(self, style=None, **fmt):
        p = self.doc.add_paragraph(style=style)
        if self.break_next:
            p.paragraph_format.page_break_before = True
            self.break_next = False
        return _pfmt(p, **fmt) if fmt else p

    def bookmark(self, p, name: str, inner):
        """inner 요소들을 책갈피 name으로 감싼다."""
        p._p.append(_el("w:bookmarkStart", id=self.bm_id, name=name))
        for e in inner:
            p._p.append(e)
        p._p.append(_el("w:bookmarkEnd", id=self.bm_id))
        self.bm_id += 1

    def link(self, parent, url: str, text: str, fmt: dict):
        """외부 링크(http/https만). 그 외 주소는 그냥 글자로 둔다."""
        url = clean(url).strip()
        if not url.startswith(("http://", "https://")):
            parent.append(_run(text, fmt))
            return
        h = OxmlElement("w:hyperlink")
        h.set(qn("r:id"), self.doc.part.relate_to(url, RT.HYPERLINK, is_external=True))
        h.append(_run(text, {**fmt, "color": ACCENT, "underline": True}))
        parent.append(h)

    def cite_link(self, parent, sid: str, fmt: dict):
        h = _el("w:hyperlink", anchor=f"ref_{sid}", history=1)
        h.append(_run(sid, {**fmt, "color": ACCENT, "underline": False}))
        parent.append(h)

    def text(self, parent, s: str, fmt: dict, cite=True):
        """글자를 run으로 넣는다. <br>은 줄바꿈, 참고문헌에 있는 [S12]는 내부 링크."""
        s = BR_RE.sub("\n", clean(s))
        if not cite:
            parent.append(_run(s, fmt))
            return
        pos = 0
        for m in CITE_RE.finditer(s):
            if m.start() > pos:
                parent.append(_run(s[pos:m.start()], fmt))
            ids = SID_RE.findall(m.group())
            parent.append(_run("[", fmt))
            for k, sid in enumerate(ids):
                if k:
                    parent.append(_run(", ", fmt))
                if sid in self.ref_ids:
                    self.cite_link(parent, sid, fmt)
                else:
                    parent.append(_run(sid, fmt))
            parent.append(_run("]", fmt))
            pos = m.end()
        if pos < len(s):
            parent.append(_run(s[pos:], fmt))

    def inline(self, p, children, base=None):
        """markdown-it 인라인 토큰(굵게 · 기울임 · 코드 · 링크 · 줄바꿈)을 단락 p에 넣는다."""
        base = dict(base or {})
        fmt, target, href, buf = dict(base), p._p, None, []

        def flush():
            if buf:
                self.text(target, "".join(buf), dict(fmt), cite=href is None)
                buf.clear()

        for c in children or []:
            typ = c.type
            if typ in ("text", "text_special", "html_inline"):
                buf.append(c.content)
            elif typ == "softbreak":
                buf.append(" ")
            elif typ == "hardbreak":
                buf.append("\n")
            elif typ == "image":
                buf.append(c.content)
            else:
                flush()
                if typ == "strong_open":
                    fmt["bold"] = True
                elif typ == "strong_close":
                    fmt["bold"] = base.get("bold", False)
                elif typ == "em_open":
                    fmt["italic"] = True
                elif typ == "em_close":
                    fmt["italic"] = base.get("italic", False)
                elif typ == "code_inline":
                    target.append(_run(c.content, {**fmt, "code": True}))
                elif typ == "link_open":
                    url = clean(c.attrGet("href") or "").strip()
                    if url.startswith(("http://", "https://")) and target is p._p:
                        h = OxmlElement("w:hyperlink")
                        h.set(qn("r:id"), self.doc.part.relate_to(url, RT.HYPERLINK, is_external=True))
                        p._p.append(h)
                        target, href = h, url
                        fmt.update(color=ACCENT, underline=True)
                elif typ == "link_close" and href is not None:
                    target, href = p._p, None
                    fmt["color"], fmt["underline"] = base.get("color"), False
        flush()

    def inline_md(self, p, text: str, base=None):
        """짧은 Markdown 글(검증 문장 등)을 인라인으로 해석해 넣는다."""
        tokens = MD.parseInline(clean(text)) if text else []
        self.inline(p, tokens[0].children if tokens else [], base)

    # --- 목록 번호 정의 ---
    def _abstract(self, ordered: bool) -> str:
        ids = [int(e.get(qn("w:abstractNumId"))) for e in self.numbering.findall(qn("w:abstractNum"))]
        aid = max(ids, default=-1) + 1
        lvls = []
        for i in range(3):
            fmt, txt = (("decimal", "lowerLetter", "lowerRoman")[i], f"%{i + 1}.") if ordered else ("bullet", "•◦▪"[i])
            color = INK_2 if ordered else ACCENT
            lvls.append(
                f'<w:lvl w:ilvl="{i}"><w:start w:val="1"/><w:numFmt w:val="{fmt}"/><w:lvlText w:val="{txt}"/>'
                f'<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="{LIST_INDENT * (i + 1)}" w:hanging="{LIST_HANG}"/></w:pPr>'
                f'<w:rPr><w:rFonts w:ascii="{FONT_KO}" w:hAnsi="{FONT_KO}" w:eastAsia="{FONT_KO}" w:cs="{FONT_KO}"/>'
                f'<w:color w:val="{color}"/></w:rPr></w:lvl>')
        el = parse_xml(f'<w:abstractNum {nsdecls("w")} w:abstractNumId="{aid}">'
                       f'<w:multiLevelType w:val="hybridMultilevel"/>{"".join(lvls)}</w:abstractNum>')
        first_num = self.numbering.find(qn("w:num"))
        if first_num is not None:
            first_num.addprevious(el)
        else:
            self.numbering.append(el)
        return str(aid)

    def _num(self, abstract: str, level: int = 0, start: int | None = None) -> str:
        ids = [int(e.get(qn("w:numId"))) for e in self.numbering.findall(qn("w:num"))]
        nid = max(ids, default=0) + 1
        override = (f'<w:lvlOverride w:ilvl="{level}"><w:startOverride w:val="{start}"/></w:lvlOverride>'
                    if start is not None else "")
        self.numbering.append(parse_xml(f'<w:num {nsdecls("w")} w:numId="{nid}"><w:abstractNumId w:val="{abstract}"/>'
                                        f'{override}</w:num>'))
        return str(nid)

    def list_num(self, ordered: bool, level: int, start: int) -> str:
        """글머리표 목록은 번호 정의 하나를 같이 쓰고, 번호 목록은 목록마다 새로 시작한다."""
        if not ordered:
            if self.bullet_num is None:
                self.bullet_abs = self._abstract(False)
                self.bullet_num = self._num(self.bullet_abs)
            return self.bullet_num
        if self.ordered_abs is None:
            self.ordered_abs = self._abstract(True)
        return self._num(self.ordered_abs, level, start)

    # --- 본문 Markdown ---
    def markdown(self, text: str):
        tokens = MD.parse(clean(text))
        lists, quote, i = [], 0, 0          # lists: [{"num", "first"}] 바깥 → 안쪽
        while i < len(tokens):
            t = tokens[i]
            typ = t.type
            if typ == "heading_open":
                level = min(int(t.tag[1:]), 4)
                p = self.para(f"Heading {level}")
                self.inline(p, tokens[i + 1].children)
                i += 3
                continue
            if typ == "paragraph_open":
                p = self.para()
                self._block(p, lists, quote)
                self.inline(p, tokens[i + 1].children, {"color": MUTED} if quote else None)
                i += 3
                continue
            if typ == "table_open":
                j = i
                while j < len(tokens) and tokens[j].type != "table_close":
                    j += 1
                self.md_table(tokens[i:j + 1])
                i = j + 1
                continue
            if typ in ("bullet_list_open", "ordered_list_open"):
                level = min(len(lists), 2)
                start = int(t.attrGet("start") or 1) if typ == "ordered_list_open" else 1
                lists.append({"num": self.list_num(typ == "ordered_list_open", level, start), "first": True})
            elif typ in ("bullet_list_close", "ordered_list_close"):
                lists.pop()
            elif typ == "list_item_open" and lists:
                lists[-1]["first"] = True
            elif typ == "blockquote_open":
                quote += 1
            elif typ == "blockquote_close":
                quote -= 1
            elif typ in ("fence", "code_block"):
                self.code(t.content, lists, quote)
            elif typ == "hr":
                self.rule()
            i += 1

    def _block(self, p, lists, quote):
        """목록 · 인용 안의 단락 서식."""
        if lists:
            level = min(len(lists) - 1, 2)
            top = lists[-1]
            if top["first"]:
                numpr = p._p.get_or_add_pPr().get_or_add_numPr()
                numpr.get_or_add_ilvl().val = level
                numpr.get_or_add_numId().val = int(top["num"])
                top["first"] = False
            else:
                _pfmt(p, left=(LIST_INDENT * (level + 1)) / 567)
            _pfmt(p, after=3)
        elif quote:
            _pfmt(p, left=0.5 * quote, after=4)
            _border(p._p.get_or_add_pPr(), side="left", color=RULE, sz=12, space=8)

    def code(self, content: str, lists=(), quote=0):
        left = (LIST_INDENT * (min(len(lists), 3))) / 567 + 0.5 * quote + 0.15
        p = self.para(before=2, after=8, line=1.0, left=left)
        _shade_par(p._p.get_or_add_pPr())
        p._p.append(_run(content.rstrip("\n"), {"code": True, "size": 9}))

    def rule(self):
        p = self.para(before=4, after=10, line=1.0)
        _border(p._p.get_or_add_pPr(), color=RULE, sz=6, space=1)

    # --- 표 ---
    def table(self, n_rows: int, widths_cm: list[float], header=True, borders="all"):
        """테두리 · 칸 여백 · 머리글 행(음영, 쪽마다 반복)을 갖춘 빈 표."""
        tbl = self.doc.add_table(rows=max(n_rows, 1), cols=len(widths_cm))
        tbl.autofit = False
        tpr = tbl._tbl.tblPr
        bdr = OxmlElement("w:tblBorders")
        sides = ("top", "left", "bottom", "right", "insideH", "insideV") if borders == "all" else ("top", "bottom", "insideH")
        for side in sides:
            bdr.append(_el(f"w:{side}", val="single", sz=4, space=0, color=RULE))
        tpr.insert_element_before(bdr, "w:shd", "w:tblLayout", "w:tblCellMar", "w:tblLook")
        mar = OxmlElement("w:tblCellMar")
        for side, w in (("top", 45), ("left", 90), ("bottom", 45), ("right", 90)):
            mar.append(_el(f"w:{side}", w=w, type="dxa"))
        tpr.insert_element_before(mar, "w:tblLook")
        for col, w in zip(tbl.columns, widths_cm):
            col.width = Cm(w)
        for r, row in enumerate(tbl.rows):
            for cell, w in zip(row.cells, widths_cm):
                cell.width = Cm(w)
                _pfmt(cell.paragraphs[0], before=0, after=1, line=1.15)
                if header and r == 0:
                    cell._tc.get_or_add_tcPr().insert_element_before(
                        _el("w:shd", val="clear", color="auto", fill=SURFACE_ALT),
                        "w:noWrap", "w:tcMar", "w:textDirection", "w:tcFitText", "w:vAlign", "w:hideMark")
            if header and r == 0:
                row._tr.get_or_add_trPr().append(_el("w:tblHeader"))
        return tbl

    def after_table(self):
        """표 바로 뒤의 간격 단락(표 두 개가 붙어 하나로 합쳐지는 것도 막는다)."""
        self.para(before=0, after=4, line=1.0)

    def md_table(self, tokens):
        rows, cur = [], None
        for t in tokens:
            if t.type == "tr_open":
                cur = []
                rows.append(cur)
            elif t.type == "inline" and cur is not None:
                cur.append(t)
        if not rows:
            return
        ncol = max(len(r) for r in rows) or 1
        # 열 폭: 칸 글자 수 평균에 비례하되 너무 좁거나 넓지 않게
        weights = []
        for c in range(ncol):
            lens = [len(r[c].content) for r in rows if c < len(r)]
            weights.append(min(max(sum(lens) / max(len(lens), 1), 6), 70))
        total = sum(weights)
        widths = [max(TEXT_W * w / total, 1.6) for w in weights]
        scale = TEXT_W / sum(widths)
        tbl = self.table(len(rows), [w * scale for w in widths])
        for r, (row_tokens, row) in enumerate(zip(rows, tbl.rows)):
            for c, cell in enumerate(row.cells):
                if c < len(row_tokens):
                    fmt = {"size": 9, "bold": r == 0}
                    self.inline(cell.paragraphs[0], row_tokens[c].children, fmt)
        self.after_table()

    def cell_text(self, cell, parts):
        """parts: [(글, fmt)] — '\\n'은 줄바꿈."""
        p = cell.paragraphs[0]
        for text, fmt in parts:
            if text:
                self.text(p._p, text, fmt, cite=False)
        return p

    # --- 표지 · 목차 ---
    def cover(self):
        L, T, m = self.L, self.T, meta_info(self.result)
        self.para(before=0, after=4)._p.append(_run(L["title"], {"bold": True, "size": 10, "color": ACCENT}))
        topic = self.result.get("topic") or self.result.get("prompt") or L["title"]
        self.para(after=14, line=1.2)._p.append(_run(topic, {"bold": True, "size": 24, "color": INK}))

        ko = self.result.get("lang") == "ko"
        pairs = [(L["gen"], m["date"]), (L["model"], m["model"]), (L["window"], m["window"]),
                 (L["stats"], T["count_fmt"].format(a=_num(m["collected"]), b=_num(m["included"]))
                  + f" ({L['merged']} {_num(m['merged'])} · {L['sent']} {_num(m['report_evidence'])})"),
                 (T["duration"], f"{_num(m['minutes'])}{'' if ko else ' '}{L['minutes']}"),
                 (L["calls"], T["calls_fmt"].format(n=_num(m["calls"]))),
                 (L["tokens"], T["tokens_fmt"].format(i=_num(m["input_tokens"]), o=_num(m["output_tokens"])))]
        if isinstance(m["cost_usd"], (int, float)):
            pairs.append((L["cost"], f"${m['cost_usd']:.2f}"))
        if len(pairs) % 2:
            pairs.append(("", ""))
        tbl = self.table(len(pairs) // 2, [2.6, 5.7, 2.6, 5.7], header=False, borders="rows")
        for k, (label, value) in enumerate(pairs):
            cells = tbl.rows[k // 2].cells
            self.cell_text(cells[(k % 2) * 2], [(label, {"size": 8.5, "color": MUTED, "bold": True})])
            self.cell_text(cells[(k % 2) * 2 + 1], [(value, {"size": 9})])
        if m["note"]:
            self.para(before=6, after=0, line=1.25)._p.append(_run(m["note"], {"size": 8.5, "italic": True, "color": MUTED}))
        self.rule()

        self.para(before=6, after=4, keep=True)._p.append(_run(L["contents"], {"bold": True, "size": 13, "color": ACCENT_DARK}))
        p = self.para(after=4)
        _field(p, 'TOC \\o "1-3" \\h \\z \\u', T["toc_wait"], {"color": MUTED})
        self.para(after=0, line=1.2)._p.append(_run(T["toc_hint"], {"size": 8.5, "color": MUTED}))

    # --- 부록 ---
    def appendix_a(self):
        L = self.L
        sec = self.doc.add_section(WD_SECTION.NEW_PAGE)
        sec.orientation = WD_ORIENT.LANDSCAPE
        sec.page_width, sec.page_height = Cm(PAGE_H), Cm(PAGE_W)
        self.para("Heading 1").add_run(L["tableA"])
        if not self.included:
            self.para()._p.append(_run(self.T["no_sources"], {"color": MUTED}))
        else:
            tbl = self.table(len(self.included) + 1, [1.5, 6.2, 5.6, 9.6, 2.4])
            muted = {"size": 8.5, "color": MUTED}
            for cell, col in zip(tbl.rows[0].cells, L["cols"]):
                self.cell_text(cell, [(col, {"size": 8.5, "bold": True})])
            for s, row in zip(self.included, tbl.rows[1:]):
                c = row.cells
                p = c[0].paragraphs[0]
                if s["sid"] in self.ref_ids:
                    self.cite_link(p._p, s["sid"], {"size": 8.5, "bold": True})
                else:
                    p._p.append(_run(s["sid"], {"size": 8.5, "bold": True}))
                kind = KIND_LABEL.get(s.get("kind") or "", s.get("kind") or "")
                kind_line = " · ".join(x for x in (kind, s.get("study_type") or "") if x)
                self.cell_text(c[1], [(short_cite(s), {"size": 8.5, "bold": True}),
                                      ("\n" + (s.get("title") or ""), {"size": 8.5, "italic": True}),
                                      ("\n" + kind_line if kind_line else "", muted)])
                self.cell_text(c[2], [(s.get("method") or "", {"size": 8.5}),
                                      ("\n" + s["sample"] if s.get("sample") else "", muted)])
                self.cell_text(c[3], [(s.get("key_finding") or "", {"size": 8.5})])
                d = s.get("direction") or ""
                score = s.get("score")
                self.cell_text(c[4], [(DIRECTION_LABEL.get(d, d), {"size": 8.5}),
                                      (f"\n{score:.2f}" if isinstance(score, (int, float)) else "", muted)])
        new = self.doc.add_section(WD_SECTION.NEW_PAGE)        # 다시 세로 페이지
        new.orientation = WD_ORIENT.PORTRAIT
        new.page_width, new.page_height = Cm(PAGE_W), Cm(PAGE_H)

    def appendix_b(self):
        L, T = self.L, self.T
        self.para("Heading 1").add_run(L["refB"])
        if not self.refs:
            self.para()._p.append(_run(T["no_sources"], {"color": MUTED}))
        seen = set()
        for s in self.refs:
            sid = s["sid"]
            p = self.para(after=5, line=1.25, left=1.3, first=-1.3)
            run = _run(sid, {"bold": True, "size": 9.5, "color": ACCENT_DARK})
            if sid in seen:
                p._p.append(run)
            else:
                self.bookmark(p, f"ref_{sid}", [run])
                seen.add(sid)
            f = {"size": 9.5}
            head = " ".join(x for x in (authors_text(s) or s.get("venue") or "", f"({s.get('year') or 'n.d.'})") if x)
            p._p.append(_run(f"\t{head}. ", f))
            p._p.append(_run(s.get("title") or "", {**f, "italic": True}))
            p._p.append(_run(". ", f))
            if s.get("venue"):
                p._p.append(_run(f"{s['venue']}. ", f))
            url = clean(s.get("url") or s.get("doi") or "").strip()
            if url.startswith(("http://", "https://")):
                self.link(p._p, url, url, {"size": 9})
            tail = [KIND_LABEL.get(s.get("kind") or "", s.get("kind") or "")]
            if isinstance(s.get("citations"), int):
                tail.append(T["cites"].format(n=f"{s['citations']:,}"))
            tail.append(s.get("origin") or "")
            p._p.append(_run("\n" + " · ".join(x for x in tail if x), {"size": 8.5, "color": MUTED}))

    def verdict_tag(self, p, verdict: str, size=9):
        label = VERDICT_LABEL.get(verdict, verdict or "?")
        p._p.append(_run(f"[{label}]", {"bold": True, "size": size, "color": VERDICT_COLOR.get(verdict, MUTED)}))

    def appendix_c(self):
        L, T = self.L, self.T
        ver = self.result.get("verification") or {}
        checks = [c for c in ver.get("checks") or [] if isinstance(c, dict)]
        self.break_next = True
        self.para("Heading 1").add_run(L["verC"])
        line = (f"{L['cited']} {_num(ver.get('cited_ids', 0))} · {L['claims']} {_num(ver.get('claims_total', 0))}"
                f" · {L['checked']} {len(checks)}")
        self.para(after=4)._p.append(_run(line, {"size": 9.5, "color": INK_2}))
        unknown = [clean(u) for u in ver.get("unknown_ids") or []]
        if unknown:
            self.para(after=4)._p.append(_run(f"{T['unknown']}: {', '.join(unknown)}", {"size": 9.5, "color": VERDICT_COLOR["contradicted"]}))
        if not checks:
            self.para()._p.append(_run(T["no_checks"], {"color": MUTED}))
            return
        before, after = verdict_tally(checks), verdict_tally(checks, after=True)
        tbl = self.table(len(VERDICTS) + 1, [4.0, 2.4, 2.4])
        for cell, h in zip(tbl.rows[0].cells, (T["verdict"], L["before"], L["after"])):
            self.cell_text(cell, [(h, {"size": 9, "bold": True})])
        for v, row in zip(VERDICTS, tbl.rows[1:]):
            c = row.cells
            self.cell_text(c[0], [(VERDICT_LABEL.get(v, v), {"size": 9, "bold": True, "color": VERDICT_COLOR.get(v, MUTED)})])
            for cell, n in ((c[1], before[v]), (c[2], after[v])):
                self.cell_text(cell, [(str(n), {"size": 9})]).alignment = WD_ALIGN_PARAGRAPH.RIGHT
        self.after_table()
        for k, c in enumerate(checks, 1):
            p = self.para(before=6, after=2, line=1.3, left=0.7, first=-0.7, keep=True)
            p._p.append(_run(f"{k}.\t", {"bold": True, "size": 9.5}))
            self.verdict_tag(p, c.get("verdict") or "")
            p._p.append(_run(" ", {}))
            self.inline_md(p, c.get("claim") or "", {"size": 9.5})
            if c.get("note"):
                self.para(after=2, line=1.25, left=0.7)._p.append(_run(c["note"], {"size": 8.5, "color": MUTED}))
            if c.get("revised"):
                p = self.para(after=2, line=1.3, left=0.7)
                p._p.append(_run(f"{L['after']}: ", {"bold": True, "size": 9.5, "color": ACCENT_DARK}))
                self.inline_md(p, c["revised"], {"size": 9.5})
                p._p.append(_run(" ", {}))
                self.verdict_tag(p, c.get("verdict_after") or "not checked")
                if c.get("note_after"):
                    self.para(after=2, line=1.25, left=0.7)._p.append(_run(c["note_after"], {"size": 8.5, "color": MUTED}))

    def appendix_d(self):
        T = self.T
        trace = [t for t in self.result.get("trace") or [] if isinstance(t, dict)]
        self.break_next = True
        self.para("Heading 1").add_run(self.L["traceD"])
        if not trace:
            self.para()._p.append(_run(T["no_trace"], {"color": MUTED}))
            return
        ko = self.result.get("lang") == "ko"
        tbl = self.table(len(trace) + 1, [1.8, 2.3, TEXT_W - 4.1])
        for cell, h in zip(tbl.rows[0].cells, T["trace_cols"]):
            self.cell_text(cell, [(h, {"size": 8.5, "bold": True})])
        for t, row in zip(trace, tbl.rows[1:]):
            c = row.cells
            ts = str(t.get("ts") or "")
            stage = str(t.get("stage") or "")
            self.cell_text(c[0], [(ts[11:19] if len(ts) >= 19 else ts, {"size": 8.5, "color": MUTED})])
            self.cell_text(c[1], [(STAGE_KO.get(stage, stage) if ko else stage, {"size": 8.5})])
            self.cell_text(c[2], [(t.get("msg") or "", {"size": 8.5})])


def build_docx(result: dict, path) -> Path:
    """result(SPEC 3.2)로 Word 보고서를 만들어 path에 저장하고 경로를 돌려준다."""
    result = result or {}
    w = _Writer(result)
    w.setup()
    w.cover()
    w.break_next = True                   # 본문은 새 쪽에서 시작
    body = result.get("report_markdown") or ""
    if body.strip():
        w.markdown(body)
    else:
        w.para()._p.append(_run(w.T["empty_body"], {"color": MUTED}))
    w.appendix_a()
    w.appendix_b()
    w.appendix_c()
    w.appendix_d()
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    w.doc.save(str(path))
    return path
