import type { PlaceName } from './schema.js';
import { sleep } from '../util/backoff.js';
import {
  SummaryProviderError,
  type CapacityDecision,
  type GenerationRequest,
  type GenerationResult,
  type ProviderErrorKind,
  type SummaryProvider,
} from '../summaries/provider.js';

export type MockPlacesMode = 'ok' | 'empty' | 'invalid' | ProviderErrorKind;

export type MockPlace = PlaceName;

/**
 * Offline provider for the place lookup. It answers with a fixed list of places, each
 * citing the first article it was given, so the whole path can be run without a network.
 */
export class MockPlacesProvider implements SummaryProvider {
  readonly name = 'mock-places';
  readonly model = 'mock-places-1';
  calls = 0;
  configured = true;

  constructor(
    public mode: MockPlacesMode = 'ok',
    private readonly places: MockPlace[] = [
      { name: 'Kyiv', kind: 'city', country: 'Ukraine', countryCode: 'ua', query: 'Kyiv', role: 'where the strike happened' },
      { name: 'Ukraine', kind: 'country', countryCode: 'ua', query: 'Ukraine', role: 'the country the story is about' },
    ],
    private readonly delayMs = 0,
  ) {}

  isConfigured(): boolean {
    return this.configured;
  }

  configurationHint(): string | null {
    return this.configured ? null : 'mock place provider off';
  }

  async capacity(): Promise<CapacityDecision> {
    return this.mode === 'quota'
      ? { ok: false, reason: 'Mock allowance exhausted', retryAt: new Date(Date.now() + 3_600_000).toISOString() }
      : { ok: true };
  }

  allowance(): null {
    return null;
  }

  async generate(req: GenerationRequest, signal?: AbortSignal): Promise<GenerationResult> {
    this.calls++;
    if (this.delayMs) await sleep(this.delayMs);
    if (signal?.aborted) throw new SummaryProviderError('aborted', 'unavailable');
    if (this.mode === 'invalid') return this.result('{"nothing": true}');
    if (this.mode !== 'ok' && this.mode !== 'empty') {
      throw new SummaryProviderError(`Mock provider failure (${this.mode})`, this.mode, this.mode === 'rate_limited' ? 1000 : null);
    }
    const input = JSON.parse(req.user) as { articles: { id: number }[] };
    const source = input.articles[0]?.id;
    const places = this.mode === 'empty' || source == null
      ? []
      : this.places.map((p) => ({
          name: p.name,
          kind: p.kind,
          country: p.country ?? null,
          country_code: p.countryCode ?? null,
          query: p.query ?? p.name,
          role: p.role ?? null,
          sources: [source],
        }));
    return this.result(JSON.stringify({ places }));
  }

  private result(text: string): GenerationResult {
    return { text, model: this.model, usage: { inputTokens: 100, outputTokens: 20 }, durationMs: this.delayMs };
  }
}
