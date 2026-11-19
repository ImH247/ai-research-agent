// TF-IDF 코사인 유사도 — scikit-learn TfidfVectorizer(stop_words="english", ngram_range=(1, 2), sublinear_tf=True)
// + cosine_similarity와 같은 계산을 브라우저에서 한다. (원본은 sklearn을 import해서 썼다)
//
// 1) 소문자화  2) 토큰: 정규식 (?u)\b\w\w+\b (유니코드 글자·숫자·밑줄 2자 이상)  3) 영어 불용어 제거
// 4) 1-gram + 2-gram(불용어를 뺀 뒤 이웃한 토큰)  5) tf = 1 + ln(횟수)  6) idf = ln((1+n)/(1+df)) + 1
// 7) 행마다 L2 정규화  8) 코사인 = 정규화된 벡터의 내적.  어휘는 문서들 + 질의로 만든다(원본의 fit(docs + [query])).

// sklearn.feature_extraction.text.ENGLISH_STOP_WORDS (318개, scikit-learn 1.6 그대로)
export const ENGLISH_STOP_WORDS = new Set([
  'a', 'about', 'above', 'across', 'after', 'afterwards', 'again', 'against', 'all', 'almost', 'alone',
  'along', 'already', 'also', 'although', 'always', 'am', 'among', 'amongst', 'amoungst', 'amount', 'an',
  'and', 'another', 'any', 'anyhow', 'anyone', 'anything', 'anyway', 'anywhere', 'are', 'around', 'as', 'at',
  'back', 'be', 'became', 'because', 'become', 'becomes', 'becoming', 'been', 'before', 'beforehand', 'behind',
  'being', 'below', 'beside', 'besides', 'between', 'beyond', 'bill', 'both', 'bottom', 'but', 'by', 'call',
  'can', 'cannot', 'cant', 'co', 'con', 'could', 'couldnt', 'cry', 'de', 'describe', 'detail', 'do', 'done',
  'down', 'due', 'during', 'each', 'eg', 'eight', 'either', 'eleven', 'else', 'elsewhere', 'empty', 'enough',
  'etc', 'even', 'ever', 'every', 'everyone', 'everything', 'everywhere', 'except', 'few', 'fifteen', 'fifty',
  'fill', 'find', 'fire', 'first', 'five', 'for', 'former', 'formerly', 'forty', 'found', 'four', 'from',
  'front', 'full', 'further', 'get', 'give', 'go', 'had', 'has', 'hasnt', 'have', 'he', 'hence', 'her', 'here',
  'hereafter', 'hereby', 'herein', 'hereupon', 'hers', 'herself', 'him', 'himself', 'his', 'how', 'however',
  'hundred', 'i', 'ie', 'if', 'in', 'inc', 'indeed', 'interest', 'into', 'is', 'it', 'its', 'itself', 'keep',
  'last', 'latter', 'latterly', 'least', 'less', 'ltd', 'made', 'many', 'may', 'me', 'meanwhile', 'might',
  'mill', 'mine', 'more', 'moreover', 'most', 'mostly', 'move', 'much', 'must', 'my', 'myself', 'name',
  'namely', 'neither', 'never', 'nevertheless', 'next', 'nine', 'no', 'nobody', 'none', 'noone', 'nor', 'not',
  'nothing', 'now', 'nowhere', 'of', 'off', 'often', 'on', 'once', 'one', 'only', 'onto', 'or', 'other',
  'others', 'otherwise', 'our', 'ours', 'ourselves', 'out', 'over', 'own', 'part', 'per', 'perhaps', 'please',
  'put', 'rather', 're', 'same', 'see', 'seem', 'seemed', 'seeming', 'seems', 'serious', 'several', 'she',
  'should', 'show', 'side', 'since', 'sincere', 'six', 'sixty', 'so', 'some', 'somehow', 'someone',
  'something', 'sometime', 'sometimes', 'somewhere', 'still', 'such', 'system', 'take', 'ten', 'than', 'that',
  'the', 'their', 'them', 'themselves', 'then', 'thence', 'there', 'thereafter', 'thereby', 'therefore',
  'therein', 'thereupon', 'these', 'they', 'thick', 'thin', 'third', 'this', 'those', 'though', 'three',
  'through', 'throughout', 'thru', 'thus', 'to', 'together', 'too', 'top', 'toward', 'towards', 'twelve',
  'twenty', 'two', 'un', 'under', 'until', 'up', 'upon', 'us', 'very', 'via', 'was', 'we', 'well', 'were',
  'what', 'whatever', 'when', 'whence', 'whenever', 'where', 'whereafter', 'whereas', 'whereby', 'wherein',
  'whereupon', 'wherever', 'whether', 'which', 'while', 'whither', 'who', 'whoever', 'whole', 'whom', 'whose',
  'why', 'will', 'with', 'within', 'without', 'would', 'yet', 'you', 'your', 'yours', 'yourself', 'yourselves'
]);

