import {
  SummaryProviderError,
  type AllowanceSnapshot,
  type AllowanceWindow,
  type CapacityDecision,
  type GenerationRequest,
  type GenerationResult,
  type ProviderErrorKind,
  type SummaryProvider,
  type SummaryTrigger,
} from './provider.js';

export interface MiniMaxOptions {
  apiKey?: string;
  /** API host, e.g. https://api.minimax.io; requests go to {baseURL}/v1/chat/completions. */
  baseURL: string;
  /** M Plan usage endpoint (GET, Bearer key). */
  quotaURL: string;
  model: string;
  reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  timeoutMs: number;
  /** Stop automatic summaries when the remaining plan allowance falls to this percentage. */
  autoReservePercent: number;
  /** Stop all summaries at this remaining percentage, before credit packs would be used. */
  minRemainingPercent: number;
  /** How long a usage reading is reused before asking again. */
  quotaCacheMs: number;
  fetch?: typeof fetch;
}

/**
 * MiniMax via its OpenAI-compatible Chat Completions API
 * (https://platform.minimax.io/docs/api-reference/text-chat-openai), billed to the M Plan.
 *
 * Billing safety: generation requests are only sent after the usage endpoint
 * (https://platform.minimax.io/docs/m-plan/faq) has confirmed that the key belongs to an
 * active M Plan subscription. Pay-as-you-go keys are rejected by that endpoint, so they are
 * never used for generation. Calls stop before the plan allowance is exhausted.
 */
