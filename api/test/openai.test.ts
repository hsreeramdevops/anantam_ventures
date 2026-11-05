import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { categorizeWithAi } from '../src/ai/categorize';
import { aiCategorize } from '../src/ai/openai';

const reply = (content: string, status = 200) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });

describe('aiCategorize (Azure OpenAI fallback)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    process.env.AZURE_OPENAI_ENDPOINT = 'https://example.openai.azure.com/';
    process.env.AZURE_OPENAI_KEY = 'test-key';
    process.env.AZURE_OPENAI_DEPLOYMENT = 'cat-mini';
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AZURE_OPENAI_ENDPOINT;
    delete process.env.AZURE_OPENAI_KEY;
    delete process.env.AZURE_OPENAI_DEPLOYMENT;
  });

  it('returns a valid category and phase with a tiny deterministic request', async () => {
    fetchMock.mockResolvedValue(reply('{"category":"Hardware","phase":"Finishing"}'));
    expect(await aiCategorize('door closer x2')).toEqual({ category: 'Hardware', phase: 'Finishing' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.openai.azure.com/openai/deployments/cat-mini/chat/completions?api-version=2024-10-21');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ temperature: 0, max_tokens: 40, response_format: { type: 'json_object' } });
    expect(init.headers['api-key']).toBe('test-key');
  });

  it('rejects answers outside the lists', async () => {
    fetchMock.mockResolvedValue(reply('{"category":"Snacks","phase":"Party"}'));
    expect(await aiCategorize('samosa')).toEqual({ category: 'Miscellaneous' });
    fetchMock.mockResolvedValue(reply('not json'));
    expect(await aiCategorize('samosa')).toEqual({ category: 'Miscellaneous' });
  });

  it('fails safe on HTTP errors, network errors and timeouts', async () => {
    fetchMock.mockResolvedValue(new Response('quota', { status: 429 }));
    expect(await aiCategorize('x')).toEqual({ category: 'Miscellaneous' });
    fetchMock.mockRejectedValue(new Error('network'));
    expect(await aiCategorize('x')).toEqual({ category: 'Miscellaneous' });
    fetchMock.mockImplementation((_u: string, init: any) => new Promise((_r, rej) =>
      init.signal.addEventListener('abort', () => rej(init.signal.reason))));
    expect(await aiCategorize('x', 20)).toEqual({ category: 'Miscellaneous' });
  });

  it('is skipped when not configured', async () => {
    delete process.env.AZURE_OPENAI_KEY;
    expect(await aiCategorize('x')).toEqual({ category: 'Miscellaneous' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is only used when keyword rules and vendor default fall through', async () => {
    fetchMock.mockResolvedValue(reply('{"category":"Hardware"}'));
    expect(await categorizeWithAi('UltraTech OPC 53')).toEqual({ category: 'Cement' });
    expect(await categorizeWithAi('anything', 'Transport')).toEqual({ category: 'Transport' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await categorizeWithAi('qwerty item 7')).toEqual({ category: 'Hardware' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
