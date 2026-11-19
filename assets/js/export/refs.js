// 참고문헌(BibTeX · RIS)과 근거표(CSV). BibTeX·RIS는 채택 문헌만 S 번호순, CSV는 수집 문헌 전부.
import { arr, authorList, lastName, referenceSources, sidNum } from './common.js';

const STOP = new Set(['a', 'an', 'the', 'of', 'on', 'in', 'for', 'and', 'to', 'with', 'from', 'by', 'at', 'as', 'is', 'are',
  'its', 'via', 'into', 'toward', 'towards', 'do', 'does', 'how', 'what', 'why', 'can']);
const BIB_SPECIAL = {
  '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '&': '\\&', '%': '\\%', '$': '\\$', '#': '\\#',
  '_': '\\_', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}',
};
const ARXIV_RE = /(?:arxiv\.org\/abs\/|10\.48550\/arxiv\.)([^\s?#]+?)(?:v\d+)?$/i;   // abs 링크 또는 arXiv DOI
export const CSV_COLUMNS = ['sid', 'included', 'cited', 'score', 'relevance', 'credibility', 'kind', 'study_type', 'direction',
  'year', 'authors', 'title', 'venue', 'citations', 'doi', 'url', 'origin', 'subqs', 'sample', 'method',
  'key_finding', 'limitation', 'abstract'];

// 악센트를 떼고 영문자·숫자만 남긴다 (한글 등은 사라짐)
function asciiOnly(text) {
  return String(text || '').normalize('NFKD').replace(/[^A-Za-z0-9]/g, '');
}

function titleWord(title) {
  for (const w of String(title || '').normalize('NFKD').match(/[\p{L}\p{N}]+/gu) || []) {
    const a = asciiOnly(w).toLowerCase();
    if (a.length > 2 && !STOP.has(a)) return a;
  }
  return '';
}

// BibTeX 특수 문자 이스케이프 + 줄바꿈 정리
function bib(value) {
  const text = strOf(value).replace(/\s+/g, ' ').trim();
  return Array.from(text, (ch) => BIB_SPECIAL[ch] ?? ch).join('');
}

function plainDoi(doi) {
  return String(doi || '').trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
}

function urlValue(url) {
  return String(url || '').replace(/[\s{}\\]/g, '');
}

const strOf = (v) => (v === null || v === undefined || v === false || v === 0 || v === '' ? '' : String(v));

export function buildBibtex(result) {
  const entries = [];
  const used = new Set();
  for (const s of referenceSources(result)) {
    const sid = s.sid; const kind = s.kind || '';
    let key = (asciiOnly(lastName(s)).toLowerCase() || 'anon') + String(s.year || 'nd') + titleWord(s.title);
    if (used.has(key)) key += sid;
    used.add(key);
    const url = urlValue(s.url); const doi = urlValue(plainDoi(s.doi));
    const fields = [['title', '{' + bib(s.title) + '}'],
      ['author', authorList(s).map(bib).join(' and ')],
      ['year', strOf(s.year)]];
    const note = [sid, ...(s.study_type ? [bib(s.study_type)] : [])];
    let etype;
    if (kind === 'peer-reviewed') {
      etype = 'article';
      fields.push(['journal', bib(s.venue)]);
    } else {
      etype = 'misc';
      if (kind === 'preprint') {
        note.unshift('Preprint');
        const m = ARXIV_RE.exec(url) || ARXIV_RE.exec(doi);
        if (m) fields.push(['eprint', m[1]], ['archivePrefix', 'arXiv']);
      } else if (s.venue || kind === 'web') {
        const site = s.venue || url.replace(/^https?:\/\/(www\.)?([^/]+).*$/, '$2');
        fields.push(['howpublished', bib(site)]);
      }
    }
    fields.push(['doi', doi], ['url', url], ['note', note.join('; ')]);
    const body = fields.filter(([, v]) => v && v !== '{}').map(([k, v]) => `  ${k} = {${v}}`).join(',\n');
    entries.push(`@${etype}{${key},\n${body}\n}`);
  }
  return entries.join('\n\n') + (entries.length ? '\n' : '');
}

function risValue(value) {
  return strOf(value).replace(/\s+/g, ' ').trim();
}

export function buildRis(result) {
  const types = { 'peer-reviewed': 'JOUR', 'academic': 'JOUR', 'preprint': 'UNPB', 'web': 'ELEC' };
  const lines = [];
  for (const s of referenceSources(result)) {
    lines.push(`TY  - ${types[s.kind] || 'GEN'}`);
    for (const a of authorList(s)) lines.push(`AU  - ${risValue(a)}`);
    let abstract = risValue(s.abstract);
    if (abstract.length > 1500) abstract = abstract.slice(0, 1500).trimEnd() + '…';
    const tags = [['TI', s.title], ['PY', s.year], ['JO', s.venue], ['DO', plainDoi(s.doi)], ['UR', s.url], ['AB', abstract],
      ['N1', [s.sid, s.study_type].filter((x) => x).join('; ')]];
    for (const [tag, val] of tags) {
      if (risValue(val)) lines.push(`${tag}  - ${risValue(val)}`);
    }
    lines.push('ER  - ', '');
  }
  return lines.join('\n');
}

// CSV 한 칸 (파이썬 csv 모듈 excel 방언과 같은 QUOTE_MINIMAL)
function csvField(v) {
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
}

// 수집 문헌 전부를 S 번호순으로. Excel에서 한글이 깨지지 않게 UTF-8 BOM을 앞에 붙인 문자열을 돌려준다
export function buildCsv(result) {
  const rows = [CSV_COLUMNS.map(csvField).join(',')];
  const sources = [...arr(result?.sources)].filter((s) => s && typeof s === 'object')
    .sort((a, b) => sidNum(a.sid) - sidNum(b.sid));
  for (const s of sources) {
    const row = CSV_COLUMNS.map((col) => {
      let v = s[col];
      if (col === 'included' || col === 'cited') v = v ? 'TRUE' : 'FALSE';
      else if (col === 'authors') v = authorList(s).join('; ');
      else if (col === 'subqs') v = arr(v).map((x) => String(x)).join('; ');
      else if (v === true) v = 'True';
      else if (v === false) v = 'False';
      else if (v !== null && typeof v === 'object') v = JSON.stringify(v);
      return csvField(v === null || v === undefined ? '' : v);
    });
    rows.push(row.join(','));
  }
  return '﻿' + rows.map((r) => r + '\r\n').join('');
}

// 간단한 CSV 파서 (테스트·가져오기 확인용). BOM은 떼고 [행][칸] 배열을 돌려준다
export function parseCsv(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const rows = []; let row = []; let field = ''; let i = 0; let quoted = false;
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (ch === '"') { quoted = false; i += 1; continue; }
      field += ch; i += 1; continue;
    }
    if (ch === '"') { quoted = true; i += 1; continue; }
    if (ch === ',') { row.push(field); field = ''; i += 1; continue; }
    if (ch === '\r' && src[i + 1] === '\n') { i += 1; continue; }
    if (ch === '\n' || ch === '\r') { row.push(field); rows.push(row); row = []; field = ''; i += 1; continue; }
    field += ch; i += 1;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}
