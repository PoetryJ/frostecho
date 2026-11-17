/**
 * G10: the fetch-boundary wire collector shared by eval and the application.
 * The serialized request body is saved BEFORE awaiting the response, so an
 * abort/timeout still records the ONE request that was really sent.
 */
/** One real wire exchange captured at the fetch boundary. */
export interface G09WireCapture {
  requestBody: unknown;
  requestBodyText: string;
  /** null when no response arrived (abort/timeout); never invented. */
  status: number | null;
  /** null when no body arrived (abort/timeout); never invented. */
  responseBody: string | null;
}

/**
 * The ONE boundary collector shared by the fake and live branches: it wraps
 * the fetch actually used for the call. The exact serialized request body is
 * saved BEFORE awaiting the response, so a timeout/abort still leaves the
 * evidence of the ONE request that was really sent. The response status/text
 * are filled in when it arrives (via clone); a missing response stays null.
 */
export function createWireCollector(inner: typeof fetch): {
  fetchImpl: typeof fetch;
  take(): G09WireCapture | null;
} {
  let slot: G09WireCapture | null = null;
  const fetchImpl: typeof fetch = async (input, init) => {
    const text = typeof init?.body === 'string' ? init.body : '';
    let requestBody: unknown = {};
    try {
      requestBody = text ? JSON.parse(text) : {};
    } catch {
      requestBody = { raw: text };
    }
    const entry: G09WireCapture = { requestBody, requestBodyText: text, status: null, responseBody: null };
    slot = entry;
    const response = await inner(input, init);
    entry.status = response.status;
    try {
      entry.responseBody = await response.clone().text();
    } catch {
      entry.responseBody = null;
    }
    return response;
  };
  return {
    fetchImpl,
    take: () => {
      const current = slot;
      slot = null;
      return current;
    },
  };
}

/** Usage parsed from the REAL body; null when absent/unparseable (never invented). */
export function wireUsage(body: string): { total_tokens: number | null; prompt_tokens: number | null; completion_tokens: number | null } | null {
  try {
    const parsed = JSON.parse(body) as { usage?: Record<string, unknown> };
    const usage = parsed.usage;
    if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return null;
    const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
    const stats = {
      total_tokens: num(usage.total_tokens),
      prompt_tokens: num(usage.prompt_tokens),
      completion_tokens: num(usage.completion_tokens),
    };
    if (stats.total_tokens === null && stats.prompt_tokens === null && stats.completion_tokens === null) return null;
    return stats;
  } catch {
    return null;
  }
}

