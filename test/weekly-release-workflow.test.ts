/**
 * weekly-release.yml (free): the Monday cut's wiring (docs/releases.md). The
 * cut job runs only off main, for the schedule and a dispatch, with the token
 * scoped to the tag, the stable branch and the release; a pull request that
 * touches the release tooling runs the dry run against main read-only; a
 * dispatched hotfix ref is a full SHA and the dry_run input, true by default,
 * never reaches the scheduled run. The release-cut CLI the jobs call is
 * covered by test/release-cut.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

type Step = { name?: string; uses?: string; if?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type Job = { name?: string; if?: string; permissions?: Record<string, string>; 'timeout-minutes'?: number; steps: Step[] };
type Workflow = { on: Record<string, any>; concurrency: { group: string; 'cancel-in-progress': boolean }; permissions?: unknown; jobs: Record<string, Job> };
const ROOT = path.resolve(import.meta.dir, '..');
const wf = Bun.YAML.parse(fs.readFileSync(path.join(ROOT, '.github/workflows/weekly-release.yml'), 'utf8')) as Workflow;
const BUN_RUN = 'bun --no-env-file --config=/dev/null --no-install run scripts/release-cut.ts';

describe('weekly-release.yml', () => {
  test('Monday schedule, a dispatch with dry_run (default true) and a full-SHA ref, and a pull request only for the release tooling', () => {
    expect(Object.keys(wf.on).sort()).toEqual(['pull_request', 'schedule', 'workflow_dispatch']);
    expect(wf.on.schedule).toEqual([{ cron: '0 14 * * 1' }]);
    expect(wf.on.workflow_dispatch.inputs.dry_run).toMatchObject({ type: 'boolean', default: true });
    expect(wf.on.workflow_dispatch.inputs.ref).toMatchObject({ type: 'string', default: '' });
    expect(wf.on.pull_request).toEqual({ paths: ['.github/workflows/weekly-release.yml', 'scripts/release-cut.ts'] });
    expect(wf.concurrency).toEqual({ group: "weekly-release-${{ github.event.pull_request.number || 'cut' }}", 'cancel-in-progress': false });
    expect(wf.permissions).toEqual({});
    expect(Object.keys(wf.jobs)).toEqual(['cut', 'dry-run']);
  });

  test('the cut job runs only off main for a schedule or dispatch, writes contents, reads checks, and rejects a ref that is not a 40-hex SHA', () => {
    const cut = wf.jobs.cut!;
    expect(cut.if).toBe("github.event_name != 'pull_request' && github.ref == 'refs/heads/main'");
    expect(cut.permissions).toEqual({ contents: 'write', checks: 'read' });
    expect(cut.steps.find(s => s.uses?.startsWith('actions/checkout@'))!.with).toEqual({ 'fetch-depth': 0 });
    const plan = cut.steps.find(s => s.name === 'Plan and cut')!;
    expect(plan.env!.GH_TOKEN).toBe('${{ github.token }}');
    expect(plan.env!.DRY_RUN).toBe("${{ github.event_name == 'workflow_dispatch' && inputs.dry_run && 'true' || 'false' }}");
    expect(plan.env!.RELEASE_REF).toBe("${{ github.event_name == 'workflow_dispatch' && inputs.ref || '' }}");
    expect(plan.run).toContain('set -euo pipefail');
    expect(plan.run).toContain('[[ "$RELEASE_REF" =~ ^[0-9a-f]{40}$ ]]');
    expect(plan.run).toContain('[ "$DRY_RUN" = true ] && args+=(--dry-run)');
    expect(plan.run).toContain('[ -n "$RELEASE_REF" ] && args+=(--ref "$RELEASE_REF")');
    expect(plan.run).toContain(BUN_RUN + ' "${args[@]}"');
    expect(cut.steps.find(s => s.name === 'Fetch stable and the tags')!.run).toContain("git fetch --quiet origin '+refs/heads/stable:refs/remotes/origin/stable'");
  });

  test('the pull-request dry run is read-only, keeps no credentials, and always passes --dry-run', () => {
    const dry = wf.jobs['dry-run']!;
    expect(dry.if).toBe("github.event_name == 'pull_request'");
    expect(dry.permissions).toEqual({ contents: 'read', checks: 'read' });
    expect(dry.steps.find(s => s.uses?.startsWith('actions/checkout@'))!.with).toEqual({ 'fetch-depth': 0, 'persist-credentials': false });
    const plan = dry.steps.find(s => s.name === 'Plan only')!;
    expect(plan.run).toContain(BUN_RUN + ' --repo "$GITHUB_REPOSITORY" --summary "$GITHUB_STEP_SUMMARY" --dry-run');
    expect(plan.run).not.toContain('--ref');
    for (const job of Object.values(wf.jobs)) {
      expect(job['timeout-minutes']).toBe(20);
      for (const step of job.steps) if (step.run) expect(step.run).not.toMatch(/\b(bun install|bun test|EVALS=)/);
    }
  });
});
