import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A fresh data folder for these tests, set before the modules read DATA_DIR.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brew-test-"));
process.env.DATA_DIR = dir;
process.env.ADMIN_PASSWORD = "setup-secret";
fs.writeFileSync(
  path.join(dir, "settings.json"),
  JSON.stringify({ anthropicApiKey: "sk-ant-old-key", brewfatherUserId: "bf-user", brewfatherApiKey: "bf-key", batchSizeL: 21 }),
);

const db = await import("../lib/db.js");
const users = await import("../lib/users.js");
const usage = await import("../lib/usage.js");
const secrets = await import("../lib/secrets.js");

before(() => db.openDb(":memory:"));

test("passwords hash and verify", () => {
  const h = secrets.hashPassword("correct horse battery");
  assert.ok(secrets.verifyPassword("correct horse battery", h));
  assert.ok(!secrets.verifyPassword("wrong", h));
  assert.match(secrets.passwordProblem("short"), /at least 10/);
});

test("encrypt round-trips and isn't plain text", () => {
  const e = secrets.encrypt("sk-ant-secret");
  assert.ok(!e.includes("secret"));
  assert.equal(secrets.decrypt(e), "sk-ant-secret");
});

test("first admin setup needs ADMIN_PASSWORD and moves the old settings in", () => {
  assert.throws(() => users.setupFirstAdmin({ setupPassword: "nope", email: "paul@example.com", password: "a-good-password" }), /wrong/);
  const { user, migrated } = users.setupFirstAdmin({ setupPassword: "setup-secret", email: "Paul@Example.com", password: "a-good-password" });
  assert.ok(migrated);
  assert.equal(user.email, "paul@example.com");
  assert.equal(user.is_admin, 1);
  const s = users.getSettings(user.id);
  assert.equal(s.anthropicApiKey, "sk-ant-old-key");
  assert.equal(s.batchSizeL, 21);
  // Stored encrypted, and the plain settings.json is gone.
  const raw = db.getDb().prepare("SELECT settings FROM users WHERE id = ?").get(user.id).settings;
  assert.ok(!raw.includes("sk-ant-old-key"));
  assert.ok(!fs.existsSync(path.join(dir, "settings.json")));
  assert.ok(!fs.readFileSync(path.join(dir, "settings.json.migrated"), "utf8").includes("sk-ant-old-key"));
  // Only once.
  assert.throws(() => users.setupFirstAdmin({ setupPassword: "setup-secret", email: "x@example.com", password: "a-good-password" }), /already/);
});

