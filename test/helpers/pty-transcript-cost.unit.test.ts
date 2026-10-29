import { describe, test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pricedTranscript, ptyTranscriptCostUsd } from './pty/transcript-cost';

const SID = '11111111-2222-4333-8444-555555555555';
const assistant = (id: string, model: string, usage: object, extra: object = {}) =>
  JSON.stringify({ type: 'assistant', sessionId: SID, message: { id, model, role: 'assistant', usage }, ...extra });

function fixture(write: (project: string) => void): string {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-cost-'));
  const project = path.join(config, 'projects', '-fixture-cwd');
  fs.mkdirSync(project, { recursive: true });
  write(project);
  return config;
}

describe('ptyTranscriptCostUsd', () => {
  test('prices the session, its inline sidechains and subagent files, each message id once at its largest output', () => {
    const config = fixture(project => {
      fs.writeFileSync(path.join(project, `${SID}.jsonl`), [
        JSON.stringify({ type: 'user', sessionId: SID, message: { role: 'user', content: 'hi' } }),
        assistant('msg_a', 'claude-opus-5-5', { input_tokens: 1000, output_tokens: 10 }),
        assistant('msg_a', 'claude-opus-5-5', { input_tokens: 1000, output_tokens: 500 }),
        assistant('msg_side', 'claude-opus-5-5', { input_tokens: 0, output_tokens: 1000 }, { isSidechain: true }),
        assistant('msg_syn', '<synthetic>', { input_tokens: 0, output_tokens: 0 }),
        '{"partial":',
      ].join('\n'));
      fs.mkdirSync(path.join(project, SID, 'subagents'), { recursive: true });
      fs.writeFileSync(path.join(project, SID, 'subagents', 'agent-x.jsonl'),
        assistant('msg_sub', 'claude-opus-5-5', { input_tokens: 0, cache_read_input_tokens: 10000, output_tokens: 0 }) + '\n');
      fs.writeFileSync(path.join(project, '99999999-2222-4333-8444-555555555555.jsonl'),
        assistant('msg_foreign', 'claude-opus-5-5', { input_tokens: 1_000_000, output_tokens: 0 }) + '\n');
    });
    try {
      // opus-5-5: $4 in, $20 out, $0.20 cached per MTok.
      const expected = (1000 * 4 + 500 * 20 + 1000 * 20 + 10000 * 0.2) / 1_000_000;
      expect(ptyTranscriptCostUsd(config, SID)).toBeCloseTo(expected, 6);
      expect(pricedTranscript({ hermeticConfigDir: config, sessionId: SID }).streamed_cost_usd).toBeCloseTo(expected, 6);
    } finally { fs.rmSync(config, { recursive: true, force: true }); }
  });

  test('stays cost-unknown without a transcript, a session id, usage or a priced model', () => {
    const unpriced = fixture(project => fs.writeFileSync(path.join(project, `${SID}.jsonl`),
      assistant('msg_a', 'claude-opus-5-5', { output_tokens: 1 }) + '\n' + assistant('msg_b', 'some-unpriced-model', { output_tokens: 1 }) + '\n'));
    const empty = fixture(project => fs.writeFileSync(path.join(project, `${SID}.jsonl`), JSON.stringify({ type: 'user', sessionId: SID }) + '\n'));
    const unreadable = fixture(project => fs.mkdirSync(path.join(project, `${SID}.jsonl`)));
    try {
      expect(ptyTranscriptCostUsd(unpriced, SID)).toBeUndefined();
      expect(ptyTranscriptCostUsd(empty, SID)).toBeUndefined();
      expect(ptyTranscriptCostUsd(empty, '99999999-2222-4333-8444-555555555555')).toBeUndefined();
      expect(ptyTranscriptCostUsd(unpriced, undefined)).toBeUndefined();
      expect(ptyTranscriptCostUsd(null, SID)).toBeUndefined();
      expect(ptyTranscriptCostUsd(path.join(empty, 'missing'), SID)).toBeUndefined();
      expect(pricedTranscript(undefined)).toEqual({});
      expect(ptyTranscriptCostUsd(unreadable, SID)).toBeUndefined();
    } finally { for (const dir of [unpriced, empty, unreadable]) fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
