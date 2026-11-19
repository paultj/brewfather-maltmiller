// Outgoing email (password resets) over SMTP. Set the SMTP details in the
// admin page once you have a mailbox; until then, admins hand out reset links.
import nodemailer from "nodemailer";
import { getConfig } from "./users.js";

export function mailConfigured(c = getConfig()) {
  return Boolean(c.smtpHost && c.mailFrom);
}

export async function sendMail({ to, subject, text }) {
  const c = getConfig();
  if (!mailConfigured(c)) throw Object.assign(new Error("Email isn't set up yet."), { status: 503 });
  const transport = nodemailer.createTransport({
    host: c.smtpHost,
    port: c.smtpPort,
    secure: c.smtpSecure,
    auth: c.smtpUser ? { user: c.smtpUser, pass: c.smtpPass } : undefined,
    connectionTimeout: 15_000,
  });
  await transport.sendMail({ from: c.mailFrom, to, subject, text });
}