export class MiniMaxProvider implements SummaryProvider {
  readonly name = 'minimax';
  readonly model: string;
  private snapshot: AllowanceSnapshot | null = null;
  private snapshotAt = 0;
  private verifiedPlan = false;
  private planError: string | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: MiniMaxOptions) {
    this.model = opts.model;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  isConfigured(): boolean {
    return !!this.opts.apiKey;
  }

  configurationHint(): string | null {
    if (!this.opts.apiKey) return 'Set MINIMAX_API_KEY (an M Plan subscription key) to enable executive summaries.';
    return this.planError;
  }

  allowance(): AllowanceSnapshot | null {
    return this.snapshot;
  }

  async capacity(trigger: SummaryTrigger, signal?: AbortSignal): Promise<CapacityDecision> {
    if (!this.opts.apiKey) return { ok: false, reason: this.configurationHint()!, retryAt: null };
    if (!this.snapshot || Date.now() - this.snapshotAt >= this.opts.quotaCacheMs) {
      try {
        await this.refreshAllowance(signal);
      } catch (err) {
        if (err instanceof SummaryProviderError && (err.kind === 'auth' || err.kind === 'plan')) {
          this.planError = err.message;
          return { ok: false, reason: err.message, retryAt: null };
        }
        const message = `Could not read the MiniMax plan usage: ${err instanceof Error ? err.message : String(err)}`;
        this.snapshot = { checkedAt: new Date().toISOString(), plan: this.snapshot?.plan ?? null, windows: this.snapshot?.windows ?? [], error: message };
        this.snapshotAt = Date.now();
        // A key confirmed as a plan key stays one; only an unverified key blocks generation.
        if (!this.verifiedPlan) return { ok: false, reason: message, retryAt: new Date(Date.now() + 5 * 60_000).toISOString() };
        return { ok: true };
      }
    }
    const floor = trigger === 'auto' ? Math.max(this.opts.autoReservePercent, this.opts.minRemainingPercent) : this.opts.minRemainingPercent;
    const low = this.snapshot!.windows.filter((w) => w.remainingPercent != null && w.remainingPercent <= floor);
    if (low.length) {
      const resets = low.map((w) => w.resetsAt).filter((t): t is string => !!t).sort();
      const retryAt = resets.at(-1) ?? new Date(Date.now() + 30 * 60_000).toISOString();
      const which = low.map((w) => `${w.label} ${w.remainingPercent}% left`).join(', ');
      return {
        ok: false,
        reason: `MiniMax plan allowance ${trigger === 'auto' ? 'reserved for manual requests' : 'used up'} (${which})`,
        retryAt,
      };
    }
    return { ok: true };
  }

  /** Read the M Plan usage. Throws 'plan' when the key is not an active subscription key. */
  async refreshAllowance(signal?: AbortSignal): Promise<AllowanceSnapshot> {
    const res = await this.request(this.opts.quotaURL, { method: 'GET' }, Math.min(this.opts.timeoutMs, 20_000), signal);
    const body = (await readJson(res)) as RemainsResponse | null;
    const code = body?.base_resp?.status_code;
    if (code != null && code !== 0) throw quotaError(code, body?.base_resp?.status_msg ?? '');
    if (!res.ok) throw httpError(res.status, 'usage endpoint');
    const rows = Array.isArray(body?.model_remains) ? body!.model_remains : [];
    const row =
      rows.find((r) => r.model_name === this.model) ??
      rows.find((r) => r.model_name === 'general') ??
      rows.find((r) => typeof r.model_name === 'string' && r.model_name.startsWith('MiniMax-M')) ??
      null;
    if (!row) throw new SummaryProviderError('MiniMax usage response has no text-model allowance; the key may not be on an M Plan', 'plan');
    const windows: AllowanceWindow[] = [
      { label: '5-hour window', remainingPercent: percent(row.current_interval_remaining_percent), resetsAt: msToIso(row.end_time) },
      {
        label: 'weekly window',
        remainingPercent: percent(row.current_weekly_remaining_percent),
        resetsAt: msToIso(row.weekly_end_time ?? row.current_weekly_end_time),
      },
    ];
    this.verifiedPlan = true;
    this.planError = null;
    this.snapshot = { checkedAt: new Date().toISOString(), plan: row.model_name ?? null, windows, error: null };
    this.snapshotAt = Date.now();
    return this.snapshot;
  }

  async generate(req: GenerationRequest, signal?: AbortSignal): Promise<GenerationResult> {
    if (!this.opts.apiKey) throw new SummaryProviderError('MINIMAX_API_KEY is not set', 'auth');
    if (!this.verifiedPlan) throw new SummaryProviderError('The MiniMax key has not been confirmed as an M Plan subscription key', 'plan');
    const started = Date.now();
    const res = await this.request(
      `${this.opts.baseURL.replace(/\/+$/, '')}/v1/chat/completions`,
      {
        method: 'POST',
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          max_completion_tokens: req.maxOutputTokens,
          reasoning_effort: this.opts.reasoningEffort,
          stream: false,
        }),
      },
      this.opts.timeoutMs,
      signal,
    );
    const body = (await readJson(res)) as ChatResponse | null;
    const code = body?.base_resp?.status_code;
    if (code != null && code !== 0) throw chatError(code, body?.base_resp?.status_msg ?? '', retryAfter(res));
    if (!res.ok) throw httpError(res.status, 'chat completion', retryAfter(res));
    // A completed call consumed allowance; read usage again before the next decision.
    this.snapshotAt = 0;
    const choice = body?.choices?.[0];
    const text = typeof choice?.message?.content === 'string' ? choice.message.content : '';
    if (choice?.finish_reason === 'length') {
      throw new SummaryProviderError('MiniMax output was cut off at the token limit (raise MINIMAX_MAX_OUTPUT_TOKENS)', 'invalid_output');
    }
    if (choice?.finish_reason === 'content_filter' || body?.output_sensitive) {
      throw new SummaryProviderError('MiniMax withheld the output (content filter)', 'invalid_output');
    }
    if (!text.trim()) throw new SummaryProviderError('MiniMax returned an empty reply', 'invalid_output');
    return {
      text,
      model: typeof body?.model === 'string' ? body.model : this.model,
      usage: { inputTokens: num(body?.usage?.prompt_tokens), outputTokens: num(body?.usage?.completion_tokens) },
      durationMs: Date.now() - started,
    };
  }

  private async request(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      return await this.fetchImpl(url, {
        ...init,
        headers: { Authorization: `Bearer ${this.opts.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        signal: combined,
      });
    } catch (err) {
      if (timeout.aborted) throw new SummaryProviderError(`MiniMax did not answer within ${timeoutMs} ms`, 'unavailable');
      if (signal?.aborted) throw err;
      throw new SummaryProviderError(`MiniMax unreachable: ${err instanceof Error ? err.message : String(err)}`, 'unavailable');
    }
  }
}

interface BaseResp {
  status_code?: number;
  status_msg?: string;
}

interface RemainsRow {
  model_name?: string;
  start_time?: number;
  end_time?: number;
  current_interval_remaining_percent?: number;
  current_weekly_remaining_percent?: number;
  weekly_end_time?: number;
  current_weekly_end_time?: number;
}

interface RemainsResponse {
  model_remains?: RemainsRow[];
  base_resp?: BaseResp;
}

interface ChatResponse {
  model?: string;
  choices?: { finish_reason?: string; message?: { content?: unknown } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  output_sensitive?: boolean;
  base_resp?: BaseResp;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function percent(v: unknown): number | null {
  const n = num(v);
  return n == null ? null : Math.max(0, Math.min(100, n));
}

function msToIso(v: unknown): string | null {
  const n = num(v);
  return n && n > 0 ? new Date(n).toISOString() : null;
}

function retryAfter(res: Response): number | null {
  const h = res.headers.get('retry-after');
  if (!h) return null;
  const s = Number(h);
  if (Number.isFinite(s)) return s * 1000;
  const t = Date.parse(h);
  return Number.isNaN(t) ? null : Math.max(0, t - Date.now());
}

function httpError(status: number, what: string, retryAfterMs: number | null = null): SummaryProviderError {
  const kind: ProviderErrorKind =
    status === 401 || status === 403 ? 'auth' : status === 429 ? 'rate_limited' : status === 400 || status === 404 || status === 413 ? 'rejected' : 'unavailable';
  return new SummaryProviderError(`MiniMax ${what} failed (HTTP ${status})`, kind, retryAfterMs);
}

/** Error codes: https://platform.minimax.io/docs/api-reference/errorcode */
const CHAT_CODES: Record<number, [ProviderErrorKind, string]> = {
  1000: ['unavailable', 'unknown error'],
  1001: ['unavailable', 'request timeout'],
  1002: ['rate_limited', 'rate limit'],
  1004: ['auth', 'authentication failed'],
  1008: ['quota', 'insufficient balance'],
  1013: ['unavailable', 'internal server error'],
  1024: ['unavailable', 'internal error'],
  1027: ['invalid_output', 'output content error'],
  1033: ['unavailable', 'system error'],
  1039: ['rate_limited', 'token rate limit'],
  2013: ['rejected', 'invalid parameters'],
  2049: ['auth', 'invalid API key'],
  2056: ['quota', 'plan usage limit reached'],
  2057: ['plan', 'the key is not an M Plan subscription key'],
  2061: ['plan', 'the plan does not include this model'],
  2062: ['rate_limited', 'plan rate limit'],
  2064: ['unavailable', 'high load'],
  2066: ['unavailable', 'timeout'],
  2067: ['quota', 'plan usage limit reached and credit use is off'],
  2068: ['plan', 'the plan does not include this model'],
  2069: ['plan', 'model retired'],
};

function chatError(code: number, msg: string, retryAfterMs: number | null): SummaryProviderError {
  const [kind, label] = CHAT_CODES[code] ?? (['unavailable', 'error'] as [ProviderErrorKind, string]);
  return new SummaryProviderError(`MiniMax ${label} (${code}${msg ? `: ${msg}` : ''})`, kind, retryAfterMs);
}

function quotaError(code: number, msg: string): SummaryProviderError {
  // On the usage endpoint, 2062 means there is no active subscription for this key.
  const kind: ProviderErrorKind =
    code === 1004 || code === 2049 ? 'auth' : code === 2057 || code === 2062 ? 'plan' : 'unavailable';
  const label =
    kind === 'auth' ? 'rejected the key' : kind === 'plan' ? 'reports no active M Plan subscription for this key' : 'usage check failed';
  return new SummaryProviderError(`MiniMax ${label} (${code}${msg ? `: ${msg}` : ''})`, kind);
}
