export const MAIL_TIMEOUT_MS = 10_000;

export function mailTransport(env: Record<string, string | undefined>): 'resend' | 'smtp' {
  return env.RESEND_API_KEY?.trim() ? 'resend' : 'smtp';
}

/** Fixed errors only: provider bodies can contain credentials or message content. */
export async function sendEmail(message: { from: string; to: string[]; subject: string; text: string }): Promise<{ messageId?: string }> {
  const env = process.env;
  const transport = mailTransport(env);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let close: (() => void) | undefined;
  try {
    return await Promise.race([
      (async () => {
        if (transport === 'resend') {
          const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${env.RESEND_API_KEY!.trim()}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(message),
            signal: controller.signal,
          });
          if (!response.ok) throw new Error('provider rejected');
          const data = await response.json() as { id?: unknown };
          if (typeof data.id !== 'string' || !data.id) throw new Error('invalid response');
          return { messageId: data.id };
        }
        if (!env.DIGEST_SMTP_HOST?.trim()) throw new Error('not configured');
        const nodemailer = (await import('nodemailer')).default;
        const rawPort = Number(env.DIGEST_SMTP_PORT);
        const port = Number.isInteger(rawPort) && rawPort > 0 && rawPort <= 65535 ? rawPort : 587;
        const transporter = nodemailer.createTransport({
          host: env.DIGEST_SMTP_HOST.trim(), port, secure: port === 465,
          auth: env.DIGEST_SMTP_USER ? { user: env.DIGEST_SMTP_USER, pass: env.DIGEST_SMTP_PASS } : undefined,
          connectionTimeout: MAIL_TIMEOUT_MS, greetingTimeout: MAIL_TIMEOUT_MS, socketTimeout: MAIL_TIMEOUT_MS,
        });
        close = () => transporter.close();
        const info = await transporter.sendMail(message);
        return { messageId: info.messageId };
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, MAIL_TIMEOUT_MS);
      }),
    ]);
  } catch {
    throw new Error(`${transport === 'resend' ? 'Resend' : 'SMTP'} email delivery failed`);
  } finally {
    clearTimeout(timer);
    try { close?.(); } catch { /* Delivery outcome must not expose transport internals. */ }
  }
}

export async function sendAccountEmail(to: string, subject: string, text: string): Promise<void> {
  const from = process.env.EMAIL_FROM?.trim() || process.env.DIGEST_EMAIL_FROM?.trim() || process.env.DIGEST_SMTP_FROM?.trim();
  if (!from || (!process.env.RESEND_API_KEY?.trim() && (!process.env.DIGEST_SMTP_HOST?.trim()
    || Boolean(process.env.DIGEST_SMTP_USER?.trim()) !== Boolean(process.env.DIGEST_SMTP_PASS?.trim())))) {
    throw new Error('Account email not configured');
  }
  await sendEmail({ from, to: [to], subject, text });
}