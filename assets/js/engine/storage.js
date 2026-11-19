// 실행 기록 저장소 (SITE_SPEC 5). 브라우저 백엔드가 쓰는 작은 키-값 저장소 인터페이스와 구현 2개.
//
// 인터페이스: get(store, key) / put(store, key, value) / delete(store, key) / keys(store) / getAll(store) — 모두 Promise.
// store: runs(실행 스냅샷), events(실행별 이벤트 배열), results(result.json), checkpoints(이어하기 상태),
//        qa(실행별 후속 질문 배열), meta(그 밖: 슬라이드 개요 등)
// - IndexedDBStorage: 브라우저용(DB 이름 ai-research-agent, 버전 1). 키는 값 밖에 둔다(out-of-line key).
//   indexedDB는 처음 쓸 때 연다(모듈을 Node에서 import해도 indexedDB에 접근하지 않게).
// - MemoryStorage: 테스트·임시용. IndexedDB처럼 넣고 꺼낼 때 값을 복사한다(바깥에서 고쳐도 저장된 값은 그대로).

export const STORES = Object.freeze(['runs', 'events', 'results', 'checkpoints', 'qa', 'meta']);
export const DB_NAME = 'ai-research-agent';
export const DB_VERSION = 1;

function checkStore(store) {
  if (!STORES.includes(store)) throw new Error(`알 수 없는 저장소입니다: ${store}`);
}

const copy = (v) => (v === undefined ? undefined : structuredClone(v));

/** 메모리 저장소 (테스트용, 새로고침하면 사라짐). */
export class MemoryStorage {
  constructor() {
    this.kind = 'memory';
    this._data = new Map(STORES.map((s) => [s, new Map()]));
  }

  async get(store, key) {
    checkStore(store);
    return copy(this._data.get(store).get(key));
  }

  async put(store, key, value) {
    checkStore(store);
    this._data.get(store).set(key, copy(value));
  }

  async delete(store, key) {
    checkStore(store);
    this._data.get(store).delete(key);
  }

  async keys(store) {
    checkStore(store);
    return [...this._data.get(store).keys()];
  }

  async getAll(store) {
    checkStore(store);
    return [...this._data.get(store).values()].map(copy);
  }
}

/** IDBRequest → Promise */
function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('IndexedDB 요청 실패'));
  });
}

/** 브라우저 IndexedDB 저장소. */
export class IndexedDBStorage {
  /**
   * @param {{name?: string, version?: number, indexedDB?: IDBFactory}} [opts]  indexedDB: 테스트용 주입(기본 globalThis.indexedDB)
   */
  constructor({ name = DB_NAME, version = DB_VERSION, indexedDB = null } = {}) {
    this.kind = 'indexeddb';
    this.name = name;
    this.version = version;
    this._factory = indexedDB;
    this._dbPromise = null;
    this._dbConn = null;            // 열린 연결(닫히면 _dbPromise를 비우는 데 쓴다)
  }

  /** DB를 한 번만 연다. 없는 저장소(object store)는 만든다. */
  _db() {
    if (!this._dbPromise) {
      this._dbPromise = new Promise((resolve, reject) => {
        const factory = this._factory || globalThis.indexedDB;
        if (!factory) {
          reject(new Error('이 브라우저에서는 IndexedDB를 쓸 수 없습니다.'));
          return;
        }
        let r;
        try {
          r = factory.open(this.name, this.version);
        } catch (e) {
          reject(e);
          return;
        }
        r.onupgradeneeded = () => {
          const db = r.result;
          for (const s of STORES) {
            if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
          }
        };
        r.onsuccess = () => {
          const db = r.result;
          // 다른 탭이 새 버전으로 열려고 하면 닫아 준다(그 탭이 막히지 않게).
          // 닫힌 연결은 다시 쓸 수 없으므로 캐시를 비워 다음 쓰기에서 새로 연다.
          const forget = () => {
            if (this._dbConn === db) {
              this._dbConn = null;
              this._dbPromise = null;
            }
          };
          db.onversionchange = () => {
            db.close();
            forget();
          };
          db.onclose = forget;
          this._dbConn = db;
          resolve(db);
        };
        r.onerror = () => reject(r.error || new Error('IndexedDB를 열지 못했습니다.'));
        r.onblocked = () => reject(new Error('다른 탭이 저장소를 쓰고 있어 열지 못했습니다. 다른 탭을 닫고 새로고침해 주세요.'));
      });
      this._dbPromise.catch(() => { this._dbPromise = null; });   // 실패하면 다음 호출에서 다시 시도
    }
    return this._dbPromise;
  }

  async _run(store, mode, fn) {
    checkStore(store);
    const db = await this._db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      let out;
      const r = fn(tx.objectStore(store));
      if (r) req(r).then((v) => { out = v; }, () => {});
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB 트랜잭션 실패'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB 트랜잭션이 중단되었습니다(저장 공간 부족 등).'));
    });
  }

  get(store, key) {
    return this._run(store, 'readonly', (s) => s.get(key));
  }

  put(store, key, value) {
    return this._run(store, 'readwrite', (s) => s.put(value, key)).then(() => undefined);
  }

  delete(store, key) {
    return this._run(store, 'readwrite', (s) => s.delete(key)).then(() => undefined);
  }

  async keys(store) {
    return (await this._run(store, 'readonly', (s) => s.getAllKeys())) || [];
  }

  async getAll(store) {
    return (await this._run(store, 'readonly', (s) => s.getAll())) || [];
  }
}
