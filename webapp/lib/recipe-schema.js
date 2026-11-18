// JSON schema for the `propose_recipe` tool. Claude calls this tool whenever it
// has a complete recipe (or a revised one) for the brewer to review.
// All units are metric. Every field is required (strict tool use).

const str = (description) => ({ type: "string", description });
const numb = (description) => ({ type: "number", description });
const enumOf = (values, description) => ({ type: "string", enum: values, description });
const obj = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const arr = (items, description) => ({ type: "array", items, description });

const inventoryId = str(
  "The [id] of the matching item from the brewer's Brewfather inventory list, or an empty string if it is not from inventory.",
);

export const RECIPE_SCHEMA = obj({
  name: str("Recipe name, short and evocative."),
  description: str("Two or three sentences describing the beer and the intent of the recipe."),
  style: obj({
    name: str("BJCP 2021 style name, e.g. 'Hazy IPA'."),
    bjcp_code: str("BJCP 2021 code, e.g. '21C'."),
  }),
  target_ranges: obj({
    og_min: numb("Minimum OG, e.g. 1.060."),
    og_max: numb("Maximum OG."),
    fg_min: numb("Minimum FG."),
    fg_max: numb("Maximum FG."),
    abv_min: numb("Minimum ABV %."),
    abv_max: numb("Maximum ABV %."),
    ibu_min: numb("Minimum IBU."),
    ibu_max: numb("Maximum IBU."),
    srm_min: numb("Minimum colour, SRM."),
    srm_max: numb("Maximum colour, SRM."),
  }),
  batch_size_l: numb("Volume into the fermenter, litres."),
  boil_time_min: numb("Boil length in minutes."),
  efficiency_pct: numb("Brewhouse efficiency used for the grain bill, percent."),
  fermentables: arr(
    obj({
      name: str("Fermentable name, e.g. 'Maris Otter Pale Malt'."),
      inventory_id: inventoryId,
      supplier: str("Maltster, e.g. 'Crisp', or empty string."),
      type: enumOf(["Grain", "Adjunct", "Sugar", "Extract", "Dry Extract"], "Fermentable type."),
      amount_kg: numb("Amount in kilograms."),
      potential_sg: numb("Extract potential as SG points per lb/gal, e.g. 1.037."),
      color_lovibond: numb("Colour in degrees Lovibond."),
    }),
    "Grain bill.",
  ),
  hops: arr(
    obj({
      name: str("Hop variety."),
      inventory_id: inventoryId,
      amount_g: numb("Amount in grams for this addition."),
      alpha_pct: numb("Alpha acid percent (use the inventory value when from inventory)."),
      use: enumOf(["Boil", "First Wort", "Mash", "Whirlpool", "Dry Hop"], "When the hop is added."),
      form: enumOf(["Pellet", "Leaf", "Cryo"], "Hop form."),
      time_min: numb("Boil minutes remaining, or whirlpool/hop-stand duration in minutes. 0 for dry hops."),
      temp_c: numb("Whirlpool temperature in C. 0 if not a whirlpool addition."),
      dry_hop_day: numb("Fermentation day the dry hop is added. 0 if not a dry hop."),
      dry_hop_duration_days: numb("Days the dry hop stays in contact. 0 if not a dry hop."),
    }),
    "Every hop addition, in brewing order.",
  ),
  yeasts: arr(
    obj({
      name: str("Yeast name as sold."),
      inventory_id: inventoryId,
      laboratory: str("Manufacturer, e.g. 'Lallemand'."),
      product_id: str("Manufacturer product code, or empty string."),
      type: enumOf(["Ale", "Lager", "Hybrid", "Wheat", "Wine", "Champagne", "Kveik"], "Yeast type."),
      form: enumOf(["Dry", "Liquid", "Slurry"], "Yeast form."),
      attenuation_pct: numb("Expected apparent attenuation, percent."),
      amount: numb("Amount, in the unit below."),
      unit: enumOf(["pkg", "g", "ml"], "Unit for amount."),
      min_temp_c: numb("Lowest recommended fermentation temperature, C."),
      max_temp_c: numb("Highest recommended fermentation temperature, C."),
    }),
    "Yeast(s).",
  ),
  miscs: arr(
    obj({
      name: str("e.g. 'Gypsum', 'Calcium Chloride', 'Protafloc', 'Yeast nutrient'."),
      inventory_id: inventoryId,
      amount: numb("Amount, in the unit below."),
      unit: enumOf(["g", "ml", "tsp", "items"], "Unit for amount."),
      use: enumOf(["Mash", "Sparge", "Boil", "Flameout", "Fermentation", "Bottling"], "When it is added."),
      time_min: numb("Minutes (boil time remaining for boil additions), else 0."),
      type: enumOf(["Water Agent", "Fining", "Spice", "Flavor", "Herb", "Other"], "Misc type."),
    }),
    "Water salts, finings, nutrients and other additions. Empty array if none.",
  ),
  mash_steps: arr(
    obj({ name: str("Step name."), temp_c: numb("Temperature, C."), time_min: numb("Minutes.") }),
    "Mash schedule.",
  ),
  fermentation_steps: arr(
    obj({ name: str("e.g. 'Primary', 'Free rise', 'Cold crash'."), temp_c: numb("Temperature, C."), days: numb("Days.") }),
    "Fermentation schedule.",
  ),
  water_notes: str("Target water profile / chloride:sulphate guidance, or empty string."),
  notes: str("Brewing tips specific to this recipe (e.g. oxygen pick-up on dry hops), or empty string."),
  swaps: arr(
    obj({
      replace: str("Name of the ingredient in this recipe that could be replaced, exactly as it appears above."),
      with: str("Name of the inventory item to use instead, exactly as in the inventory list."),
      inventory_id: str("The [id] of that inventory item."),
      reason: str(
        "One short sentence: how it changes the beer and any amount adjustment needed, e.g. 'More tropical; use 40 g instead of 50 g for similar bitterness.'",
      ),
    }),
    "Up to 4 optional swaps using items from the brewer's inventory that are NOT already used in this recipe. Empty array if there are no sensible swaps.",
  ),
});

