import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
  defaultHeaders: {
    'HTTP-Referer': 'https://wallet-agent.local',
    'X-Title': 'Wallet Accountant Agent',
  },
});

const MODEL = process.env.MODEL || 'moonshotai/kimi-k2.5';

export async function categorizeTransaction(tx) {
  const merchantLine = tx.merchantName ? `- Merchant/Contract: ${tx.merchantName}` : '';
  const prompt = `You are a crypto wallet accountant. Categorize this transaction briefly.

Transaction:
- Direction: ${tx.direction} (${tx.direction === 'in' ? 'received' : 'sent'})
- Amount: ${tx.value_eth} ${tx.asset}
- From: ${tx.from_address}
- To: ${tx.to_address}
${merchantLine}
- Category hint: ${tx.category}

Reply with JSON only:
{
  "category": "one of: Gas Fee, DeFi, NFT, Transfer, Swap, Bridge, Contract Interaction, Purchase, Other",
  "summary": "one sentence plain English description, include the merchant name if known"
}`;

  const res = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
  });

  try {
    return JSON.parse(res.choices[0].message.content);
  } catch {
    return { category: tx.category || 'Other', summary: 'Transaction processed.' };
  }
}

export async function generateDailySummary(transactions, walletAddress) {
  if (transactions.length === 0) {
    return 'No transactions today.';
  }

  const txList = transactions.map(tx =>
    `- [${tx.direction.toUpperCase()}] ${tx.value_eth} ${tx.asset} | ${tx.category} | ${tx.summary}`
  ).join('\n');

  const totalIn = transactions
    .filter(t => t.direction === 'in')
    .reduce((sum, t) => sum + (t.value_usd || 0), 0);
  const totalOut = transactions
    .filter(t => t.direction === 'out')
    .reduce((sum, t) => sum + (t.value_usd || 0), 0);

  const prompt = `You are a personal crypto accountant. Write a short, friendly daily wallet report.

Wallet: ${walletAddress}
Transactions today:
${txList}

Total received: $${totalIn.toFixed(2)}
Total spent: $${totalOut.toFixed(2)}

Write a 3-5 sentence summary a non-technical person can understand. Include spending patterns, notable transactions, and any tips.`;

  const res = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
  });

  return res.choices[0].message.content;
}
