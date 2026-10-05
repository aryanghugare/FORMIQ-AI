export type MailMessage = {
  from: string;
  to: string[];
  subject: string;
  text: string;
};
export type SmtpOptions = {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  auth: { user: string; pass: string };
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
  disableFileAccess: boolean;
  disableUrlAccess: boolean;
};
type Transport = { sendMail(message: MailMessage): Promise<unknown> };

// Keep the transport boundary injectable for tests; production uses Nodemailer.
export const smtpMailer = {
  createTransport(options: SmtpOptions): Transport {
    const nodemailer = require("nodemailer") as {
      createTransport(options: SmtpOptions): Transport;
    };
    return nodemailer.createTransport(options);
  },
};

export function smtpSettings() {
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASSWORD;
  const from = process.env.PASSWORD_RESET_FROM?.trim() || user;
  const port = Number(process.env.SMTP_PORT?.trim() || "587");
  const secure =
    process.env.SMTP_SECURE === "true" ||
    (!process.env.SMTP_SECURE && port === 465);
  if (
    !host ||
    !user ||
    !pass ||
    !from ||
    /[\r\n]/.test(from) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    (process.env.SMTP_SECURE &&
      !["true", "false"].includes(process.env.SMTP_SECURE)) ||
    (port === 465 && !secure) ||
    (port === 587 && secure)
  )
    return;
  return {
    from,
    options: {
      host,
      port,
      secure,
      requireTLS: !secure,
      auth: { user, pass },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
      disableFileAccess: true,
      disableUrlAccess: true,
    } satisfies SmtpOptions,
  };
}
