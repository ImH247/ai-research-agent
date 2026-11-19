// 보고서 다시 쓰기 대화상자 (WEB_FEATURES F8).
// 같은 근거로 ⑦ 보고서 작성 + ⑧ 인용 검증만 다시 하는 새 실행을 만들고, 그 진행 화면으로 이동한다.
// 사용자 입력(추가 요청)은 textarea 값으로만 다루고, 화면에는 텍스트 노드로만 넣는다.

import { api } from '../api.js';
import { store, getApiKey } from '../store.js';
import { h, icon, modal, toast, setBusy, str, arr, obj, num, uid, fmtCost } from '../ui.js';
import { navigate, openKeyDialog, refreshRuns } from '../main.js';

const LANGS = [['ko', '한국어'], ['en', 'English']];
const LENGTHS = [['short', '간단히', 10000], ['standard', '보통', 25000], ['detailed', '자세히', 40000]];
const INPUT_TOKENS = 60000;
const MAX_EXTRA = 500;

/** 대략 비용(USD): 모델 가격 × (입력 약 60k + 분량별 출력 토큰). 가격을 모르면 null */
export function estimateRewriteCost(modelInfo, length) {
  const m = obj(modelInfo);
  const pin = num(m.input_per_mtok);
  const pout = num(m.output_per_mtok);
  if (pin === null || pout === null) return null;
  const out = (LENGTHS.find((l) => l[0] === length) || LENGTHS[1])[2];
  return (INPUT_TOKENS * pin + out * pout) / 1e6;
}

const cpLen = (s) => { let n = 0; for (const _ of s) n += 1; return n; };

/** 세그먼트 버튼 묶음(aria-pressed) → {el, value()} */
function segGroup(label, options, initial, onChange) {
  let value = initial;
  const labelId = uid('seg');
  const buttons = options.map(([id, text]) => h('button', {
    type: 'button', class: 'seg-btn', 'aria-pressed': id === value ? 'true' : 'false',
    onClick: () => {
      value = id;
      for (const b of buttons) b.setAttribute('aria-pressed', b.dataset.v === id ? 'true' : 'false');
      if (onChange) onChange(id);
    },
    dataset: { v: id },
  }, text));
  const el = h('div', { class: 'rw-field' },
    h('span', { class: 'field-label', id: labelId }, label),
    h('div', { class: 'seg', role: 'group', 'aria-labelledby': labelId }, buttons));
  return { el, value: () => value };
}

/**
 * openRewriteDialog({runId, result}) — result는 결과 화면이 받은 result 페이로드(meta·lang 포함).
 * 시작하면 새 실행의 진행 화면(#/run/<새 id>)으로 이동한다.
 */
