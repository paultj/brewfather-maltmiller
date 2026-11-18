import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStats, annotateStock } from "../lib/calc.js";
import { toBrewfatherRecipe } from "../lib/brewfather.js";
import { validateRecipe } from "../lib/recipe-schema.js";
import { MOCK_RECIPE, MOCK_INVENTORY } from "../lib/mock.js";

test("stats for the demo NEIPA are in Hazy IPA range", () => {
  const s = computeStats(MOCK_RECIPE);
  assert.ok(s.og > 1.055 && s.og < 1.075, `OG ${s.og}`);
  assert.ok(s.fg > 1.008 && s.fg < 1.018, `FG ${s.fg}`);
  assert.ok(s.ibu > 15 && s.ibu < 60, `IBU ${s.ibu}`);
  assert.ok(s.ebc > 4 && s.ebc < 15, `EBC ${s.ebc}`);
});

test("stock: hops are checked against the total across additions", () => {
  const r = annotateStock(MOCK_RECIPE, MOCK_INVENTORY);
  // Citra: 10 + 50 + 75 = 135 g needed, 100 g in stock
  assert.equal(r.hops[0].stock.status, "partial");
  assert.equal(r.fermentables[0].stock.status, "in_stock");
  assert.equal(r.fermentables[2].stock.status, "to_buy");
  assert.equal(r.yeasts[0].stock.status, "in_stock");
});

test("Brewfather mapping", () => {
  const bf = toBrewfatherRecipe(MOCK_RECIPE, MOCK_INVENTORY);
  assert.equal(bf.batchSize, 23);
  assert.equal(bf.style.categoryNumber, "21");
  assert.equal(bf.style.styleLetter, "C");
  const whirl = bf.hops.find((h) => h.use === "Aroma");
  assert.equal(whirl.temp, 80);
  const dry = bf.hops.find((h) => h.use === "Dry Hop");
  assert.equal(dry.day, 3);
  assert.equal(bf.fermentables[0]._id, "inv-f1");
  assert.equal(bf.fermentables[0].inventory, undefined);
});

test("validation catches a broken recipe", () => {
  assert.deepEqual(validateRecipe(MOCK_RECIPE), []);
  assert.ok(validateRecipe({ ...MOCK_RECIPE, fermentables: [] }).length > 0);
});

test("stock: hop additions without an inventory id still count against stock", () => {
  const r = annotateStock(MOCK_RECIPE, MOCK_INVENTORY);
  // Mosaic: 50 g whirlpool (tagged) + 75 g dry hop (untagged) = 125 g, 50 g in stock
  const mosaicDry = r.hops[4];
  assert.equal(mosaicDry.stock.status, "partial");
  assert.equal(mosaicDry.stock.have, 50);
});

test("swaps: only inventory items not already in the recipe are kept", () => {
  const recipe = {
    ...MOCK_RECIPE,
    swaps: [
      ...MOCK_RECIPE.swaps,
      { replace: "Wheat Malt", with: "Flaked Oats", inventory_id: "inv-f2", reason: "already used" },
      { replace: "Mosaic", with: "Galaxy", inventory_id: "not-in-inventory", reason: "made up" },
    ],
  };
  const r = annotateStock(recipe, MOCK_INVENTORY);
  assert.equal(r.swaps.length, 1);
  assert.equal(r.swaps[0].with, "Torrified Wheat");
  assert.equal(r.swaps[0].have, 1);
  assert.equal(r.swaps[0].unit, "kg");
});

import { normalizeRecipe } from "../lib/recipe-schema.js";

test("normalizeRecipe fills defaults and flags bad enum values", () => {
  const { swaps, notes, ...partial } = MOCK_RECIPE;
  const ok = normalizeRecipe({ ...partial, batch_size_l: "23" });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.recipe.swaps, []);
  assert.equal(ok.recipe.notes, "");
  assert.equal(ok.recipe.batch_size_l, 23);

  const bad = normalizeRecipe({ ...MOCK_RECIPE, hops: [{ ...MOCK_RECIPE.hops[0], use: "hopstand", form: "pellet" }] });
  assert.equal(bad.recipe.hops[0].form, "Pellet");
  assert.ok(bad.errors.some((e) => e.includes("hops[0].use")));
});

import { rangesFor, checkRanges, outOfRangeReport } from "../lib/styles.js";

test("BJCP 2021 ranges are bundled and used for known styles", () => {
  const r = rangesFor(MOCK_RECIPE);
  assert.equal(r.source, "BJCP 2021");
  assert.deepEqual(r.og, [1.06, 1.085]);
  assert.deepEqual(r.ibu, [25, 60]);
  assert.deepEqual(rangesFor({ style: { bjcp_code: "21A" } }).ibu, [40, 70]);
});

test("specialty styles fall back to the recipe's own target ranges", () => {
  const r = rangesFor({ ...MOCK_RECIPE, style: { name: "Black IPA", bjcp_code: "21B" }, target_ranges: { ...MOCK_RECIPE.target_ranges, srm_min: 25, srm_max: 40 } });
  assert.equal(r.source, "Recipe target");
  assert.deepEqual(r.srm, [25, 40]);
});

