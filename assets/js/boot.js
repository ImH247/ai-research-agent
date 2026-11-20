/* 첫 화면을 그리기 전에 저장된 테마와 디자인(스킨)을 적용한다(깜박임 방지). CSP 때문에 인라인 대신 별도 파일로 둔다. 동기 실행(모듈 아님). */
(function () {
  var root = document.documentElement;
  var ls = null;
  try { ls = window.localStorage; } catch (e) { /* 저장소 접근 불가 */ }

  try {
    var t = ls && ls.getItem('ra.theme');
    if (t === 'light' || t === 'dark') root.setAttribute('data-theme', t);
  } catch (e) { /* 저장소 접근 불가 */ }

  // 디자인(DESIGN_LAVENDER 3절): URL ?skin=classic|lavender(있으면 저장) → localStorage 'ra.skin' → 기본 'lavender'
  var skin = null;
  try {
    var q = new URLSearchParams(window.location.search || '').get('skin');
    if (q === 'classic' || q === 'lavender') {
      skin = q;
      var saved = false;
      try { if (ls) { ls.setItem('ra.skin', q); saved = true; } } catch (e) { /* 저장 불가 — 이번 화면에만 적용 */ }
      // 저장했으면 주소에서 skin 값을 지운다. 남겨 두면 설정에서 디자인을 바꾼 뒤 새로고침할 때 주소의 값이 다시 덮어쓴다.
      // (저장하지 못했으면 그대로 둔다 — 새로고침해도 같은 디자인이 유지되게)
      if (saved) {
        try {
          var u = new URL(window.location.href);
          u.searchParams.delete('skin');
          window.history.replaceState(window.history.state, '', u.pathname + u.search + u.hash);
        } catch (e) { /* 주소를 못 바꿔도 화면에는 영향 없음 */ }
      }
    }
  } catch (e) { /* 주소 해석 실패 — 무시 */ }
  if (!skin) {
    try {
      var s = ls && ls.getItem('ra.skin');
      if (s === 'classic' || s === 'lavender') skin = s;
    } catch (e) { /* 저장소 접근 불가 */ }
  }
  if (!skin) skin = 'lavender';
  root.setAttribute('data-skin', skin);

  // 파비콘: 라벤더면 같은 모양의 보라(#6A3DE8) 아이콘으로 바꾼다. 두 주소를 link에 남겨 두면 main.js가 설정 창에서 바꿀 때 쓴다.
  try {
    var link = document.querySelector('link[rel="icon"]');
    if (link) {
      var classicHref = link.getAttribute('href') || '';
      var lavenderHref = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%236A3DE8'/%3E%3Ccircle cx='14' cy='14' r='6.5' fill='none' stroke='white' stroke-width='2.2'/%3E%3Cpath d='M19 19l6 6M11 14h6' stroke='white' stroke-width='2.2' stroke-linecap='round'/%3E%3C/svg%3E";
      link.setAttribute('data-href-classic', classicHref);
      link.setAttribute('data-href-lavender', lavenderHref);
      if (skin === 'lavender') link.setAttribute('href', lavenderHref);
    }
  } catch (e) { /* 파비콘 교체 실패 — 무시 */ }
})();
