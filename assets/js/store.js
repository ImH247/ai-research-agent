// 관찰 가능한 단일 상태 저장소와 브라우저 저장 규칙(FRONTEND 1절).
// API 키: 기본은 메모리 + sessionStorage, "이 브라우저에 저장"을 켰을 때만 localStorage.

const KEYS = {
  apiKey: 'ra.apiKey',
  mockApiKey: 'ra.mock.apiKey', // 테스트 모드(?mock=1)의 가짜 키는 따로 둔다(실제 모드로 새지 않게)
  theme: 'ra.theme',
  prefs: 'ra.prefs',
  draft: 'ra.draft',
  onboarding: 'ra.onboarding',
};

function safeGet(storage, key) {
  try {
    return storage ? storage.getItem(key) : null;
  } catch {
    return null;
  }
}
function safeSet(storage, key, value) {
  try {
    if (storage) storage.setItem(key, value);
  } catch {
    /* 저장 불가(사생활 보호 모드 등) — 무시 */
  }
}
function safeRemove(storage, key) {
  try {
    if (storage) storage.removeItem(key);
  } catch {
    /* 무시 */
  }
}
const LS = (() => { try { return window.localStorage; } catch { return null; } })();
const SS = (() => { try { return window.sessionStorage; } catch { return null; } })();

function loadJSON(key, fallback) {
  const raw = safeGet(LS, key);
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

// ───────────────────────── 저장소 ─────────────────────────

function createStore(initial) {
  let state = { ...initial };
  const subs = new Set();
  return {
    get: () => state,
    set(patch) {
      if (!patch || typeof patch !== 'object') return;
      const changed = Object.keys(patch).filter((k) => state[k] !== patch[k]);
      if (!changed.length) return;
      const prev = state;
      state = { ...state, ...patch };
      for (const fn of [...subs]) {
        try {
          fn(state, prev, changed);
        } catch (err) {
          console.error(err);
        }
      }
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

export const store = createStore({
  config: null,          // GET /api/config
  runs: null,            // 기록 목록(null = 아직 불러오지 않음)
  keyStatus: { state: 'none', message: '', models: null }, // none | unchecked | ok | error
  theme: loadTheme(),    // light | dark | system
  prefs: loadPrefs(),    // 마지막으로 쓴 설정
  draft: loadDraft(),    // 작성 중인 프롬프트
  prefill: null,         // "같은 설정으로 다시 조사": {prompt, config}
  serverDown: false,     // (예전 서버 연결 실패 띠 — 브라우저 버전에서는 쓰지 않음)
  onboardingDismissed: loadOnboardingDismissed(), // 처음 사용 안내 "다시 보지 않기"
  historyQuery: '',      // 기록 검색어(왼쪽 사이드바 기록)
});

// ───────────────────────── API 키 ─────────────────────────

let memoryKey = '';

/** 테스트 모드면 가짜 키 전용 저장 키를 쓴다. 노드 테스트에서도 import할 수 있게 부를 때 판단한다. */
function apiKeyName() {
  try {
    return new URLSearchParams(globalThis.location?.search || '').get('mock') === '1' ? KEYS.mockApiKey : KEYS.apiKey;
  } catch {
    return KEYS.apiKey;
  }
}

export function getApiKey() {
  if (memoryKey) return memoryKey;
  const k = safeGet(SS, apiKeyName()) || safeGet(LS, apiKeyName()) || '';
  memoryKey = k;
  return k;
}

export function isKeyRemembered() {
  return !!safeGet(LS, apiKeyName());
}

/** 키를 저장한다. remember=true면 localStorage에도 남긴다. 상태는 '미확인'이 된다. */
export function setApiKey(key, remember = false) {
  const k = String(key || '').trim();
  memoryKey = k;
  if (!k) {
    clearApiKey();
    return;
  }
  const name = apiKeyName();
  safeSet(SS, name, k);
  if (remember) safeSet(LS, name, k);
  else safeRemove(LS, name);
  store.set({ keyStatus: { state: 'unchecked', message: '', models: null } });
}

export function clearApiKey() {
  memoryKey = '';
  const name = apiKeyName();
  safeRemove(SS, name);
  safeRemove(LS, name);
  store.set({ keyStatus: { state: 'none', message: '', models: null } });
}

/** 화면 표시용 끝 4자리 */
export function keyTail(key = getApiKey()) {
  return key ? key.slice(-4) : '';
}

// ───────────────────────── 테마 · 설정 · 임시 저장 ─────────────────────────

export function loadTheme() {
  const t = safeGet(LS, KEYS.theme);
  return t === 'light' || t === 'dark' ? t : 'system';
}

export function saveTheme(theme) {
  const t = theme === 'light' || theme === 'dark' ? theme : 'system';
  if (t === 'system') safeRemove(LS, KEYS.theme);
  else safeSet(LS, KEYS.theme, t);
  return t;
}

/**
 * 마지막으로 쓴 모델·깊이·형식·옵션과 편의 설정.
 * 약속된 키(WEB_FEATURES): notify(boolean), maxCost(number|null, 사용자가 직접 정한 한도만), demoSpeed(1|5),
 * sidebarOpen(boolean, LAYOUT_V3 1절: 넓은 화면에서 왼쪽 사이드바를 펼쳐 둘지).
 */
export function loadPrefs() {
  return loadJSON(KEYS.prefs, {});
}

export function savePrefs(patch) {
  const next = { ...loadPrefs(), ...(patch || {}) };
  safeSet(LS, KEYS.prefs, JSON.stringify(next));
  if (typeof store !== 'undefined') store.set({ prefs: next });
  return next;
}

export function loadDraft() {
  return safeGet(LS, KEYS.draft) || '';
}

export function saveDraft(text) {
  const t = String(text || '');
  if (t.trim()) safeSet(LS, KEYS.draft, t);
  else safeRemove(LS, KEYS.draft);
  store.set({ draft: t });
}

/** 편의 설정 하나 읽기: getPref('notify', false) */
export function getPref(name, fallback = null) {
  const p = store.get().prefs || {};
  return Object.hasOwn(p, name) && p[name] !== undefined ? p[name] : fallback;
}

/** 데모 재생 속도(1 또는 5) */
export function demoSpeedPref() {
  return Number(getPref('demoSpeed', 1)) === 5 ? 5 : 1;
}

/** 왼쪽 사이드바 펼침 저장값(prefs.sidebarOpen). 저장한 적이 없으면 null — 그때는 화면 폭으로 정한다. */
export function sidebarOpenPref() {
  const v = getPref('sidebarOpen', null);
  return typeof v === 'boolean' ? v : null;
}

/** 사용자가 사이드바를 접거나 펼쳤을 때만 저장한다(좁은 화면의 서랍은 저장하지 않는다) */
export function saveSidebarOpen(open) {
  savePrefs({ sidebarOpen: !!open });
}

function loadOnboardingDismissed() {
  const v = loadJSON(KEYS.onboarding, {});
  return v.dismissed === true;
}

/** 처음 사용 안내 "다시 보지 않기" 저장 (onboarding.dismissed) */
export function setOnboardingDismissed(dismissed = true) {
  if (dismissed) safeSet(LS, KEYS.onboarding, JSON.stringify({ dismissed: true }));
  else safeRemove(LS, KEYS.onboarding);
  store.set({ onboardingDismissed: !!dismissed });
}

/** 대기 중인 미리 채우기 값을 꺼내고 비운다 */
export function takePrefill() {
  const p = store.get().prefill;
  if (p) store.set({ prefill: null });
  return p;
}