test("invites work once, and sign-up gets default settings with no keys", () => {
  const admin = users.findUserByEmail("paul@example.com");
  const { token } = users.createInvite({ createdBy: admin.id, note: "Dave" });
  assert.equal(users.inviteProblem(token), null);
  const dave = users.registerWithInvite({ token, email: "dave@example.com", password: "daves-password" });
  assert.equal(dave.is_admin, 0);
  assert.equal(users.getSettings(dave.id).anthropicApiKey, "");
  assert.match(users.inviteProblem(token), /already been used/);
  assert.throws(() => users.registerWithInvite({ token, email: "eve@example.com", password: "eves-password1" }), /already been used/);
  assert.match(users.inviteProblem("made-up"), /isn't valid/);
  const list = users.listInvites();
  assert.equal(list[0].status, "used");
  assert.equal(list[0].usedBy, "dave@example.com");
});

test("a failed sign-up (email taken) doesn't use up the invite", () => {
  const admin = users.findUserByEmail("paul@example.com");
  const { token } = users.createInvite({ createdBy: admin.id });
  assert.throws(() => users.registerWithInvite({ token, email: "dave@example.com", password: "another-pass" }), /already an account/);
  assert.equal(users.inviteProblem(token), null);
});

test("login, settings per user, and password reset", () => {
  assert.equal(users.authenticate("dave@example.com", "wrong-password"), null);
  assert.equal(users.authenticate("nobody@example.com", "whatever-pass"), null);
  const dave = users.authenticate("DAVE@example.com", "daves-password");
  assert.ok(dave);
  users.updateUserSettings(dave.id, { anthropicApiKey: "sk-dave", model: "claude-opus-5-5", batchSizeL: 19 });
  assert.equal(users.getSettings(dave.id).anthropicApiKey, "sk-dave");
  assert.equal(users.getSettings(users.findUserByEmail("paul@example.com").id).anthropicApiKey, "sk-ant-old-key");
  // Unknown models are ignored.
  users.updateUserSettings(dave.id, { model: "gpt-something" });
  assert.equal(users.getSettings(dave.id).model, "claude-opus-5-5");

  const token = users.createPasswordReset(dave.id);
  const after = users.resetPassword(token, "daves-new-password");
  assert.equal(after.session_version, dave.session_version + 1);
  assert.ok(users.authenticate("dave@example.com", "daves-new-password"));
  assert.match(users.resetProblem(token), /isn't valid/);
});

test("usage: cost from tokens, and the admin metrics", () => {
  const paul = users.findUserByEmail("paul@example.com");
  const dave = users.findUserByEmail("dave@example.com");
  const u = usage.responseUsage({
    model: "claude-sonnet-5-5",
    usage: { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 0 },
  });
  // 1000*2 + 2000*10 + 10000*0.1 = 23000 per million
  assert.ok(Math.abs(u.cost - 0.023) < 1e-9);

  // Paul: one conversation of 2 turns that was pushed, then updated once.
  usage.recordChat(paul.id, "conv-a", u);
  usage.recordChat(paul.id, "conv-a", u);
  usage.recordPush(paul.id, "conv-a", { recipeName: "NEIPA", brewfatherId: "bf1", created: true });
  usage.recordPush(paul.id, "conv-a", { recipeName: "NEIPA", brewfatherId: "bf1", created: false });
  // Dave: one conversation abandoned, one pushed.
  usage.recordChat(dave.id, "conv-b", u);
  usage.recordChat(dave.id, "conv-c", u);
  usage.recordPush(dave.id, "conv-c", { recipeName: "Stout", brewfatherId: "bf2", created: true });

  const m = usage.metrics();
  const month = m.months[0];
  assert.equal(month.activeUsers, 2);
  assert.equal(month.recipesStarted, 3);
  assert.equal(month.recipesPushed, 2);
  assert.equal(month.recipeUpdates, 1);
  assert.ok(Math.abs(month.costUsd - 0.092) < 1e-9);
  assert.ok(Math.abs(month.costPerUserUsd - 0.046) < 1e-9);
  // Pushed recipes: conv-a (2 turns) + conv-c (1 turn) = 0.069 over 2 recipes.
  assert.ok(Math.abs(month.costPerPushedUsd - 0.0345) < 1e-9);
  assert.ok(Math.abs(m.summary.costPerUserMonthUsd - 0.046) < 1e-9);

  const mine = usage.userUsage(dave.id);
  assert.equal(mine.month.started, 2);
  assert.equal(mine.month.pushed, 1);
});

test("fallback responses are priced per model", () => {
  const u = usage.responseUsage({
    model: "claude-sonnet-5",
    usage: {
      input_tokens: 2000,
      output_tokens: 1000,
      iterations: [
        { type: "message", model: "claude-sonnet-5-5", input_tokens: 1000, output_tokens: 0 },
        { type: "fallback_message", model: "claude-sonnet-5", input_tokens: 1000, output_tokens: 1000 },
      ],
    },
  });
  assert.ok(Math.abs(u.cost - (1000 * 2 + 1000 * 2 + 1000 * 10) / 1e6) < 1e-12);
});

test("deleting a user removes their usage", () => {
  const dave = users.findUserByEmail("dave@example.com");
  users.deleteUser(dave.id);
  assert.equal(users.findUserByEmail("dave@example.com"), null);
  assert.equal(db.getDb().prepare("SELECT COUNT(*) AS n FROM usage WHERE user_id = ?").get(dave.id).n, 0);
});
