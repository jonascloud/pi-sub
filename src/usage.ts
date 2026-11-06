import type { Usage } from "@earendil-works/pi-ai";

/** Accumulate into an owned total without aliasing or mutating the added value. */
export function addUsage(total: Usage | undefined, value: Usage): Usage {
  if (!total) return structuredClone(value);
  for (const key of [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "totalTokens",
  ] as const)
    total[key] += value[key];
  for (const key of ["reasoning", "cacheWrite1h"] as const)
    if (value[key] !== undefined) total[key] = (total[key] ?? 0) + value[key];
  for (const key of [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "total",
  ] as const)
    total.cost[key] += value.cost[key];
  if (
    total.cost.totalFromProvider !== undefined ||
    value.cost.totalFromProvider !== undefined
  )
    total.cost.totalFromProvider =
      total.cost.totalFromProvider === true &&
      value.cost.totalFromProvider === true;
  return total;
}
