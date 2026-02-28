#!/usr/bin/env npx tsx

async function fetchJson(url: string) {
  const res = await fetch(url, { headers: { 'user-agent': 'openclaw-stock-analysis' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchQuoteYahoo(symbol: string) {
  const payload: any = await fetchJson(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`);
  const result = payload?.quoteResponse?.result ?? [];
  if (!result.length) throw new Error(`No quote data for ${symbol}`);
  const q = result[0];
  const price = q.regularMarketPrice;
  if (price == null) throw new Error(`Missing regularMarketPrice for ${symbol}`);
  const cp = q.regularMarketChangePercent;
  let signal = 'neutral';
  if (typeof cp === 'number' && cp >= 1.5) signal = 'bullish';
  if (typeof cp === 'number' && cp <= -1.5) signal = 'bearish';
  return { symbol: symbol.toUpperCase(), price, change_percent: typeof cp === 'number' ? Math.round(cp * 1000) / 1000 : null, signal, currency: q.currency, as_of: q.regularMarketTime, source: 'yahoo' };
}

async function fetchQuoteStooq(symbol: string) {
  const stooqSymbol = `${symbol.toLowerCase()}.us`;
  const res = await fetch(`https://stooq.com/q/l/?s=${stooqSymbol}&i=d`);
  const text = (await res.text()).trim();
  const row = text.split(/\r?\n/).filter(Boolean)[0]?.split(',').map((x) => x.trim()) ?? [];
  if (row.length < 7 || !row[6] || row[6] === 'N/D' || row[6] === '-') throw new Error(`Invalid stooq close for ${symbol}`);
  return { symbol: symbol.toUpperCase(), price: Number(row[6]), change_percent: null, signal: 'neutral', currency: 'USD', as_of: row[1], source: 'stooq' };
}

async function fetchQuote(symbol: string) { try { return await fetchQuoteYahoo(symbol); } catch { return fetchQuoteStooq(symbol); } }

async function main() {
  const args = process.argv.slice(2);
  if (args[0] !== 'analyze' || !args[1]) { console.error('Usage: main.ts analyze <symbol> [--json]'); process.exit(1); }
  const symbol = args[1];
  const asJson = args.includes('--json');
  try {
    const data = await fetchQuote(symbol);
    console.log(asJson ? JSON.stringify(data) : data);
  } catch (e: any) {
    const err = { error: String(e?.message ?? e), symbol: symbol.toUpperCase() };
    console.log(JSON.stringify(err));
    process.exit(1);
  }
}
main().catch((e) => { console.error(String(e)); process.exit(1); });
