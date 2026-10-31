import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/web/server.js';
import type { Encyclopedia, TermArticle } from '../src/terms/wikipedia.js';
import { makeApp, type TestApp } from './helpers.js';

class Wiki implements Encyclopedia {
  async lookup(name: string): Promise<TermArticle | null> {
    return name === 'Cohere'
      ? { title: 'Cohere', description: 'Canadian AI company', extract: 'Cohere is a Canadian AI company. It builds models.', url: 'https://en.wikipedia.org/wiki/Cohere' }
      : null;
  }
}

describe('adding a selected term to the glossary', () => {
  let t: TestApp;
  afterEach(async () => t.cleanup());

  it('files and explains the term, keeps it, and rejects an empty selection', async () => {
    t = makeApp({ wikipedia: new Wiki() });
    const server = buildServer(t.app);
    await server.ready();
    const bad = await server.inject({ method: 'POST', url: '/api/terms', payload: { name: ' ' } });
    expect(bad.statusCode).toBe(400);
    const res = await server.inject({ method: 'POST', url: '/api/terms', payload: { name: 'Cohere', context: 'Cohere raised money.' } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ key: 'cohere', status: 'explained', sourceName: 'Wikipedia' });
    expect(t.app.stories.termByKey('cohere')?.summary).toContain('Canadian');
    const again = await server.inject({ method: 'POST', url: '/api/terms', payload: { name: 'cohere' } });
    expect(again.statusCode).toBe(200);
    expect(again.json().created).toBe(false);
    await server.close();
  });
});
