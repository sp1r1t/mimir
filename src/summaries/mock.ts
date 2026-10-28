import type { PlaceName } from '../places/schema.js';
import { sleep } from '../util/backoff.js';
import {
  SummaryProviderError,
  type CapacityDecision,
  type GenerationRequest,
  type GenerationResult,
  type ProviderErrorKind,
  type SummaryProvider,
} from './provider.js';

export type MockMode = 'ok' | 'invalid' | ProviderErrorKind;

/**
 * Offline provider for development and tests. In 'ok' mode it builds a schema-valid brief
 * from the articles in the prompt (headlines only, cited correctly), and names the places
 * it was given; other modes fail the way a real provider would.
 */
export class MockSummaryProvider implements SummaryProvider {
  readonly name = 'mock';
  readonly model = 'mock-summary-1';
  calls = 0;
  configured = true;

  constructor(
    public mode: MockMode = 'ok',
    private readonly delayMs = 0,
    private readonly places: PlaceName[] = [],
  ) {}

  isConfigured(): boolean {
    return this.configured;
  }

  configurationHint(): string | null {
    return this.configured ? null : 'mock provider off';
  }

  async capacity(): Promise<CapacityDecision> {
    return this.mode === 'quota' ? { ok: false, reason: 'Mock allowance exhausted', retryAt: new Date(Date.now() + 3_600_000).toISOString() } : { ok: true };
  }

  allowance(): null {
    return null;
  }

  async generate(req: GenerationRequest, signal?: AbortSignal): Promise<GenerationResult> {
    this.calls++;
    if (this.delayMs) await sleep(this.delayMs);
    if (signal?.aborted) throw new SummaryProviderError('aborted', 'unavailable');
    if (this.mode === 'invalid') return this.result('{"headline": "Missing everything else"}');
    if (this.mode !== 'ok') throw new SummaryProviderError(`Mock provider failure (${this.mode})`, this.mode, this.mode === 'rate_limited' ? 1000 : null);
    const input = JSON.parse(req.user) as {
      story: { headline: string };
      previous_brief?: { headline: string };
      articles: { id: number; title: string; source: string; new_since_last_brief?: boolean }[];
    };
    const [first, ...rest] = input.articles;
    const fresh = rest.filter((a) => a.new_since_last_brief);
    const summary = {
      headline: input.story.headline,
      gist: [{ text: `${first!.source} reported: ${first!.title}`, status: 'reported', sources: [first!.id] }],
      new_since: fresh.slice(0, 5).map((a) => ({ text: `${a.source}: ${a.title}`, status: 'reported', sources: [a.id] })),
      key_developments: rest.slice(0, 6).map((a) => ({ text: `${a.source}: ${a.title}`, status: 'reported', sources: [a.id] })),
      context_significance: [],
      perspectives: [],
      whats_next: [],
      places: first
        ? this.places.map((p) => ({
            name: p.name,
            kind: p.kind,
            country: p.country ?? null,
            country_code: p.countryCode ?? null,
            query: p.query ?? p.name,
            role: p.role ?? null,
            sources: [first.id],
          }))
        : [],
    };
    return this.result(JSON.stringify(summary));
  }

  private result(text: string): GenerationResult {
    return { text, model: this.model, usage: { inputTokens: 100, outputTokens: 50 }, durationMs: this.delayMs };
  }
}
