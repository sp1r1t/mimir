/**
 * Replaceable text-generation backend for executive summaries. A provider turns one
 * self-contained prompt into text; it may be an HTTP API or a short-lived local CLI
 * process (prompt on stdin, text on stdout). Parsing and validation happen outside the
 * provider, so every backend is held to the same result schema.
 */
export interface SummaryProvider {
  readonly name: string;
  readonly model: string;
  isConfigured(): boolean;
  configurationHint(): string | null;
  /**
   * Whether a call may be made now for this trigger. Providers with a usage allowance
   * answer from it; providers without one return { ok: true }.
   */
  capacity(trigger: SummaryTrigger, signal?: AbortSignal): Promise<CapacityDecision>;
  /** Last known allowance, for display. No network call. */
  allowance(): AllowanceSnapshot | null;
  generate(request: GenerationRequest, signal?: AbortSignal): Promise<GenerationResult>;
}

export type SummaryTrigger = 'auto' | 'manual';

export interface GenerationRequest {
  system: string;
  user: string;
  maxOutputTokens: number;
}

export interface GenerationResult {
  text: string;
  model: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
  durationMs: number;
}

export type CapacityDecision =
  | { ok: true }
  | { ok: false; reason: string; retryAt: string | null };

export interface AllowanceWindow {
  label: string;
  remainingPercent: number | null;
  resetsAt: string | null;
}

export interface AllowanceSnapshot {
  checkedAt: string;
  plan: string | null;
  windows: AllowanceWindow[];
  error: string | null;
}

export type ProviderErrorKind =
  /** Credentials missing or rejected. */
  | 'auth'
  /** The key or account cannot be used on the subscription allowance (or the model is not on the plan). */
  | 'plan'
  /** Allowance exhausted for now; resume after reset. */
  | 'quota'
  /** Request rate limit; retry shortly. */
  | 'rate_limited'
  /** Timeout, overload, network or server error. */
  | 'unavailable'
  /** The provider answered, but not with a usable result. */
  | 'invalid_output'
  /** The request itself was refused; retrying will not help. */
  | 'rejected';

export class SummaryProviderError extends Error {
  constructor(
    message: string,
    readonly kind: ProviderErrorKind,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'SummaryProviderError';
  }
}

/** Placeholder when no summary provider is selected. */
export class DisabledSummaryProvider implements SummaryProvider {
  readonly name = 'none';
  readonly model = 'none';
  isConfigured(): boolean {
    return false;
  }
  configurationHint(): string {
    return 'Set SUMMARY_PROVIDER and its credentials to enable executive summaries.';
  }
  async capacity(): Promise<CapacityDecision> {
    return { ok: false, reason: this.configurationHint(), retryAt: null };
  }
  allowance(): null {
    return null;
  }
  async generate(): Promise<GenerationResult> {
    throw new SummaryProviderError(this.configurationHint(), 'auth');
  }
}
