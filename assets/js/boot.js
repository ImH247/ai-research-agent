/* 첫 화면을 그리기 전에 저장된 테마를 적용한다(깜박임 방지). CSP 때문에 인라인 대신 별도 파일로 둔다. 동기 실행(모듈 아님). */
(function () {
  try {
    var t = window.localStorage.getItem('ra.theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* 저장소 접근 불가 */ }
})();
