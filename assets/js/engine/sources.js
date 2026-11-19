// 수집 문헌(Source)과 저장소(EvidenceStore). 노트북 셀 ④의 같은 이름 코드를 옮겼다. (원본: agent/sources.py)
//
// 변경점: toDict()/fromDict(), 체크포인트용 EvidenceStore.toState()/fromState().
// 브라우저는 스레드가 없으므로 잠금은 필요 없다(add()는 await 없이 한 번에 끝난다).

const DEFAULTS = {
  title: '', authors: [], year: null, venue: '', abstract: '', url: '', doi: '', citations: null,
  origin: '',          // 어느 도구에서 왔는지
  kind: 'academic',    // peer-reviewed | academic | preprint | web
  sid: '', queries: null, subqs: null, evaluated: false,
  relevance: 0,        // 0~3 (LLM)
  credibility: 0.0,    // 0~1 (규칙)
  score: 0.0,          // 종합 점수
  study_type: '', method: '', sample: '', key_finding: '', direction: '', limitation: '',
};
// toDict()의 키 순서: sid를 맨 앞에, 나머지는 원본 dataclass 순서
const FIELD_ORDER = ['title', 'authors', 'year', 'venue', 'abstract', 'url', 'doi', 'citations', 'origin', 'kind',
  'queries', 'subqs', 'evaluated', 'relevance', 'credibility', 'score', 'study_type', 'method', 'sample',
  'key_finding', 'direction', 'limitation'];

/** Python의 str.strip(chars)처럼 양 끝의 지정 문자를 지운다. */
function stripChars(s, chars) {
  let a = 0, b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}

export class Source {
  /** @param {Partial<Source>} fields  원본 dataclass와 같은 필드(snake_case) */
  constructor(fields = {}) {
    for (const [k, v] of Object.entries(DEFAULTS)) {
      this[k] = fields[k] !== undefined ? fields[k] : (Array.isArray(v) ? [] : v);
    }
    this.authors = Array.isArray(this.authors) ? [...this.authors] : [];
    this.queries = new Set(fields.queries || []);
    this.subqs = new Set(fields.subqs || []);
  }

  /** "Smith et al. (2024)" 형식의 짧은 인용 */
  shortCite() {
    const names = this.authors.filter((n) => n && String(n).trim());
    const parts = names.length ? String(names[0]).replace(/,/g, ' ').split(/\s+/).filter(Boolean) : [];
    // "John Smith" → Smith, "Kim J"(Europe PMC 형식) → Kim
    let a;
    if (parts.length) {
      const lastPart = parts[parts.length - 1];
      a = (stripChars(lastPart, '.').length > 2 || parts.length === 1) ? lastPart : parts[0];
    } else {
      a = this.venue || 'n.a.';
    }
    const etal = names.length > 1 ? ' et al.' : '';
    return `${a}${etal} (${this.year || 'n.d.'})`;
  }

  /** JSON으로 저장할 객체. sid를 맨 앞에 두고, Set은 정렬된 배열로 바꾼다. */
  toDict() {
    const d = { sid: this.sid };
    for (const k of FIELD_ORDER) d[k] = this[k];
    d.authors = [...(this.authors || [])];
    d.queries = [...this.queries].sort();
    d.subqs = [...this.subqs].sort((x, y) => x.length - y.length || (x < y ? -1 : x > y ? 1 : 0));   // Q2가 Q10보다 앞
    return d;
  }

  /** toDict()의 역변환. 모르는 키(included, cited 등)는 무시한다. */
  static fromDict(d) {
    const kw = {};
    for (const k of Object.keys(DEFAULTS)) {
      if (d && d[k] !== undefined) kw[k] = d[k];
    }
    for (const k of ['title', 'venue', 'abstract', 'url']) if (kw[k] === null || kw[k] === undefined) kw[k] = '';
    return new Source(kw);
  }
}

/** shortCite를 함수로도 쓸 수 있게 (Source 또는 같은 모양의 객체) */
export function shortCite(src) {
  return Source.prototype.shortCite.call({ authors: [], venue: '', year: null, ...src, authors: src?.authors || [] });
}

export const KIND_RANK = { web: 0, preprint: 1, academic: 2, 'peer-reviewed': 3 };
const SITE_SUFFIX = /\s+[-|–—]\s+[^-|–—]{2,40}$/u;   // 웹 제목 끝의 "- SSRN", "| ScienceDirect" 등
const ELLIPSIS = /\s*(\.\.\.|…)\s*$/u;

/** 제목 정규화 → [키, 잘림 여부]. 합자(ﬀ)·사이트명 꼬리·말줄임표 차이로 같은 문헌이 따로 저장되는 것을 막음. */
export function normTitle(t, web = false) {
  t = String(t || '').normalize('NFKC').trim();
  if (web) t = t.replace(SITE_SUFFIX, '');
  const truncated = ELLIPSIS.test(t);
  return [t.replace(ELLIPSIS, '').toLowerCase().replace(/[^a-z0-9가-힣]/g, '').slice(0, 120), truncated];
}

