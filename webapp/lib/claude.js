// The recipe chat. Claude talks with the brewer and, when it has a recipe,
// calls the `propose_recipe` tool. The app shows that recipe for review; it
// is only sent to Brewfather when the brewer presses Push.
import Anthropic from "@anthropic-ai/sdk";
import { RECIPE_SCHEMA, normalizeRecipe } from "./recipe-schema.js";
import { computeStats } from "./calc.js";
import { rangesFor, checkRanges, outOfRangeReport } from "./styles.js";

const TOOL = {
  name: "propose_recipe",
  description:
    "Show a complete recipe to the brewer for review. Call this every time you have a full recipe or a revised version of one; " +
    "the brewer sees it on a review screen with calculated OG/FG/ABV/IBU/colour and stock levels, and decides whether to push it to Brewfather. " +
    "Always send the whole recipe, never a partial update. Fill in every field in the schema.",
  // Not `strict`: the recipe schema is too large for strict-mode grammar
  // compilation. The input is validated in normalizeRecipe() instead, and
  // Claude is asked to fix any problems.
  input_schema: RECIPE_SCHEMA,
};

const SYSTEM_INSTRUCTIONS = `You are an experienced homebrewer and recipe designer helping a UK homebrewer design all-grain beer recipes for Brewfather.

The brewer may ask you to:
- clone a commercial beer (use what you know about the brewery's published specs and ingredients; say how confident you are),
- design a recipe for a chosen BJCP 2021 style,
- build around specific ingredients they want to use.

How to work:
- If something important is genuinely unclear (for example which manufacturer makes a yeast they name and it is not in their inventory), ask one short question before designing. Otherwise make sensible choices and state them.
- Prefer ingredients from the brewer's Brewfather inventory (listed below) whenever they suit the beer. When you use one, set inventory_id to its [id] and use the inventory's alpha acid, colour and potential values. Do not exceed the amount in stock unless you say the rest must be bought.
- Also suggest up to 4 optional swaps (the recipe's "swaps" list) where an inventory item NOT already used in the recipe could reasonably replace one of the recipe's ingredients, e.g. leftover Munich instead of Vienna, or a stocked hop instead of one that must be bought. Only suggest swaps that keep the beer true to the request and style, and say in the reason how the beer changes and any amount adjustment. Never suggest swaps from outside the inventory. An empty list is fine.
- If the brewer asks to apply a swap, re-issue the full recipe with that swap made, adjusting amounts (alpha acid, colour, extract) so the beer stays on target, and drop that swap from the swaps list.
- Ingredients not in inventory should be common products available from UK homebrew shops such as The Malt Miller. Use the full product-style name (maltster + malt, hop variety, yeast manufacturer + strain).
- Every recipe must land inside the style's BJCP 2021 ranges for OG, FG, ABV, IBU and colour, so the brewer doesn't need to edit it in Brewfather. Aim for the middle of each range rather than the edges, because different tools calculate slightly differently. Only go outside a range if the brewer explicitly asks.
- Always fill in target_ranges: the BJCP 2021 ranges for the style, or for a specialty style (e.g. 21B Specialty IPA, 28-34) or a non-BJCP request, the ranges you are designing to.
- The app calculates the stats itself and will tell you if any are out of range: OG/FG from extract potential and the stated efficiency (sugars at 100%), FG from the highest yeast attenuation (lactose/maltodextrin unfermentable), IBU by Tinseth using OG, with whirlpool hops counted at a fraction of Tinseth (about 0.5 at 95°C+, 0.3 at 85-94°C, 0.15 at 75-84°C, 0.05 below; time capped at 45 min) and dry hops at zero, colour by Morey from °L. Design with these methods in mind.
- Use the brewer's defaults for batch size, efficiency and boil time unless they say otherwise.
- Use metric units throughout.
- When you have a recipe, call propose_recipe with the complete recipe, and in your text reply give a brief summary of the key choices (grist idea, hop schedule, yeast handling). Keep replies concise; the review screen shows the full detail, so do not repeat every ingredient in prose.
- When the brewer asks for changes, call propose_recipe again with the full revised recipe.`;

function inventoryBlock(inventory) {
  if (!inventory) return "Brewfather inventory: not available (no Brewfather credentials configured, or it failed to load).";
  const line = (item, extra) => `- [${item._id}] ${item.name}${extra ? ` (${extra})` : ""}: ${item.inventory}`;
  const sections = [
    ["Fermentables (stock in kg)", inventory.fermentables, (f) => [f.supplier, f.type, f.color != null && `${f.color}°L`, f.potential && `potential ${f.potential}`].filter(Boolean).join(", ")],
    ["Hops (stock in g)", inventory.hops, (h) => [h.type, h.alpha != null && `${h.alpha}% AA`, h.year && `crop ${h.year}`].filter(Boolean).join(", ")],
    ["Yeasts (stock in packs or as listed)", inventory.yeasts, (y) => [y.laboratory, y.productId, y.form, y.attenuation && `${y.attenuation}% atten.`, y.unit].filter(Boolean).join(", ")],
    ["Misc", inventory.miscs, (m) => [m.type, m.unit].filter(Boolean).join(", ")],
  ];
  const body = sections
    .map(([title, items, fmt]) => `${title}:\n${items.length ? items.map((i) => line(i, fmt(i))).join("\n") : "- (none)"}`)
    .join("\n\n");
  return `The brewer's Brewfather inventory (items in stock):\n\n${body}`;
}

