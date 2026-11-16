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
