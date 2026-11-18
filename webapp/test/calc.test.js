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
