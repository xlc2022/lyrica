import { HttpError } from "./http.ts";

/** Bounded history requests; the query is never logged. */
export function historyQuery(query: URLSearchParams) {
  const integer = (key: string, fallback: number, max: number) => {
    const raw = query.get(key);
    if (raw === null) return fallback;
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > max || (key === "limit" && Number(raw) === 0)) {
      throw new HttpError(400, `invalid ${key}`);
    }
    return Number(raw);
  };
  const q = (query.get("q") ?? "").trim();
  if (q.length > 200) throw new HttpError(400, "the search is too long");
  return { limit: integer("limit", 20, 100), offset: integer("offset", 0, Number.MAX_SAFE_INTEGER), q };
}
