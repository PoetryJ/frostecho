export function deepClone<T>(v: T): T { return structuredClone(v); }
export function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v as object)) deepFreeze((v as any)[k]);
  }
  return v;
}
/**
 * Canonical JSON (sorted keys).
 * Object keys whose value is undefined are omitted, matching JSON.stringify.
 * Undefined array elements stay null, matching JSON.stringify([undefined]).
 * Do not encode a missing object value as null: null is a different payload.
 */
export function canonical(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).sort().filter(k => o[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
}
