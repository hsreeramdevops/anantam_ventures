import { config } from '../config';
import { CATEGORIES, PHASES } from '../schema';

type Category = (typeof CATEGORIES)[number];
type Phase = (typeof PHASES)[number];
export interface AiCategory { category: Category; phase?: Phase }

const API_VERSION = '2024-10-21';
export const openAiConfigured = () => !!(config.openAiEndpoint && config.openAiKey && config.openAiDeployment);

const SYSTEM = `You classify Indian construction-company bills. Reply ONLY with JSON {"category":"...","phase":"..."}.
category must be exactly one of: ${CATEGORIES.join(' | ')}.
phase must be exactly one of: ${PHASES.join(' | ')}.
If unsure use "Miscellaneous" and "General".`;

/**
 * Asks a small Azure OpenAI chat model for a category (and phase) when keyword rules can't decide.
 * Never throws: missing config, errors, timeouts or invalid answers all yield 'Miscellaneous' / no phase.
 */
export async function aiCategorize(text: string, timeoutMs = 10_000): Promise<AiCategory> {
  const fallback: AiCategory = { category: 'Miscellaneous' };
  if (!openAiConfigured() || !text.trim()) return fallback;
  const url = `${config.openAiEndpoint}/openai/deployments/${encodeURIComponent(config.openAiDeployment)}/chat/completions?api-version=${API_VERSION}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'api-key': config.openAiKey, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: text.slice(0, 1500) }],
        temperature: 0,
        max_tokens: 40,
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) return fallback;
    const body: any = await res.json();
    const out = JSON.parse(body?.choices?.[0]?.message?.content ?? '{}');
    const category = (CATEGORIES as readonly string[]).includes(out?.category) ? (out.category as Category) : 'Miscellaneous';
    const phase = (PHASES as readonly string[]).includes(out?.phase) ? (out.phase as Phase) : undefined;
    return phase ? { category, phase } : { category };
  } catch {
    return fallback;
  }
}
