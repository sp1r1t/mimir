import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/web/server.js';
import { makeApp, type TestApp } from './helpers.js';

describe('live list versions', () => {
  let t: TestApp;
  afterEach(async () => t.cleanup());

  it('changes the glossary digest when a term is added, and stamps it on the page', async () => {
    t = makeApp();
    const server = buildServer(t.app);
    await server.ready();
    const before = t.app.stories.liveVersions();
    const page = await server.inject({ method: 'GET', url: '/terms' });
    expect(page.body).toContain('data-live="terms"');
    expect(page.body).toContain(`data-live-version="${before.terms}"`);
    t.app.stories.addManualTerm('Cohere');
    const after = t.app.stories.liveVersions();
    expect(after.terms).not.toBe(before.terms);
    expect(after.stories).toBe(before.stories);
    const stories = await server.inject({ method: 'GET', url: '/' });
    expect(stories.body).toContain('data-live="stories"');
    await server.close();
  });
});
