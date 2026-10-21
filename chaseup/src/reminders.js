export const toneFor = (daysOverdue) =>
  daysOverdue <= 0 ? 'friendly' : daysOverdue <= 14 ? 'firm' : 'final';

export function formatMoney(minor, currency) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(minor / 100);
}

export function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86400000);
}

export function templateDraft({ user, client, invoice, daysOverdue }) {
  const tone = toneFor(daysOverdue);
  const amount = formatMoney(invoice.amount_minor, user.currency);
  const ref = `invoice ${invoice.number} (${amount})`;
  const sign = `Regards,\n${user.name}\n${user.business_name}`;
  const hi = `Hi ${client.name},`;
  const bodies = {
    friendly: `${hi}\n\nA quick reminder that ${ref} is due on ${invoice.due_on}. Please let me know if you need anything from my side to process it.\n\n${sign}`,
    firm: `${hi}\n\n${ref} was due on ${invoice.due_on} and is now ${daysOverdue} day(s) overdue. Could you confirm when payment will be made?\n\n${sign}`,
    final: `${hi}\n\nThis is a final reminder: ${ref} is ${daysOverdue} days overdue. Please arrange payment immediately or contact me today so we can resolve this.\n\n${sign}`,
  };
  const subjects = {
    friendly: `Reminder: invoice ${invoice.number} due ${invoice.due_on}`,
    firm: `Overdue: invoice ${invoice.number}`,
    final: `Final notice: invoice ${invoice.number}`,
  };
  return { tone, subject: subjects[tone], body: bodies[tone], source: 'template' };
}

// Optional AI polish. Falls back to the template on any failure so the feature never blocks.
export async function draftReminder(ctx, { apiKey = process.env.ANTHROPIC_API_KEY, fetchImpl = fetch } = {}) {
  const base = templateDraft(ctx);
  if (!apiKey) return base;
  try {
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: process.env.CHASEUP_MODEL || 'claude-sonnet-5-5',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: `Rewrite this payment reminder email so it sounds natural and keeps a ${base.tone} tone. Keep every fact (names, amount, invoice number, dates) unchanged. Reply with only the email body.\n\n${base.body}`,
        }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return base;
    const data = await res.json();
    const text = data?.content?.[0]?.text?.trim();
    return text ? { ...base, body: text, source: 'ai' } : base;
  } catch {
    return base;
  }
}
