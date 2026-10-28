import type { TermName } from './schema.js';
import { sleep } from '../util/backoff.js';
import {
  SummaryProviderError,
  type CapacityDecision,
  type GenerationRequest,
  type GenerationResult,
  type ProviderErrorKind,
  type SummaryProvider,
} from '../summaries/provider.js';

export type MockTermsMode = 'ok' | 'empty' | 'invalid' | ProviderErrorKind;

/**
 * Offline provider for the terms. It answers the naming prompt with a fixed list of
 * terms, each citing the first article it was given, and the explaining prompt with one
 * sentence about every term it was asked about, so the whole path can be run without a
 * network.
 */
export class MockTermsProvider implements SummaryProvider {
  readonly name = 'mock-terms';
  readonly model = 'mock-terms-1';
  calls = 0;
  configured = true;

  constructor(
    public mode: MockTermsMode = 'ok',
    private readonly terms: TermName[] = [
      { name: 'Cohere', kind: 'organisation', wiki: 'Cohere', role: 'the company the story is about' },
    ],
    private readonly delayMs = 0,
  ) {}

  isConfigured(): boolean {
    return this.configured;
  }

  configurationHint(): string | null {
    return this.configured ? null : 'mock term provider off';
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
    const input = JSON.parse(req.user) as {
      articles: { id: number }[];
      terms?: { name: string }[];
    };
    const source = input.articles[0]?.id;
    // The explaining prompt carries the terms it asks about; the naming prompt does not.
    const asked = input.terms?.map((t) => t.name) ?? [];
    const terms = this.mode === 'empty'
      ? []
      : asked.length
        ? asked.map((name) => ({ name, explanation: `${name} is what the articles are about.` }))
        : source == null
          ? []
          : this.terms.map((t) => ({
              name: t.name,
              kind: t.kind,
              wiki: t.wiki ?? null,
              role: t.role ?? null,
              sources: [source],
            }));
    return this.result(JSON.stringify({ terms }));
  }

  private result(text: string): GenerationResult {
    return { text, model: this.model, usage: { inputTokens: 100, outputTokens: 20 }, durationMs: this.delayMs };
  }
}
