// Demo mode (MOCK=1): no API calls. Lets you try the UI without keys.

export const MOCK_INVENTORY = {
  fermentables: [
    { _id: "inv-f1", name: "Extra Pale Maris Otter", supplier: "Crisp", type: "Grain", color: 1.8, potential: 1.037, inventory: 10 },
    { _id: "inv-f2", name: "Flaked Oats", supplier: "Crisp", type: "Adjunct", color: 1, potential: 1.033, inventory: 1.5 },
  ],
  hops: [
    { _id: "inv-h1", name: "Citra", type: "Pellet", alpha: 12.5, year: 2025, inventory: 100 },
    { _id: "inv-h2", name: "Mosaic", type: "Pellet", alpha: 11.8, year: 2025, inventory: 50 },
  ],
  yeasts: [
    { _id: "inv-y1", name: "Pineapple Passion", laboratory: "(demo lab)", productId: "", form: "Dry", attenuation: 78, unit: "pkg", inventory: 1 },
  ],
  miscs: [{ _id: "inv-m1", name: "Calcium Chloride", type: "Water Agent", unit: "g", inventory: 200 }],
};

export const MOCK_RECIPE = {
  name: "Passion Haze",
  description: "A soft, juicy NEIPA built to showcase the tropical character of the yeast, with Citra and Mosaic layered on top.",
  style: { name: "Hazy IPA", bjcp_code: "21C" },
  batch_size_l: 23,
  boil_time_min: 60,
  efficiency_pct: 72,
  fermentables: [
    { name: "Extra Pale Maris Otter", inventory_id: "inv-f1", supplier: "Crisp", type: "Grain", amount_kg: 4.6, potential_sg: 1.037, color_lovibond: 1.8 },
    { name: "Flaked Oats", inventory_id: "inv-f2", supplier: "Crisp", type: "Adjunct", amount_kg: 1.0, potential_sg: 1.033, color_lovibond: 1 },
    { name: "Wheat Malt", inventory_id: "", supplier: "Crisp", type: "Grain", amount_kg: 0.8, potential_sg: 1.037, color_lovibond: 2 },
  ],
  hops: [
    { name: "Citra", inventory_id: "inv-h1", amount_g: 10, alpha_pct: 12.5, use: "Boil", form: "Pellet", time_min: 60, temp_c: 0, dry_hop_day: 0, dry_hop_duration_days: 0 },
    { name: "Citra", inventory_id: "inv-h1", amount_g: 50, alpha_pct: 12.5, use: "Whirlpool", form: "Pellet", time_min: 20, temp_c: 80, dry_hop_day: 0, dry_hop_duration_days: 0 },
    { name: "Mosaic", inventory_id: "inv-h2", amount_g: 50, alpha_pct: 11.8, use: "Whirlpool", form: "Pellet", time_min: 20, temp_c: 80, dry_hop_day: 0, dry_hop_duration_days: 0 },
    { name: "Citra", inventory_id: "inv-h1", amount_g: 75, alpha_pct: 12.5, use: "Dry Hop", form: "Pellet", time_min: 0, temp_c: 0, dry_hop_day: 3, dry_hop_duration_days: 4 },
    { name: "Mosaic", inventory_id: "", amount_g: 75, alpha_pct: 11.8, use: "Dry Hop", form: "Pellet", time_min: 0, temp_c: 0, dry_hop_day: 3, dry_hop_duration_days: 4 },
  ],
  yeasts: [
    { name: "Pineapple Passion", inventory_id: "inv-y1", laboratory: "(demo lab)", product_id: "", type: "Ale", form: "Dry", attenuation_pct: 78, amount: 1, unit: "pkg", min_temp_c: 18, max_temp_c: 22 },
  ],
  miscs: [
    { name: "Calcium Chloride", inventory_id: "inv-m1", amount: 8, unit: "g", use: "Mash", time_min: 0, type: "Water Agent" },
    { name: "Gypsum", inventory_id: "", amount: 3, unit: "g", use: "Mash", time_min: 0, type: "Water Agent" },
  ],
  mash_steps: [{ name: "Saccharification", temp_c: 67, time_min: 60 }],
  fermentation_steps: [
    { name: "Primary", temp_c: 19, days: 3 },
    { name: "Free rise + dry hop", temp_c: 21, days: 7 },
    { name: "Cold crash", temp_c: 2, days: 2 },
  ],
  water_notes: "Aim for roughly 150 ppm chloride and 75 ppm sulphate for a soft, full mouthfeel.",
  notes: "Dry hop during active fermentation at day 3 to limit oxygen pick-up. Package with minimal oxygen exposure.",
};

export function mockChatTurn({ history, text }) {
  const id = `toolu_mock_${Date.now()}`;
  const content = [
    { type: "text", text: "(Demo mode) Here's a NEIPA built around your Pineapple Passion, using the Maris Otter, oats, Citra and Mosaic you have in stock. You'll need to buy wheat malt and some extra Mosaic." },
    { type: "tool_use", id, name: "propose_recipe", input: MOCK_RECIPE },
  ];
  const messages = [...history, { role: "user", content: [{ type: "text", text }] }, { role: "assistant", content }];
  return { history: messages, reply: content[0].text, recipe: MOCK_RECIPE };
}