export function openRewriteDialog({ runId, result } = {}) {
  const cfg = obj(store.get().config);
  const R = obj(result);
  const m = obj(R.meta);
  const models = arr(cfg.models).filter((x) => x && str(x.id));
  const origModel = str(m.model) || str(obj(m.config).model);
  const defaultModel = models.find((x) => x.id === origModel) ? origModel : str(models.find((x) => x.default)?.id) || str(models[0]?.id) || origModel;
  const origLang = str(R.lang) === 'en' || (!str(R.lang) && str(obj(m.config).language) === 'en') ? 'en' : 'ko';

  const costEl = h('b', { class: 'num' });
  const renderCost = () => {
    const info = models.find((x) => x.id === modelSel.value);
    const usd = estimateRewriteCost(info, lengthSeg.value());
    costEl.textContent = usd === null ? '알 수 없음' : `약 ${fmtCost(usd)}`;
  };

  const langSeg = segGroup('언어', LANGS, origLang);
  const lengthSeg = segGroup('분량', LENGTHS.map(([id, label]) => [id, label]), 'standard', () => renderCost());

  const modelId = uid('rw-model');
  const modelSel = h('select', { id: modelId, class: 'input rw-select' }, models.map((x) => h('option', {
    value: x.id, selected: x.id === defaultModel ? true : null,
  }, `${str(x.label, x.id)}${x.id === origModel ? ' (원래 모델)' : ''}`)));
  if (!models.length && origModel) modelSel.append(h('option', { value: origModel, selected: true }, origModel));
  modelSel.value = defaultModel;
  modelSel.addEventListener('change', renderCost);

  const extraId = uid('rw-extra');
  const extraCount = h('span', { class: 'field-hint num' }, `0 / ${MAX_EXTRA}`);
  const extra = h('textarea', {
    id: extraId, class: 'input rw-extra', rows: '3', maxlength: String(MAX_EXTRA),
    placeholder: '예: 정책 시사점을 더 자세히', spellcheck: 'false',
  });
  extra.addEventListener('input', () => {
    const n = cpLen(extra.value);
    extraCount.textContent = `${n} / ${MAX_EXTRA}`;
  });

  const keyNote = h('div', { class: 'note rw-key', hidden: true });
  const renderKey = () => {
    const has = !!getApiKey();
    keyNote.hidden = has;
    if (!has) {
      keyNote.replaceChildren(icon('key', 16), h('span', null, '보고서를 다시 쓰려면 API 키가 필요합니다. ',
        h('button', { type: 'button', class: 'link-btn', onClick: () => openKeyDialog() }, '키 입력')));
    }
  };
  const errBox = h('p', { class: 'field-error', role: 'alert', hidden: true });

  const body = h('div', { class: 'rw-form' },
    h('p', { class: 'modal-text' }, '모은 근거는 그대로 두고 ⑦ 보고서 작성과 ⑧ 인용 검증만 다시 합니다. 새 실행으로 저장되며 원래 결과는 바뀌지 않습니다.'),
    h('div', { class: 'rw-row' }, langSeg.el, lengthSeg.el),
    h('div', { class: 'rw-field' }, h('label', { class: 'field-label', htmlFor: modelId }, '모델'), modelSel),
    h('div', { class: 'rw-field' },
      h('div', { class: 'rw-field-head' }, h('label', { class: 'field-label', htmlFor: extraId }, '추가 요청 (선택)'), extraCount),
      extra),
    h('div', { class: 'rw-cost' }, h('span', null, '예상 비용 '), costEl,
      h('span', { class: 'field-hint' }, ' · 대략치(입력 약 6만 토큰 + 분량별 출력 기준, 본인 키로 과금)')),
    keyNote,
    errBox);

  renderCost();
  renderKey();
  const unsub = store.subscribe((s, p) => { if (s.keyStatus !== p.keyStatus) renderKey(); });

  let starting = false;
  const dlg = modal({
    title: '보고서 다시 쓰기',
    body,
    size: '',
    onClose: () => unsub(),
    actions: [
      { label: '취소', kind: 'secondary' },
      {
        label: '다시 쓰기 시작', kind: 'primary', icon: 'refresh',
        onClick: async ({ close, button: btn }) => {
          if (starting) return;
          const key = getApiKey();
          if (!key) {
            renderKey();
            openKeyDialog();
            return;
          }
          starting = true;
          errBox.hidden = true;
          setBusy(btn, true, '시작하는 중…');
          try {
            const res = obj(await api.rewriteReport(runId, {
              api_key: key, model: modelSel.value || undefined, language: langSeg.value(), length: lengthSeg.value(),
              extra: extra.value.trim(),
            }));
            close();
            refreshRuns();
            toast('보고서 다시 쓰기를 시작했습니다.', 'success');
            const nid = str(res.id) || str(obj(res.status).id);
            if (nid) navigate(`#/run/${encodeURIComponent(nid)}`);
          } catch (err) {
            setBusy(btn, false);
            errBox.replaceChildren(icon('alert-triangle', 14), h('span', null, str(err?.message, '다시 쓰기를 시작하지 못했습니다.')));
            errBox.hidden = false;
            if (err?.code === 'no_api_key' || err?.code === 'auth') openKeyDialog();
          } finally {
            starting = false;
          }
        },
      },
    ],
  });
  return dlg;
}
