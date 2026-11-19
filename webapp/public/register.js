const { $, api, status } = window.Brew;
const token = new URLSearchParams(location.search).get("invite") || "";

(async () => {
  try {
    await api(`/api/invite/${encodeURIComponent(token || "none")}`);
    $("#register-form").classList.remove("hidden");
    $("#email").focus();
  } catch (ex) {
    status($("#invite-problem"), ex.message, false);
  }
})();

$("#register-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#register-error");
  err.classList.add("hidden");
  if ($("#password").value !== $("#password2").value) return status(err, "The two passwords don't match.", false);
  try {
    await api("/api/register", { token, email: $("#email").value, password: $("#password").value });
    location.href = "/settings.html?welcome=1";
  } catch (ex) {
    status(err, ex.message, false);
  }
});
