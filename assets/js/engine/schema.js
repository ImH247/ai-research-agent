// JSON Schema 축약 헬퍼 (구조화 출력용). 노트북의 S, I, B, O, A, E와 같다. (원본: agent/schema.py)

export const S = Object.freeze({ type: 'string' });
export const I = Object.freeze({ type: 'integer' });
export const B = Object.freeze({ type: 'boolean' });

/** O({ a: S, b: I }) → 모든 속성이 필수이고 추가 속성이 없는 객체 스키마 */
export function O(props) {
  return { type: 'object', properties: props, required: Object.keys(props), additionalProperties: false };
}

export function A(item) {
  return { type: 'array', items: item };
}

export function E(...values) {
  return { type: 'string', enum: [...values] };
}
