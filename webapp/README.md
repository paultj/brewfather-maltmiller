# Brew Recipe Maker

A small web app that asks the brewer *"Which beer would you like to brew?"*, designs an all-grain recipe with Claude, shows it for review, and pushes it to Brewfather once you're happy with it.

- **Chat.** Ask Claude to clone a commercial beer, design to a BJCP 2021 style, or build around ingredients you have. Keep chatting to refine the recipe.
- **Inventory aware.** Your Brewfather inventory (fermentables, hops, yeasts, misc) is loaded and given to Claude, which uses what you have where it suits the beer.
- **Review screen.** Grain bill, hop schedule, yeast, water, mash and fermentation steps, plus estimated OG/FG/ABV/IBU/colour. Each ingredient is marked *In stock*, *Partly in stock* or *To buy*, and a "To buy" list is built from that. You can rename the recipe or scale the batch size here.
- **Style ranges.** Each stat is checked against the BJCP 2021 range for the style (bundled data), or against the target ranges Claude states for specialty and non-BJCP styles. Green means in range, red means out. If anything is out, the app sends the numbers back to Claude to adjust once before you see the recipe.
- **Swaps.** Claude suggests up to 4 optional swaps using stock you have that isn't already in the recipe (e.g. leftover Munich for Vienna). Press **Apply** and Claude re-issues the recipe with the swap, adjusting amounts.
- **Push and update.** Nothing goes to Brewfather until you press **Push to Brewfather**, which creates a new recipe. After that the button becomes **Update in Brewfather**, which overwrites that same recipe with your latest changes (including any edits you made in Brewfather). "Save as a new recipe instead" creates a separate one.
- **Water is left to Brewfather.** Claude doesn't prescribe salts, acids or RO water; it just suggests which Brewfather water target profile to use. Pushed recipes carry your water setup (source water report, plus the target profile when the template recipe is the same style) copied from the same recipe as the equipment, so you only need to calculate the salts in Brewfather.
- **Your equipment.** The Brewfather API can't read equipment profiles, so the app copies the equipment from one of your Brewfather recipes (Settings → Copy equipment from; default: most recent recipe). Its efficiency is used for the app's calculations, and the copied equipment goes into every pushed recipe with this recipe's batch size and boil time.

The Malt Miller basket isn't part of this app yet (see the repo root for the earlier Cloudflare Worker experiment).

## Run it locally

Needs Node.js 18.18 or newer.

```bash
cd webapp
npm install
ADMIN_PASSWORD='choose-a-password' npm start
# open http://localhost:3000, sign in, then go to Settings
```

To try the UI with no API keys and no API calls, run in demo mode:

```bash
MOCK=1 ADMIN_PASSWORD=demo npm start
```

### Settings

Open **Settings** after signing in and fill in:

| Setting | Where to get it |
|---|---|
| Anthropic API key | console.anthropic.com → API keys |
| Brewfather user ID and API key | Brewfather → Settings → API → Generate API key. Grant **Read Inventory** and **Edit Recipes** (`inventory.read`, `recipes.write`). |
| Model | Claude Sonnet 5.5 by default; Claude Opus 5.5 is stronger but costs about twice as much. |
| Brewing defaults | Batch size, efficiency and boil time used unless you say otherwise in the chat. |
| Notes for Claude | Equipment, water report, preferences. Sent with every request. |

Use **Test connection** to check the Brewfather key; it also reports how many inventory items are in stock.

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `ADMIN_PASSWORD` | yes | The password for the sign-in page. Nobody can sign in without it. |
| `PORT` | no | Port to listen on (default 3000; cPanel/Passenger sets this for you). |
| `DATA_DIR` | no | Where settings are stored (default `./data`). Must be writable and **not** web-served. |
| `SESSION_SECRET` | no | Signs the login cookie. If unset, one is generated and stored in `DATA_DIR`. |
| `MOCK` | no | `1` for demo mode (canned recipe and inventory, no API calls). |

API keys are stored server-side in `DATA_DIR/settings.json` (file mode 600) and are never sent back to the browser; the Settings page only shows the last four characters.

## Deploy to Kualo (cPanel, Node.js)

1. Upload the `webapp` folder (without `node_modules` or `data`) to a folder **outside** `public_html`, e.g. `~/brew-recipe-maker`.
2. In cPanel open **Setup Node.js App → Create Application**:
   - Node.js version: 18 or newer (20+ preferred)
   - Application root: `brew-recipe-maker`
   - Application URL: the domain/subdomain you want
   - Application startup file: `server.js`
3. Add environment variables in the same screen: `ADMIN_PASSWORD` (a strong one), and optionally `DATA_DIR` (e.g. `/home/<you>/brew-recipe-maker-data`).
4. Click **Run NPM Install**, then **Restart**.
5. Make sure the site is served over HTTPS (AutoSSL), sign in, and fill in Settings.

## How it works

- `server.js`: Express app, login, JSON API.
- `lib/claude.js`: the chat. Claude gets a system prompt with your defaults and inventory, and calls a `propose_recipe` tool (JSON schema in `lib/recipe-schema.js`; the input is validated and Claude is asked to fix any problems) whenever it has a full recipe. Uses the server-side refusal fallback so a declined request is retried on another model.
- `lib/styles.js` + `lib/bjcp-2021.json`: BJCP 2021 style ranges (from [BeerJSON bjcp-json](https://github.com/beerjson/bjcp-json), MIT) and the in/out-of-range check.
- `lib/calc.js`: OG/FG (extract potential × efficiency), IBU (Tinseth, with a temperature-scaled factor for whirlpool hops), colour (Morey), and stock checks against inventory.
- `lib/brewfather.js`: reads inventory (cached for 5 minutes) and creates the recipe with `POST /v2/recipes`. Ingredients matched to inventory carry over Brewfather's own ingredient data.
- The conversation lives only in the browser tab (sessionStorage). Nothing is saved on the server except settings.

## Known limitations

- The estimated stats are this app's calculations. Brewfather may show slightly different numbers, and it isn't documented whether Brewfather recalculates OG/IBU/colour for recipes created through the API. Open the pushed recipe in Brewfather to check.
- Commercial clones rely on Claude's own knowledge (no web search yet).

## Tests

```bash
npm test
```
