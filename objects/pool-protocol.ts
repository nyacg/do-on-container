/** Results of a handoff: only these keys have a durable snapshot and are fenced. */
export interface EvictionResult {
  evicted: number;
  evictedKeys?: string[];
  seg?: string | null;
  alarms?: { key: string; at: number }[];
  errors?: string[];
}

export function confirmedEvictions(result: EvictionResult, requested: string[]): string[] {
  // Older nodes only report a count. A partial count cannot identify which keys moved.
  const confirmed = result.evictedKeys ?? (result.evicted === requested.length ? requested : []);
  const allowed = new Set(requested);
  return [...new Set(confirmed)].filter((key) => allowed.has(key));
}
