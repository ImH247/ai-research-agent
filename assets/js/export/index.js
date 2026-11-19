// 결과물 내보내기: 형식 목록(FORMATS)과 exportFile() 진입점.
// 모든 형식은 result 객체(PYTHON_SPEC 3.2)만 입력으로 받는다. Word·PPT 모듈은 무거우므로(그리고 다른 담당자가 만든다)
// exportFile() 안에서 필요할 때 늦게 불러온다.
import { buildMarkdown } from './markdown.js';
import { buildHtml } from './html.js';
import { buildBibtex, buildCsv, buildRis } from './refs.js';
import { fallbackOutline } from './slides.js';

export const FORMATS = [
  { id: 'md', label: 'Markdown 보고서', ext: '.md', mime: 'text/markdown; charset=utf-8',
    description: '노트북과 같은 구성의 Markdown 보고서(부록 A~D 포함)', group: 'report' },
  { id: 'html', label: 'HTML 보고서(인쇄용)', ext: '.html', mime: 'text/html; charset=utf-8',
    description: '브라우저에서 바로 열고 인쇄할 수 있는 단독 HTML 문서', group: 'report' },
  { id: 'pdf', label: 'PDF 보고서', ext: '.pdf', mime: 'application/pdf',
    description: "인쇄 창에서 'PDF로 저장'", group: 'report' },
  { id: 'docx', label: 'Word 문서', ext: '.docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    description: '편집할 수 있는 Word 보고서', group: 'report' },
  { id: 'pptx', label: '발표 슬라이드', ext: '.pptx',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    description: '보고서를 요약한 발표용 PowerPoint', group: 'slides' },
  { id: 'bib', label: '참고문헌 BibTeX', ext: '.bib', mime: 'application/x-bibtex; charset=utf-8',
    description: '채택 문헌의 BibTeX 항목', group: 'refs' },
  { id: 'ris', label: '참고문헌 RIS', ext: '.ris', mime: 'application/x-research-info-systems; charset=utf-8',
    description: 'EndNote·Zotero·Mendeley용 RIS', group: 'refs' },
  { id: 'csv', label: '근거표 CSV', ext: '.csv', mime: 'text/csv; charset=utf-8',
    description: '수집 문헌 전부의 평가 결과 표(Excel에서 열림)', group: 'data' },
  { id: 'json', label: '전체 데이터 JSON', ext: '.json', mime: 'application/json; charset=utf-8',
    description: '실행 결과 전체(result.json)', group: 'data' },
];
export const FORMAT_IDS = FORMATS.map((f) => f.id);
const BY_ID = Object.fromEntries(FORMATS.map((f) => [f.id, f]));
// 파일 이름 꼬리: 보고서류는 _report, 나머지는 내용에 맞게
const SUFFIX = { pptx: 'slides', bib: 'references', ris: 'references', csv: 'evidence', json: 'result' };

// 내보내기 실패 (사용자에게 보여 줄 수 있는 한국어 메시지)
export class ExportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExportError';
  }
}

// 파일 이름용: 한글·영숫자는 남기고 나머지(공백, Windows 금지 문자 등)는 _로. 비면 'research'
export function slugify(topic, maxLen = 40) {
  const slug = String(topic || '').replace(/[^0-9A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ]+/g, '_').replace(/^_+|_+$/g, '');
  return slug.slice(0, maxLen).replace(/_+$/, '') || 'research';
}

// 예: '생성형_AI_활용이_대학원생의_연구_생산성과_report.docx', pptx는 '_slides', bib/ris는 '_references'
export function filenameFor(result, fmt) {
  if (!Object.hasOwn(BY_ID, fmt)) throw new ExportError(`알 수 없는 형식입니다: ${fmt}`);
  const slug = slugify(result?.topic || result?.prompt || '');
  return `${slug}_${SUFFIX[fmt] || 'report'}${BY_ID[fmt].ext}`;
}

export function bundleName(result) {
  return `${slugify(result?.topic || result?.prompt || '')}_bundle.zip`;
}

// 결과물 하나를 만든다 → { filename, mime, data } (data: 문자열 또는 Uint8Array).
// pdf는 인쇄용 HTML을 돌려주고 print: true — 화면이 새 창에 열어 인쇄 창('PDF로 저장')을 띄운다.
export async function exportFile(result, fmt, { outline = null } = {}) {
  const filename = filenameFor(result, fmt);      // 알 수 없는 형식 검사도 겸한다
  const mime = BY_ID[fmt].mime;
  result = result || {};
  switch (fmt) {
    case 'md':
      return { filename, mime, data: buildMarkdown(result) };
    case 'html':
      return { filename, mime, data: buildHtml(result) };
    case 'pdf':
      return { filename, mime: 'text/html', data: buildHtml(result, { autoPrint: false }), print: true };
    case 'docx': {
      const { buildDocx } = await import('./docx.js');
      return { filename, mime, data: await buildDocx(result) };
    }
    case 'pptx': {
      const { buildPptx } = await import('./pptx.js');
      return { filename, mime, data: await buildPptx(result, outline || fallbackOutline(result)) };
    }
    case 'bib':
      return { filename, mime, data: buildBibtex(result) };
    case 'ris':
      return { filename, mime, data: buildRis(result) };
    case 'csv':
      return { filename, mime, data: buildCsv(result) };   // UTF-8 BOM 포함 (Excel 한글)
    case 'json':
      return { filename, mime, data: JSON.stringify(result, null, 2) };
    default:
      throw new ExportError(`알 수 없는 형식입니다: ${fmt}`);
  }
}

// 여러 결과물 + result.json을 zip 하나로 묶는다 → Uint8Array.
// files: exportFile()이 돌려준 객체 배열([{filename, data, print?}]) 또는 { 파일이름: data } 객체.
// 인쇄용(pdf) 항목은 실제로는 HTML이므로 .html 이름으로 넣는다(같은 이름의 HTML 보고서가 있으면 넣지 않는다).
// result.json이 없으면 덧붙인다.
export async function exportBundle(result, files = []) {
  const { default: JSZip } = await import('../../../vendor/jszip.js');
  const zip = new JSZip();
  const entries = Array.isArray(files) ? files
    : Object.entries(files || {}).map(([filename, data]) => ({ filename, data }));
  const names = new Set();
  for (const f of entries) {
    if (!f || !f.filename || f.data === null || f.data === undefined) continue;
    let name = String(f.filename).replace(/[\\/]+/g, '_');
    if (f.print) name = name.replace(/\.pdf$/i, '.html');
    if (names.has(name)) continue;
    names.add(name);
    let data = f.data;
    if (data instanceof ArrayBuffer) data = new Uint8Array(data);
    zip.file(name, data);
  }
  if (!names.has('result.json')) zip.file('result.json', JSON.stringify(result || {}, null, 2));
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