// JavaScript의 \b·\w는 ASCII 기준이라, 파이썬 유니코드 \w(글자·숫자·밑줄)의 연속 2자 이상을 직접 찾는다.
// \b\w\w+\b는 "단어 문자 연속 구간 전체(길이 2 이상)"와 같다.
const TOKEN = /[\p{L}\p{N}_]{2,}/gu;

/** 소문자화 + 토큰화 (불용어 제거 전) */
export function tokenize(text) {
  return String(text || '').toLowerCase().match(TOKEN) || [];
}

/** 한 문서의 분석 결과: 불용어를 뺀 1-gram과 2-gram 목록 (sklearn _word_ngrams와 같은 순서) */
export function analyze(text) {
  const tokens = tokenize(text).filter((w) => !ENGLISH_STOP_WORDS.has(w));
  const grams = [...tokens];
  for (let i = 0; i + 1 < tokens.length; i++) grams.push(`${tokens[i]} ${tokens[i + 1]}`);
  return grams;
}

/**
 * 문서들 + 질의로 어휘·idf를 만들고, 각 문서를 L2 정규화한 TF-IDF 벡터(Map: 단어 → 값)로 바꾼다.
 * 어휘가 비면 null (sklearn의 ValueError "empty vocabulary"에 해당).
 * @param {string[]} texts
 * @returns {{vectors: Map<string, number>[], idf: Map<string, number>} | null}
 */
export function tfidfVectors(texts) {
  const analyzed = texts.map(analyze);
  const df = new Map();
  for (const grams of analyzed) {
    for (const g of new Set(grams)) df.set(g, (df.get(g) || 0) + 1);
  }
  if (!df.size) return null;
  const n = texts.length;
  const idf = new Map();
  for (const [g, d] of df) idf.set(g, Math.log((1 + n) / (1 + d)) + 1);
  const vectors = analyzed.map((grams) => {
    const tf = new Map();
    for (const g of grams) tf.set(g, (tf.get(g) || 0) + 1);
    const v = new Map();
    let norm = 0;
    for (const [g, c] of tf) {
      const w = (1 + Math.log(c)) * idf.get(g);
      v.set(g, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm);
    if (norm > 0) for (const [g, w] of v) v.set(g, w / norm);
    return v;
  });
  return { vectors, idf };
}

/**
 * 질의와 각 문서의 코사인 유사도. 어휘가 비어 있으면 모두 0 (원본의 except ValueError 처리와 같음).
 * @param {string} queryText
 * @param {string[]} docs
 * @returns {number[]}
 */
export function cosineScores(queryText, docs) {
  const built = tfidfVectors([...docs, queryText]);
  if (!built) return docs.map(() => 0);
  const q = built.vectors[built.vectors.length - 1];
  return built.vectors.slice(0, docs.length).map((v) => {
    let dot = 0;
    const [small, big] = v.size < q.size ? [v, q] : [q, v];
    for (const [g, w] of small) {
      const o = big.get(g);
      if (o) dot += w * o;
    }
    return dot;
  });
}