/** Light runtime check on a recipe coming back from the browser. */
export function validateRecipe(r) {
  const errors = [];
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  if (!r || typeof r !== "object") return ["Recipe missing"];
  if (typeof r.name !== "string" || !r.name.trim()) errors.push("name is required");
  if (!r.style || typeof r.style.name !== "string" || typeof r.style.bjcp_code !== "string") errors.push("style is required");
  for (const k of ["batch_size_l", "boil_time_min", "efficiency_pct"]) if (!isNum(r[k]) || r[k] <= 0) errors.push(`${k} must be a positive number`);
  for (const k of ["fermentables", "hops", "yeasts", "miscs", "mash_steps", "fermentation_steps"]) if (!Array.isArray(r[k])) errors.push(`${k} must be a list`);
  if (r.swaps !== undefined && !Array.isArray(r.swaps)) errors.push("swaps must be a list");
  if (errors.length) return errors;
  if (r.fermentables.length === 0) errors.push("at least one fermentable is required");
  if (r.yeasts.length === 0) errors.push("at least one yeast is required");
  r.fermentables.forEach((f, i) => {
    if (!isNum(f.amount_kg) || !isNum(f.potential_sg) || !isNum(f.color_lovibond)) errors.push(`fermentable ${i + 1} has missing numbers`);
  });
  r.hops.forEach((h, i) => {
    if (!isNum(h.amount_g) || !isNum(h.alpha_pct) || !isNum(h.time_min)) errors.push(`hop ${i + 1} has missing numbers`);
  });
  return errors;
}

// Fill in defaults and coerce types so a recipe from Claude (tool input is
// not strictly enforced) matches RECIPE_SCHEMA. Returns problems that
// Claude needs to fix itself (unknown enum values, missing core data).
function coerce(schema, value, path, errors) {
  if (schema.type === "object") {
    const src = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    if (value !== undefined && src !== value) errors.push(`${path} must be an object`);
    const out = {};
    for (const [key, sub] of Object.entries(schema.properties)) {
      out[key] = coerce(sub, src[key], path ? `${path}.${key}` : key, errors);
    }
    return out;
  }
  if (schema.type === "array") {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
      errors.push(`${path} must be a list`);
      return [];
    }
    return value.map((item, i) => coerce(schema.items, item, `${path}[${i}]`, errors));
  }
  if (schema.type === "number") {
    if (value === undefined || value === null || value === "") return 0;
    const n = typeof value === "number" ? value : Number(String(value).replace(/[^0-9.\-]/g, ""));
    if (!Number.isFinite(n)) {
      errors.push(`${path} must be a number`);
      return 0;
    }
    return n;
  }
  // string
  if (value === undefined || value === null) {
    if (schema.enum) errors.push(`${path} is missing (one of: ${schema.enum.join(", ")})`);
    return schema.enum ? schema.enum[0] : "";
  }
  const str = String(value);
  if (schema.enum) {
    const match = schema.enum.find((e) => e.toLowerCase() === str.trim().toLowerCase());
    if (!match) {
      errors.push(`${path} is "${str}" but must be one of: ${schema.enum.join(", ")}`);
      return schema.enum[0];
    }
    return match;
  }
  return str;
}

export function normalizeRecipe(input) {
  const errors = [];
  const recipe = coerce(RECIPE_SCHEMA, input, "", errors);
  if (!errors.length) errors.push(...validateRecipe(recipe));
  return { recipe, errors };
}
