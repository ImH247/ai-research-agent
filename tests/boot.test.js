// boot.js 점검: 첫 화면 전에 정하는 화면 테마와 디자인(스킨).
// boot.js는 모듈이 아닌 일반 스크립트라서, 브라우저 전역(window · document · localStorage · history)을 최소로 흉내 내고 node:vm에서 돌린다.
// 확인하는 것: 디자인을 고르는 순서(주소 ?skin= → 저장된 값 → 기본 라벤더), 주소 정리, 파비콘, 글꼴 미리 받기(라벤더에서만).
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BOOT = readFileSync(new URL('../assets/js/boot.js', import.meta.url), 'utf8');
const FONTS_CSS = readFileSync(new URL('../assets/fonts/fonts.css', import.meta.url), 'utf8');
const CLASSIC_ICON = "data:image/svg+xml,classic-icon";

/** boot.js를 한 번 실행하고, 그 결과로 바뀐 것들을 돌려준다. */
function runBoot({ url = 'https://example.test/app/', stored = {}, storageThrows = false, noStorage = false } = {}) {
  const attrs = {};
  const store = { ...stored };
  const head = [];
  const icon = {
    attrs: { href: CLASSIC_ICON },
    getAttribute(k) { return this.attrs[k] ?? null; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
  };
  const location = new URL(url);
  const replaced = [];
  const localStorage = {
    getItem(k) { if (storageThrows) throw new Error('blocked'); return k in store ? store[k] : null; },
    setItem(k, v) { if (storageThrows) throw new Error('blocked'); store[k] = String(v); },
  };
  const window = {
    location,
    history: { state: null, replaceState(_state, _title, to) { replaced.push(to); } },
  };
  if (noStorage) Object.defineProperty(window, 'localStorage', { get() { throw new Error('denied'); } });
  else window.localStorage = localStorage;
  const document = {
    documentElement: { setAttribute(k, v) { attrs[k] = String(v); } },
    querySelector(sel) { return sel === 'link[rel="icon"]' ? icon : null; },
    createElement(tag) { return { tag }; },
    head: { appendChild(el) { head.push(el); } },
  };
  vm.runInNewContext(BOOT, { window, document, URL, URLSearchParams });
  return { attrs, store, icon: icon.attrs, replaced, preloads: head.filter((el) => el.tag === 'link' && el.rel === 'preload') };
}

test('boot.js: 저장된 값이 없으면 라벤더 디자인, 화면 테마는 시스템 설정을 따른다', () => {
  const r = runBoot();
  assert.equal(r.attrs['data-skin'], 'lavender');
  assert.equal('data-theme' in r.attrs, false, '테마를 고르지 않았으면 data-theme을 붙이지 않는다(시스템 설정)');
  assert.equal(r.replaced.length, 0, '주소에 skin 값이 없으면 주소를 건드리지 않는다');
  assert.match(r.icon.href, /%236A3DE8/, '라벤더에서는 보라 파비콘');
  assert.equal(r.icon['data-href-classic'], CLASSIC_ICON, '설정 창에서 바꿀 때 쓰도록 두 주소를 남긴다');
  assert.match(r.icon['data-href-lavender'], /%236A3DE8/);
});

test('boot.js: 저장된 테마와 디자인을 그대로 적용하고, 알 수 없는 값은 무시한다', () => {
  const dark = runBoot({ stored: { 'ra.theme': 'dark', 'ra.skin': 'classic' } });
  assert.equal(dark.attrs['data-theme'], 'dark');
  assert.equal(dark.attrs['data-skin'], 'classic');
  assert.equal(dark.icon.href, CLASSIC_ICON, '클래식에서는 파비콘을 바꾸지 않는다');

  const odd = runBoot({ stored: { 'ra.theme': 'sepia', 'ra.skin': 'neon' } });
  assert.equal('data-theme' in odd.attrs, false);
  assert.equal(odd.attrs['data-skin'], 'lavender');
});

test('boot.js: 주소의 ?skin= 이 저장된 값보다 먼저이고, 저장한 뒤 주소에서 지운다(다른 값과 # 뒤는 그대로)', () => {
  const r = runBoot({ url: 'https://example.test/app/?skin=classic&mock=1#/run/abc', stored: { 'ra.skin': 'lavender' } });
  assert.equal(r.attrs['data-skin'], 'classic');
  assert.equal(r.store['ra.skin'], 'classic');
  assert.deepEqual(r.replaced, ['/app/?mock=1#/run/abc']);

  const only = runBoot({ url: 'https://example.test/app/?skin=lavender' });
  assert.equal(only.attrs['data-skin'], 'lavender');
  assert.deepEqual(only.replaced, ['/app/'], '남는 값이 없으면 ? 도 남기지 않는다');

  const bogus = runBoot({ url: 'https://example.test/app/?skin=neon', stored: { 'ra.skin': 'classic' } });
  assert.equal(bogus.attrs['data-skin'], 'classic', '알 수 없는 값은 무시하고 저장된 값을 쓴다');
  assert.equal(bogus.replaced.length, 0);
  assert.equal(bogus.store['ra.skin'], 'classic');
});

test('boot.js: # 뒤에 붙은 skin 값은 읽지 않는다(README가 # 앞에 넣으라고 안내한다)', () => {
  const r = runBoot({ url: 'https://example.test/app/#/run/abc?skin=classic' });
  assert.equal(r.attrs['data-skin'], 'lavender');
  assert.equal(r.replaced.length, 0);
});

test('boot.js: 저장소를 쓸 수 없어도 멈추지 않고, 저장하지 못한 주소 값은 지우지 않는다', () => {
  const blocked = runBoot({ url: 'https://example.test/app/?skin=classic', storageThrows: true });
  assert.equal(blocked.attrs['data-skin'], 'classic', '이번 화면에는 적용한다');
  assert.equal(blocked.replaced.length, 0, '저장하지 못했으면 새로고침해도 유지되도록 주소에 남긴다');

  const denied = runBoot({ noStorage: true });
  assert.equal(denied.attrs['data-skin'], 'lavender');
  assert.equal('data-theme' in denied.attrs, false);
});

test('boot.js: 글꼴은 라벤더에서만 미리 받고, 주소는 fonts.css · 실제 파일과 맞는다', () => {
  const lav = runBoot();
  assert.equal(lav.preloads.length, 16);
  const hrefs = lav.preloads.map((l) => l.href);
  assert.equal(new Set(hrefs).size, hrefs.length, '같은 파일을 두 번 넣지 않는다');
  for (const link of lav.preloads) {
    assert.equal(link.as, 'font');
    assert.equal(link.type, 'font/woff2');
    assert.equal(link.crossOrigin, 'anonymous', 'crossorigin이 없으면 미리 받은 글꼴을 쓰지 못하고 다시 받는다');
    assert.match(link.href, /^\.\/assets\/fonts\/(outfit|pretendard)\/[\w-]+\.woff2$/);
    const rel = link.href.replace('./assets/fonts/', ''); // fonts.css 안에서는 ./pretendard/pv-N.woff2 꼴
    assert.ok(FONTS_CSS.includes(`url(./${rel})`), `${rel}: fonts.css에 같은 주소가 있어야 한다`);
    assert.ok(existsSync(fileURLToPath(new URL(`../assets/fonts/${rel}`, import.meta.url))), `${rel}: 파일이 있어야 한다`);
  }

  const classic = runBoot({ stored: { 'ra.skin': 'classic' } });
  assert.equal(classic.preloads.length, 0, '클래식은 이 글꼴을 쓰지 않으므로 받지 않는다');
  const viaUrl = runBoot({ url: 'https://example.test/app/?skin=classic' });
  assert.equal(viaUrl.preloads.length, 0);
});
