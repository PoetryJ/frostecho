export function deepClone<T>(v: T): T { return structuredClone(v); }
export function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v as object)) deepFreeze((v as any)[k]);
  }
  return v;
}
/** Canonical JSON (sorted keys) for command fingerprinting. */
export function canonical(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v as object).sort().map(k => JSON.stringify(k) + ':' + canonical((v as any)[k])).join(',') + '}';
}
