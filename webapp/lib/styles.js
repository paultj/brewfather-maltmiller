// Style ranges and in/out-of-range checks for the recipe stats.
// BJCP 2021 data is bundled (see bjcp-2021.json for its source). For styles
// without fixed ranges (specialty/historical styles, or non-BJCP requests)
// the ranges Claude states in the recipe's target_ranges are used instead.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BJCP = JSON.parse(fs.readFileSync(path.join(here, "bjcp-2021.json"), "utf8")).styles;

export const STATS = ["og", "fg", "abv", "ibu", "srm"];

export function bjcpStyle(code) {
  return BJCP[String(code || "").trim().toUpperCase()] || null;
}

/** Returns { source: "BJCP 2021" | "Recipe target", label, og: [min,max], ... } or null. */
export function rangesFor(recipe) {
  const style = bjcpStyle(recipe.style?.bjcp_code);
  if (style) {
    return {
      source: "BJCP 2021",
      label: `${recipe.style.bjcp_code.toUpperCase()} ${style.name}`,
      ...Object.fromEntries(STATS.map((k) => [k, style[k]])),
    };
  }
  const t = recipe.target_ranges;
  if (!t) return null;
  const ranges = {};
  for (const k of STATS) {
    const min = Number(t[`${k}_min`]);
    const max = Number(t[`${k}_max`]);
    if (Number.isFinite(min) && Number.isFinite(max) && max > 0 && max >= min) ranges[k] = [min, max];
  }
  if (!Object.keys(ranges).length) return null;
  return { source: "Recipe target", label: recipe.style?.name || "Target", ...ranges };
}

// Compare at the precision the numbers are shown with, so 1.0599 shown as
// 1.060 isn't flagged as out of a 1.060 minimum.
const PRECISION = { og: 3, fg: 3, abv: 1, ibu: 0, srm: 1 };

/** { og: "in" | "out", ... } for every stat that has a range. */
export function checkRanges(stats, ranges) {
  const result = {};
  if (!ranges) return result;
  for (const k of STATS) {
    if (!ranges[k]) continue;
    const f = 10 ** PRECISION[k];
    const v = Math.round(stats[k] * f) / f;
    result[k] = v >= ranges[k][0] && v <= ranges[k][1] ? "in" : "out";
  }
  return result;
}

const LABELS = { og: "OG", fg: "FG", abv: "ABV %", ibu: "IBU", srm: "Colour (SRM)" };

/** Text for Claude listing the out-of-range stats, or "" if all are in range. */
export function outOfRangeReport(stats, ranges, check) {
  const lines = STATS.filter((k) => check[k] === "out").map(
    (k) => `- ${LABELS[k]}: calculated ${stats[k]}, range ${ranges[k][0]}–${ranges[k][1]}`,
  );
  if (!lines.length) return "";
  return `The app calculated these stats outside the ${ranges.source} ranges for ${ranges.label}:\n${lines.join("\n")}`;
}
