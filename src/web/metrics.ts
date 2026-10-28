import type { App } from '../app.js';
import { classifierStatus } from './layout.js';

/** Prometheus text exposition of basic processing metrics. */
export function metricsText(app: App): string {
  const lines: string[] = [];
  const metric = (name: string, type: 'gauge' | 'counter', help: string, samples: [Record<string, string>, number][]) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, value] of samples) {
      const l = Object.entries(labels)
        .map(([k, v]) => `${k}="${v.replace(/["\\\n]/g, '_')}"`)
        .join(',');
      lines.push(`${name}${l ? `{${l}}` : ''} ${Number.isFinite(value) ? value : 0}`);
    }
  };
  const o = app.stats.overview();
  const s = app.scheduler.stats;
  metric('mimir_articles', 'gauge', 'Stored articles', [[{}, o.articles]]);
  metric('mimir_articles_by_classification_status', 'gauge', 'Articles by classification status', [
    [{ status: 'classified' }, o.classified],
    [{ status: 'pending' }, o.pending],
    [{ status: 'failed' }, o.failed],
  ]);
  metric('mimir_sources', 'gauge', 'Feed sources', [
    [{ state: 'enabled' }, o.sourcesEnabled],
    [{ state: 'failing' }, o.sourcesFailing],
    [{ state: 'total' }, o.sources],
  ]);
  metric('mimir_feed_fetches_total', 'counter', 'Feed fetches since start', [[{}, s.fetches]]);
  metric('mimir_feed_fetch_failures_total', 'counter', 'Failed feed fetches since start', [[{}, s.failures]]);
  metric('mimir_feed_not_modified_total', 'counter', 'Feed fetches answered with 304 since start', [[{}, s.notModified]]);
  metric('mimir_articles_created_total', 'counter', 'Articles created since start', [[{}, s.articlesCreated]]);
  metric(
    'mimir_jobs',
    'gauge',
    'Jobs by kind and status',
    app.queue.counts().map((j) => [{ kind: j.kind, status: j.status }, j.count] as [Record<string, string>, number]),
  );
  const sp = app.storyPipeline;
  for (const w of [app.pipeline.extractWorker.stats, app.pipeline.classifyWorker.stats, sp.matchWorker.stats, sp.assessWorker.stats, sp.summaryWorker.stats]) {
    metric(`mimir_${w.kind}_jobs_processed_total`, 'counter', `${w.kind} jobs completed since start`, [[{}, w.processed]]);
    metric(`mimir_${w.kind}_jobs_retried_total`, 'counter', `${w.kind} job retries since start`, [[{}, w.retried]]);
    metric(`mimir_${w.kind}_jobs_failed_total`, 'counter', `${w.kind} jobs failed permanently since start`, [[{}, w.failed]]);
  }
  const st = classifierStatus(app).state;
  metric('mimir_classifier_ready', 'gauge', '1 when the classifier is configured and not paused', [[{}, st === 'ready' ? 1 : 0]]);

  const sc = app.stories.counts();
  metric('mimir_stories', 'gauge', 'Stories by status', [
    [{ status: 'active' }, sc.active],
    [{ status: 'merged' }, sc.merged],
  ]);
  metric('mimir_articles_without_story', 'gauge', 'Articles not yet assigned to a story', [[{}, sc.unassigned]]);
  metric(
    'mimir_story_summaries',
    'gauge',
    'Active stories by summary state',
    Object.entries(sc.summaries).map(([state, n]) => [{ state }, n] as [Record<string, string>, number]),
  );
  const day = app.stories.summaryUsage(1);
  metric(
    'mimir_summary_attempts_24h',
    'gauge',
    'Summary provider calls in the last 24 hours by trigger and outcome',
    day.map((u) => [{ provider: u.provider, trigger: u.trigger, outcome: u.outcome }, u.count] as [Record<string, string>, number]),
  );
  metric(
    'mimir_summary_tokens_24h',
    'gauge',
    'Summary tokens in the last 24 hours',
    [
      [{ direction: 'input' }, day.reduce((n, u) => n + u.inputTokens, 0)],
      [{ direction: 'output' }, day.reduce((n, u) => n + u.outputTokens, 0)],
    ],
  );
  metric('mimir_summary_provider_ready', 'gauge', '1 when the summary provider is configured and not paused', [[{}, sp.summaryPausedReason() ? 0 : 1]]);
  metric(
    'mimir_summary_allowance_remaining_percent',
    'gauge',
    'Last known remaining subscription allowance per window',
    (app.summaries.allowance()?.windows ?? [])
      .filter((w) => w.remainingPercent != null)
      .map((w) => [{ window: w.label }, w.remainingPercent!] as [Record<string, string>, number]),
  );
  return `${lines.join('\n')}\n`;
}
