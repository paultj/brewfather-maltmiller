const { $, esc, api, money, topbar, copy, status } = window.Brew;
let data = null;

const date = (iso) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "–");
const monthName = (ym) => new Date(`${ym}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });

function render() {
  const rate = data.config.gbpPerUsd;
  const m = (usd) => money(usd, rate);
  $("#invite-days").textContent = data.inviteDays;
  $("#rate").textContent = rate.toFixed(2);

  // Invites
  $("#invites").innerHTML =
    data.invites
      .map(
        (i) => `<tr>
          <td>${esc(i.note) || '<span class="sub">–</span>'}${i.usedBy ? `<div class="sub">${esc(i.usedBy)}</div>` : ""}</td>
          <td>${date(i.createdAt)}</td>
          <td><span class="badge ${i.status}">${i.status === "open" ? `Open until ${date(i.expiresAt)}` : i.status[0].toUpperCase() + i.status.slice(1)}</span></td>
          <td class="num">${i.status === "open" ? `<button class="btn small" data-revoke="${i.id}">Cancel</button>` : ""}</td>
        </tr>`,
      )
      .join("") || '<tr><td colspan="4" class="sub">No invites yet.</td></tr>';

  // Summary tiles
  const s = data.metrics.summary;
  const tile = (label, value) => `<div class="stat"><div class="label">${label}</div><div class="value" style="font-size:17px">${value}</div></div>`;
  $("#summary").innerHTML = [
    tile("Per user per month", m(s.costPerUserMonthUsd)),
    tile("Per pushed recipe", m(s.costPerPushedUsd)),
    tile("Per recipe started", m(s.costPerStartedUsd)),
    tile("Recipes started per user per month", s.recipesStartedPerUserMonth === null ? "–" : s.recipesStartedPerUserMonth.toFixed(1)),
    tile(`Total since ${monthName(data.metrics.since)}`, m(s.costUsd)),
  ].join("");

  $("#months").innerHTML =
    data.metrics.months
      .map(
        (r) => `<tr>
          <td>${monthName(r.month)}</td>
          <td class="num">${r.activeUsers}</td>
          <td class="num">${r.recipesStarted}</td>
          <td class="num">${r.recipesPushed}${r.recipeUpdates ? ` <span class="sub">+${r.recipeUpdates} updates</span>` : ""}</td>
          <td class="num">${m(r.costUsd)}</td>
          <td class="num">${m(r.costPerUserUsd)}</td>
          <td class="num">${m(r.costPerPushedUsd)}</td>
          <td class="num">${m(r.costPerStartedUsd)}</td>
        </tr>`,
      )
      .join("") || '<tr><td colspan="8" class="sub">No recipes yet.</td></tr>';

  // Users
  $("#users").innerHTML = data.users
    .map((u) => {
      const setup = [u.hasAnthropicKey ? "Claude ✓" : "No Claude key", u.hasBrewfather ? "Brewfather ✓" : "No Brewfather"].join(" · ");
      const actions =
        u.id === data.me
          ? ""
          : `<button class="btn small" data-reset="${u.id}">Reset link</button>
             <button class="btn small" data-disable="${u.id}" data-to="${!u.disabled}">${u.disabled ? "Enable" : "Disable"}</button>
             <button class="btn small danger" data-delete="${u.id}">Delete</button>`;
      return `<tr>
        <td>${esc(u.email)} ${u.isAdmin ? '<span class="badge admin">Admin</span>' : ""} ${u.disabled ? '<span class="badge disabled">Disabled</span>' : ""}
          <div class="sub">Joined ${date(u.createdAt)}</div></td>
        <td class="sub">${setup}</td>
        <td class="num">${m(u.costMonthUsd)}</td>
        <td class="num">${u.startedMonth} / ${u.pushedMonth}</td>
        <td class="num">${m(u.costTotalUsd)}<div class="sub">${u.pushedTotal} pushed</div></td>
        <td>${date(u.lastSeenAt)}</td>
        <td class="num" style="white-space:nowrap">${actions}</td>
      </tr>`;
    })
    .join("");

  // Site settings
  const c = data.config;
  for (const k of ["appUrl", "gbpPerUsd", "smtpHost", "smtpPort", "smtpUser", "mailFrom"]) $(`#${k}`).value = c[k] ?? "";
  $("#smtpSecure").value = String(Boolean(c.smtpSecure));
  $("#smtpPass").value = "";
  $("#smtpPass").placeholder = c.smtpPassSet ? "Saved (leave blank to keep)" : "Not set";
  $("#mail-state").textContent = data.mail
    ? "Email is set up. People can reset their own passwords."
    : "Not set up yet. Until it is, use “Reset link” in the Users list and send the link yourself.";
}

async function load() {
  data = await api("/api/admin/overview");
  render();
}

$("#invite-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const r = await api("/api/admin/invites", { note: $("#invite-note").value });
  $("#invite-link").value = r.link;
  $("#invite-out").classList.remove("hidden");
  $("#invite-note").value = "";
  $("#invite-link").select();
  await load();
});
$("#copy-invite").addEventListener("click", () => copy($("#invite-link"), $("#copy-invite")));
$("#copy-reset").addEventListener("click", () => copy($("#reset-link"), $("#copy-reset")));

document.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const out = $("#users-result");
  try {
    if (b.dataset.revoke) {
      await api(`/api/admin/invites/${b.dataset.revoke}/revoke`, {});
      await load();
    } else if (b.dataset.reset) {
      const u = data.users.find((x) => String(x.id) === b.dataset.reset);
      const r = await api(`/api/admin/users/${b.dataset.reset}/reset-link`, {});
      $("#reset-for").textContent = `Password reset link for ${u.email}:`;
      $("#reset-link").value = r.link;
      $("#reset-out").classList.remove("hidden");
      $("#reset-link").select();
    } else if (b.dataset.disable) {
      await api(`/api/admin/users/${b.dataset.disable}/disable`, { disabled: b.dataset.to === "true" });
      await load();
    } else if (b.dataset.delete) {
      const u = data.users.find((x) => String(x.id) === b.dataset.delete);
      if (!confirm(`Delete ${u.email}? Their settings and usage history are removed. Their Brewfather recipes are not touched.`)) return;
      await api(`/api/admin/users/${b.dataset.delete}/delete`, {});
      await load();
    }
  } catch (ex) {
    status(out, ex.message, false);
  }
});

$("#config-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {};
  for (const k of ["appUrl", "gbpPerUsd", "smtpHost", "smtpPort", "smtpUser", "smtpPass", "mailFrom"]) body[k] = $(`#${k}`).value;
  body.smtpSecure = $("#smtpSecure").value === "true";
  const out = $("#config-result");
  try {
    const r = await api("/api/admin/config", body);
    data.config = r.config;
    data.mail = r.mail;
    render();
    status(out, "Saved.", true);
  } catch (ex) {
    status(out, ex.message, false);
  }
});

$("#test-email").addEventListener("click", async () => {
  const out = $("#config-result");
  status(out, "Sending…", true);
  try {
    const r = await api("/api/admin/test-email", {});
    status(out, `Sent to ${r.to}. Check your inbox (and spam folder).`, true);
  } catch (ex) {
    status(out, `${ex.message} Save the settings first if you just changed them.`, false);
  }
});

topbar();
load().catch((ex) => status($("#users-result"), ex.message, false));