test("range check flags out-of-range stats and reports them", () => {
  const ranges = rangesFor(MOCK_RECIPE);
  const check = checkRanges({ og: 1.0599, fg: 1.013, abv: 6.2, ibu: 21, srm: 3.8 }, ranges);
  assert.equal(check.og, "in"); // 1.0599 rounds to 1.060
  assert.equal(check.ibu, "out");
  const report = outOfRangeReport({ og: 1.06, fg: 1.013, abv: 6.2, ibu: 21, srm: 3.8 }, ranges, check);
  assert.match(report, /IBU: calculated 21, range 25–60/);
});

test("Brewfather mapping copies equipment and applies the recipe's batch, boil and efficiency", () => {
  const equipment = { name: "Kit", batchSize: 21, boilTime: 60, efficiency: 76.4, mashEfficiency: 80 };
  const bf = toBrewfatherRecipe({ ...MOCK_RECIPE, boil_time_min: 70, efficiency_pct: 76.4 }, MOCK_INVENTORY, equipment);
  assert.equal(bf.equipment.name, "Kit");
  assert.equal(bf.equipment.batchSize, 23);
  assert.equal(bf.equipment.boilTime, 70);
  assert.equal(bf.equipment.calcBoilVolume, true);
  assert.equal(bf.mashEfficiency, 80);
  assert.equal(equipment.batchSize, 21, "source equipment is not mutated");
  assert.equal(bf.fermentables[0].lovibond, 1.8);
  assert.equal(bf.fermentables[0].color, 1.7); // SRM
});

test("FG accounts for mash temperature", () => {
  const cool = computeStats({ ...MOCK_RECIPE, mash_steps: [{ name: "m", temp_c: 65, time_min: 60 }] });
  const hot = computeStats({ ...MOCK_RECIPE, mash_steps: [{ name: "m", temp_c: 68, time_min: 60 }] });
  assert.ok(hot.fg > cool.fg);
});

import { computeIbu } from "../lib/calc.js";

test("IBU matches Brewfather on Paul's NEIPA hop schedule", () => {
  const hop = (name, g, aa, use, time, temp = 0) => ({ name, amount_g: g, alpha_pct: aa, use, time_min: time, temp_c: temp });
  const hops = [
    hop("Magnum", 15, 14, "Boil", 60),
    hop("Citra", 40, 12.5, "Whirlpool", 20, 80),
    hop("Mosaic", 25, 11.2, "Whirlpool", 20, 80),
    hop("Citra", 30, 12.5, "Dry Hop", 0),
  ];
  const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);
  near(computeIbu([hops[0]], 1.07, 23, 70), 20.8, 0.5);
  near(computeIbu([hops[1]], 1.07, 23, 70), 6.2, 0.3);
  near(computeIbu([hops[2]], 1.07, 23, 70), 3.5, 0.3);
  near(computeIbu(hops, 1.07, 23, 70), 31, 1);
});

import { waterFor } from "../lib/brewfather.js";
import { isWaterTreatment } from "../lib/recipe-schema.js";

test("water: source copied, salts dropped, target only for the same style", () => {
  const water = {
    source: { name: "Murphy's report", bicarbonate: 240 },
    target: { name: "Hazy IPA (NEIPA)" },
    settings: { adjustSparge: true },
    mashAdjustments: { calciumSulfate: 0.27 },
    mashPh: 5.6,
  };
  const same = waterFor(MOCK_RECIPE, { water, styleCode: "21C" });
  assert.equal(same.source.name, "Murphy's report");
  assert.equal(same.target.name, "Hazy IPA (NEIPA)");
  assert.equal(same.mashAdjustments, undefined);
  assert.equal(same.mashPh, undefined);
  const other = waterFor({ ...MOCK_RECIPE, style: { name: "Stout", bjcp_code: "15B" } }, { water, styleCode: "21C" });
  assert.equal(other.target, null);
  assert.equal(waterFor(MOCK_RECIPE, null), null);
});

test("water salts and acids are removed from recipes, Campden is kept", () => {
  for (const n of ["Gypsum", "Calcium Chloride", "Epsom Salt", "Lactic Acid 80%", "CRS"]) assert.ok(isWaterTreatment(n), n);
  for (const n of ["Campden tablet", "Protafloc", "Yeast nutrient", "Sodium metabisulphite"]) assert.ok(!isWaterTreatment(n), n);
  const { recipe } = normalizeRecipe({ ...MOCK_RECIPE, miscs: [...MOCK_RECIPE.miscs, { name: "Gypsum", inventory_id: "", amount: 3, unit: "g", use: "Mash", time_min: 0, type: "Water Agent" }] });
  assert.ok(!recipe.miscs.some((m) => m.name === "Gypsum"));
  assert.equal(recipe.miscs.length, MOCK_RECIPE.miscs.length);
});