function defaultsBlock(settings) {
  const notes = settings.brewerNotes?.trim() ? `\nBrewer's notes about their setup and preferences:\n${settings.brewerNotes.trim()}` : "";
  return `Brewer's defaults: batch size ${settings.batchSizeL} L into the fermenter, brewhouse efficiency ${settings.efficiencyPct}%, boil ${settings.boilTimeMin} minutes.${notes}`;
}

/**
 * Run one chat turn.
 * @param history  Prior API messages (as returned by earlier turns).
 * @param text     The brewer's new message.
 * @returns { history, reply, recipe|null }
 */
export async function chatTurn({ settings, inventory, history, text }) {
  if (!settings.anthropicApiKey) {
    throw Object.assign(new Error("Anthropic API key is not set. Add it in Settings."), { status: 400 });
  }
  const client = new Anthropic({ apiKey: settings.anthropicApiKey });

  // If the previous assistant turn proposed a recipe, the tool call needs a
  // result before the next user text.
  const userContent = [];
  const last = history[history.length - 1];
  if (last?.role === "assistant" && Array.isArray(last.content)) {
    for (const block of last.content) {
      if (block.type === "tool_use") {
        userContent.push({ type: "tool_result", tool_use_id: block.id, content: "Recipe shown to the brewer on the review screen." });
      }
    }
  }
  userContent.push({ type: "text", text });
  const messages = [...history, { role: "user", content: userContent }];

  const request = (msgs) =>
    client.beta.messages.create({
      model: settings.model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [
        { type: "text", text: SYSTEM_INSTRUCTIONS },
        { type: "text", text: `${defaultsBlock(settings)}\n\n${inventoryBlock(inventory)}`, cache_control: { type: "ephemeral" } },
      ],
      tools: [TOOL],
      messages: msgs,
    });

  // Ask Claude. If its recipe doesn't validate, send the problems back (up to
  // two retries). If it validates but the app's calculated stats fall outside
  // the style ranges, ask Claude to adjust once.
  let reply = "";
  let recipe = null;
  let response;
  let validationRetries = 0;
  let rangeFixAsked = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    response = await request(messages);

    if (response.stop_reason === "refusal") {
      throw Object.assign(new Error("Claude declined this request. Try rephrasing it."), { status: 422 });
    }

    // Keep the assistant turn exactly as returned (thinking blocks included)
    // so later requests replay the conversation unchanged.
    messages.push({ role: "assistant", content: response.content });

    let toolUse = null;
    for (const block of response.content) {
      if (block.type === "text") reply += (reply ? "\n\n" : "") + block.text;
      if (block.type === "tool_use" && block.name === "propose_recipe") toolUse = block;
    }
    if (!toolUse) break;

    const { recipe: normalized, errors } = normalizeRecipe(toolUse.input);
    if (errors.length) {
      if (validationRetries >= 2) {
        reply += `\n\n(The recipe I produced had problems I couldn't fix: ${errors.join("; ")}. Ask me to try again.)`;
        // Close the tool call so the conversation stays valid.
        messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, is_error: true, content: errors.join("\n") }] });
        messages.push({ role: "assistant", content: [{ type: "text", text: "Sorry, I couldn't produce a valid recipe that time." }] });
        break;
      }
      validationRetries++;
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUse.id,
            is_error: true,
            content: `The recipe was not accepted. Fix these problems and call propose_recipe again with the complete recipe:\n${errors.join("\n")}`,
          },
        ],
      });
      continue;
    }

    recipe = normalized;
    if (rangeFixAsked) break;
    const ranges = rangesFor(recipe);
    const stats = computeStats(recipe);
    const report = outOfRangeReport(stats, ranges, checkRanges(stats, ranges));
    if (!report) break;

    rangeFixAsked = true;
    messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `${report}\n\nAdjust the recipe so every stat is inside its range (aim for the middle), then call propose_recipe again with the complete recipe. Mention the adjustment briefly in your reply.`,
        },
      ],
    });
  }

  if (response.stop_reason === "max_tokens" && !recipe) {
    reply += "\n\n(The reply was cut off. Ask me to continue or to propose the recipe again.)";
  }

  return { history: messages, reply: reply || (recipe ? "Here's the recipe. Have a look at the review panel." : ""), recipe };
}
