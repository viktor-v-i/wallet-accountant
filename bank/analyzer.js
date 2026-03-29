import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
  defaultHeaders: {
    'HTTP-Referer': 'https://bank-agent.local',
    'X-Title': 'Bank Accountant Agent',
  },
});

const MODEL = process.env.MODEL || 'moonshotai/kimi-k2.5';

// ─── SPENDING CRITERIA ────────────────────────────────────────────────────────
// Edit this block to define what counts as acceptable, questionable, or wasteful.
// This is injected verbatim into every AI analysis prompt.
const SPENDING_CRITERIA = `
- acceptable: necessary expenses (rent, groceries, utilities, transport, health, work tools, subscriptions you use regularly)
- questionable: discretionary spending that may or may not be justified (eating out, entertainment, one-off purchases)
- wasteful: clear overspending, impulse purchases, duplicate subscriptions, luxuries with no clear value
`;
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORIES = [
  'Groceries',
  'Eating Out',
  'Transport',
  'Subscriptions',
  'Shopping',
  'Entertainment',
  'Health',
  'Rent & Housing',
  'Salary & Income',
  'Transfer',
  'ATM & Cash',
  'Fees & Interest',
  'Other',
];

export async function analyzeTransaction(tx) {
  const prompt = `You are a strict personal finance accountant. Analyze this bank transaction.

Transaction:
- Date: ${tx.date}
- Amount: ${tx.amount_sek} SEK (${tx.direction === 'out' ? 'outgoing' : 'incoming'})
- Description: ${tx.description || 'N/A'}
- Name/Merchant hint: ${tx.name || 'N/A'}

Spending criteria:
${SPENDING_CRITERIA}

Categories to choose from:
${CATEGORIES.join(', ')}

Reply with JSON only — no markdown, no explanation:
{
  "category": "<one of the categories above>",
  "tag": "<acceptable|questionable|wasteful>",
  "summary": "<one sentence plain English description of what this is>"
}

For incoming transactions (salary, transfers in), always use tag "acceptable".`;

  const res = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
  });

  try {
    const result = JSON.parse(res.choices[0].message.content);
    return {
      category: result.category || 'Other',
      tag: result.tag || 'acceptable',
      summary: result.summary || '',
    };
  } catch {
    return { category: 'Other', tag: 'acceptable', summary: '' };
  }
}

export async function generateSummary(transactions, periodLabel) {
  if (transactions.length === 0) return `No transactions for ${periodLabel}.`;

  const outgoing = transactions.filter(t => t.direction === 'out');
  const incoming = transactions.filter(t => t.direction === 'in');
  const totalOut = outgoing.reduce((s, t) => s + Math.abs(parseFloat(t.amount_sek)), 0);
  const totalIn = incoming.reduce((s, t) => s + Math.abs(parseFloat(t.amount_sek)), 0);

  const wasteful = outgoing.filter(t => t.tag === 'wasteful');
  const questionable = outgoing.filter(t => t.tag === 'questionable');

  const txLines = outgoing.slice(0, 20).map(t =>
    `- ${t.date} | ${Math.abs(t.amount_sek)} SEK | ${t.category} | ${t.tag} | ${t.description}`
  ).join('\n');

  const prompt = `You are a personal finance coach. Write a short, direct summary of this person's spending for ${periodLabel}.

Transactions:
${txLines}

Total spent: ${totalOut.toFixed(2)} SEK
Total received: ${totalIn.toFixed(2)} SEK
Wasteful transactions: ${wasteful.length}
Questionable transactions: ${questionable.length}

Write 3-5 sentences. Be honest and direct. Point out patterns, flag concerns, give one actionable tip.`;

  const res = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
  });

  return res.choices[0].message.content;
}