function sidNum(sid) {
  return /^\d+$/.test(String(sid).slice(1)) ? parseInt(String(sid).slice(1), 10) : 0;
}

/** 수집 문헌 저장소: DOI/제목 기준 중복(같은 문헌의 여러 판본) 병합, S1, S2 ... ID 부여. */
export class EvidenceStore {
  constructor() {
    /** @type {Map<string, Source>} */
    this.items = new Map();
    this._dois = new Map();
    this._titles = new Map();   // 제목 키 → [sid, 잘린 제목 여부]
    this.merged = 0;            // 기존 문헌과 같은 것으로 판정되어 병합된 검색 결과 수
  }

  _match(doi, tkey, truncated) {
    if (doi && this._dois.has(doi)) return this._dois.get(doi);
    if (this._titles.has(tkey)) return this._titles.get(tkey)[0];
    if (tkey.length >= 35) {   // "제목 앞부분 ..." 처럼 잘린 웹 제목은 앞부분이 같으면 같은 문헌
      for (const [k, [sid, trunc]] of this._titles) {
        if ((truncated && k.startsWith(tkey)) || (trunc && tkey.startsWith(k))) return sid;
      }
    }
    return null;
  }

  /** 문헌 1건 추가(또는 기존 문헌에 병합) → 저장된 Source, 제목이 없으면 null */
  add(src, query = '', subq = '') {
    if (!src.title) return null;
    src.authors = (src.authors || []).filter((a) => a && String(a).trim()).map((a) => String(a).trim());
    const doi = String(src.doi || '').toLowerCase().replace('https://doi.org/', '');
    const [tkey, truncated] = normTitle(src.title, src.kind === 'web');
    const existing = this._match(doi, tkey, truncated);
    let s;
    if (existing) {
      s = this.items.get(existing);
      this.merged += 1;
      if (!s.evaluated && (KIND_RANK[src.kind] || 0) > (KIND_RANK[s.kind] || 0)) {
        // 웹 사본보다 학술 판본의 서지 정보를 우선 사용
        Object.assign(s, { title: src.title, venue: src.venue, url: src.url, kind: src.kind, origin: src.origin });
        s.authors = src.authors.length ? src.authors : s.authors;
        s.year = src.year || s.year;
      }
      if ((src.abstract || '').length > (s.abstract || '').length) s.abstract = src.abstract;
      s.citations = Math.max(s.citations || 0, src.citations || 0) || s.citations;
      s.doi = s.doi || src.doi;
    } else {
      src.sid = `S${this.items.size + 1}`;
      this.items.set(src.sid, src);
      s = src;
    }
    if (doi && !this._dois.has(doi)) this._dois.set(doi, s.sid);
    if (tkey && !this._titles.has(tkey)) this._titles.set(tkey, [s.sid, truncated]);
    if (query) s.queries.add(query);
    if (subq) s.subqs.add(subq);
    return s;
  }

  get size() {
    return this.items.size;
  }

  /** 수집 문헌 전부를 S 번호순으로 */
  sources() {
    return [...this.items.values()].sort((a, b) => sidNum(a.sid) - sidNum(b.sid));
  }

  /** 채택 문헌(평가됨, 관련성 ≥ 2)을 점수 높은 순으로 */
  included() {
    return this.sources().filter((s) => s.evaluated && s.relevance >= 2).sort((a, b) => b.score - a.score);
  }

  /** 체크포인트용: 병합 판정에 쓰는 DOI·제목 색인까지 JSON으로 */
  toState() {
    return {
      sources: this.sources().map((s) => s.toDict()),
      merged: this.merged,
      keys: { dois: Object.fromEntries(this._dois), titles: Object.fromEntries(this._titles) },
    };
  }

  /** toState()의 역변환. keys가 없으면(결과 파일에서 복원할 때) 각 문헌의 DOI·제목으로 색인을 다시 만든다. */
  static fromState(sources = [], merged = 0, keys = null) {
    const store = new EvidenceStore();
    for (const d of sources || []) {
      const s = Source.fromDict(d);
      if (!s.sid) continue;
      store.items.set(s.sid, s);
      if (!keys) {
        const doi = String(s.doi || '').toLowerCase().replace('https://doi.org/', '');
        const [tkey, truncated] = normTitle(s.title, s.kind === 'web');
        if (doi && !store._dois.has(doi)) store._dois.set(doi, s.sid);
        if (tkey && !store._titles.has(tkey)) store._titles.set(tkey, [s.sid, truncated]);
      }
    }
    if (keys) {
      for (const [k, v] of Object.entries(keys.dois || {})) store._dois.set(k, v);
      for (const [k, v] of Object.entries(keys.titles || {})) store._titles.set(k, [v[0], Boolean(v[1])]);
    }
    store.merged = Number(merged) || 0;
    return store;
  }
}
