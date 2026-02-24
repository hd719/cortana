import { execFileSync } from 'node:child_process';

function extractUrls(text) {
  if (!text) return [];
  const re = /https?:\/\/[^\s)\]}>"']+/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[0]);
  return [...new Set(out)];
}

function looksNewsletter(t = {}) {
  const from = (t.from || '').toLowerCase();
  const labels = (t.labels || []).map((x) => String(x).toUpperCase());
  return (
    labels.includes('CATEGORY_UPDATES') ||
    from.includes('substack') ||
    from.includes('newsletter') ||
    from.includes('morningbrew') ||
    from.includes('tldr') ||
    from.includes('cooperpress')
  );
}

function main() {
  const q = process.env.GMAIL_QUERY || 'is:unread';
  const max = Number(process.env.GMAIL_MAX || 25);
  const account = process.env.GOG_ACCOUNT || 'hameldesai3@gmail.com';

  const raw = execFileSync(
    'gog',
    ['--account', account, 'gmail', 'search', q, '--max', String(max), '--json'],
    { encoding: 'utf8' }
  );

  const parsed = JSON.parse(raw);
  const threads = parsed.threads || [];

  const messages = threads.map((t) => ({
    id: t.id,
    threadId: t.id,
    from: t.from || '',
    subject: t.subject || '',
    date: t.date || '',
    listId: looksNewsletter(t) ? 'newsletter-like' : '',
    listUnsubscribe: '',
    snippet: '',
    urls: extractUrls(`${t.subject || ''} ${t.from || ''}`),
    gmailUrl: `https://mail.google.com/mail/u/0/#inbox/${t.id}`,
  }));

  console.log(JSON.stringify({ query: q, count: messages.length, messages }, null, 2));
}

try {
  main();
} catch (e) {
  console.error(e?.stderr || e?.message || e);
  process.exit(1);
}
