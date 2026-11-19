// Helpers shared by the pages.
window.Brew = (() => {
  const $ = (sel) => document.querySelector(sel);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  async function api(path, body) {
    const res = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && !["/api/login", "/api/setup"].includes(path)) {
      location.href = "/login";
      throw new Error("Signed out");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.details = data.details;
      throw err;
    }
    return data;
  }

  /** "42p ($0.553)" or "£1.20 ($1.58)". Returns HTML. */
  function money(usd, gbpPerUsd) {
    if (usd === null || usd === undefined) return "–";
    if (usd === 0) return "£0";
    const gbp = usd * gbpPerUsd;
    const g = gbp < 1 ? `${(gbp * 100).toFixed(gbp < 0.1 ? 1 : 0)}p` : `£${gbp.toFixed(2)}`;
    return `${g} <span class="sub">($${usd.toFixed(usd < 1 ? 3 : 2)})</span>`;
  }

  /** Shows the signed-in email and, for admins, the Admin link in the top bar. */
  async function topbar() {
    $("#logout")?.addEventListener("click", async () => {
      await fetch("/api/logout", { method: "POST" });
      try {
        sessionStorage.clear(); // the recipe chat in this tab
      } catch {
        // ignore
      }
      location.href = "/login";
    });
    try {
      const me = await api("/api/me");
      const email = $("#user-email");
      if (email) email.textContent = me.user.email;
      if (me.user.isAdmin) $("#admin-link")?.classList.remove("hidden");
      return me;
    } catch {
      return null;
    }
  }

  async function copy(input, button) {
    input.select();
    try {
      await navigator.clipboard.writeText(input.value);
      const old = button.textContent;
      button.textContent = "Copied";
      setTimeout(() => (button.textContent = old), 1500);
    } catch {
      // Clipboard blocked: the text is selected so it can be copied by hand.
    }
  }

  /** Show a message in a .status element. */
  function status(el, text, ok) {
    el.textContent = text;
    el.className = `status ${ok ? "ok" : "bad"}`;
  }

  return { $, esc, api, money, topbar, copy, status };
})();
