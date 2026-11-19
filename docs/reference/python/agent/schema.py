"""JSON Schema 축약 헬퍼 (구조화 출력용). 노트북의 S, I, B, O, A, E와 같다."""

S = {"type": "string"}
I = {"type": "integer"}
B = {"type": "boolean"}


def O(**props):
    return {"type": "object", "properties": props, "required": list(props), "additionalProperties": False}


def A(item):
    return {"type": "array", "items": item}


def E(*values):
    return {"type": "string", "enum": list(values)}
