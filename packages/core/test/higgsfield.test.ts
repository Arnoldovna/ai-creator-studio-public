import { describe, expect, it } from 'vitest';
import {
  AI_DISCLOSURE, backoffMs, buildAss, buildCostArgs, buildCreateArgs, buildGetArgs, classifyFailure, disclosureLabels, GenerationParams, parseAccountStatus, parseCost, parseJob,
} from '../src';

const p = { model: 'seedance_2_5' as const, prompt: 'Wollknäuel im Gegenlicht, langsamer Schwenk', durationSec: 5, resolution: '720p' as const };

describe('Higgsfield CLI arguments (Etappe 7)', () => {
  it('builds cost/create/get argument arrays: vertical, prompt as one --prompt= argument, JSON output, no --wait', () => {
    expect(buildCostArgs(p)).toEqual(['generate', 'cost', 'seedance_2_5', `--prompt=${p.prompt}`, '--aspect_ratio', '9:16', '--duration', '5', '--resolution', '720p', '--json']);
    expect(buildCreateArgs(p)).toEqual(['generate', 'create', 'seedance_2_5', `--prompt=${p.prompt}`, '--aspect_ratio', '9:16', '--duration', '5', '--resolution', '720p', '--json']);
    expect(buildCreateArgs(p)).not.toContain('--wait');
    // a prompt that looks like a flag stays the value of --prompt; control characters are flattened
    expect(buildCostArgs({ ...p, prompt: '--wait --model x\nneu' })[3]).toBe('--prompt=--wait --model x neu');
    // only Seedance takes --resolution; Kling and Veo reject it ("Unknown params: resolution", real CLI 1.2.3)
    expect(buildCostArgs({ ...p, model: 'kling3_0', resolution: null })).toEqual(['generate', 'cost', 'kling3_0', `--prompt=${p.prompt}`, '--aspect_ratio', '9:16', '--duration', '5', '--json']);
    expect(buildCostArgs(GenerationParams.parse({ model: 'veo3_1_lite', prompt: p.prompt, durationSec: 8 }))).not.toContain('--resolution');
    expect(buildGetArgs('3f2a-b1c4')).toEqual(['generate', 'get', '3f2a-b1c4', '--json']);
    expect(() => buildGetArgs('../x; rm')).toThrow();
  });

  it('only offers whitelisted text-to-video models with their durations', () => {
    expect(() => GenerationParams.parse({ ...p, model: 'text2image_soul_v2' })).toThrow();
    expect(() => GenerationParams.parse({ ...p, durationSec: 7 })).toThrow(/Dauer 5 \/ 10/);
    expect(GenerationParams.parse({ ...p, model: 'veo3_1_lite', durationSec: 8, resolution: null })).toMatchObject({ durationSec: 8, resolution: null });
    expect(() => GenerationParams.parse({ ...p, model: 'kling3_0', resolution: '1080p' })).toThrow(/vom Modell vorgegeben/);
    expect(GenerationParams.parse({ ...p, resolution: undefined }).resolution).toBe('720p');
  });
});

describe('Higgsfield JSON parsing (tolerant, fails closed)', () => {
  it('reads credits from a number or an object, refuses everything else', () => {
    expect(parseCost('12')).toBe(12);
    expect(parseCost('{"credits": 18.5}')).toBe(18.5);
    expect(parseCost('{\n  "credits": 35\n}\n')).toBe(35); // real `generate cost --json` output, CLI 1.2.3
    expect(parseCost('{"cost": {"credits": "30"}}')).toBe(30);
    expect(() => parseCost('{"price_usd": 1}')).toThrow(/Unbekanntes Format/);
    expect(() => parseCost('not json')).toThrow(/kein JSON/);
    expect(() => parseCost('-3')).toThrow();
  });

  it('reads job id, status and result URL from the shapes the docs show', () => {
    expect(parseJob('{"id":"job-1234","status":"queued"}')).toEqual({ id: 'job-1234', status: 'queued', resultUrl: null, error: null });
    expect(parseJob('[{"job_id":"job-1234","status":"completed","result_url":"https://cdn.example/x.mp4"}]').resultUrl).toBe('https://cdn.example/x.mp4');
    expect(parseJob('{"job":{"id":"job-1234","status":"completed","results":[{"raw":{"url":"https://cdn.example/y.mp4"}}]}}').resultUrl).toBe('https://cdn.example/y.mp4');
    expect(parseJob('{"id":"job-1234","status":"nsfw","fail_reason":"policy"}')).toMatchObject({ status: 'nsfw', error: 'policy' });
    expect(() => parseJob('{"status":"queued"}')).toThrow();
    expect(() => parseJob('{"id":"job-1234","status":"teleported"}')).toThrow(/Unbekannter Higgsfield-Status/);
  });

  it('reads the account balance', () => {
    // real `account status --json` shape (CLI 1.2.3); the email is never stored or shown
    expect(parseAccountStatus('{"credits":10,"email":"x@example.invalid","subscription_plan_type":"ultra"}')).toEqual({ credits: 10 });
    expect(parseAccountStatus('{"balance":{"available":"7"}}').credits).toBe(7);
  });

  it('classifies the documented failure modes', () => {
    expect(classifyFailure('Error: Session expired.')).toBe('needs_login');
    expect(classifyFailure('Not authenticated.')).toBe('needs_login');
    expect(classifyFailure('Higgsfield API error (HTTP 429)')).toBe('rate_limited');
    expect(classifyFailure('', 'nsfw')).toBe('nsfw');
    expect(classifyFailure('', 'ip_detected')).toBe('ip_detected');
    expect(classifyFailure('Timeout after 10m')).toBe('timeout');
    expect(classifyFailure('Invalid values: duration=7')).toBe('invalid');
    // real CLI 1.2.3 messages
    expect(classifyFailure('Error: No workspace selected.\nHint: Run: higgsfield workspace set <workspace_id>')).toBe('needs_workspace');
    expect(classifyFailure('Error: Not authenticated.\nHint: Run: higgsfield auth login')).toBe('needs_login');
    expect(classifyFailure('Error: Unknown params: resolution')).toBe('invalid');
    expect(classifyFailure('Error: duration: Input should be greater than or equal to 4')).toBe('invalid');
    expect(classifyFailure('Job ended with status "failed"')).toBe('failed');
    expect([1, 2, 3, 4, 9].map(backoffMs)).toEqual([5000, 10000, 20000, 40000, 60000]);
  });
});

describe('AI label in the render (filter script)', () => {
  it('puts the fixed AI label over every generated clip on the output timeline', () => {
    const labels = disclosureLabels([
      { origin: 'own', inSec: 2, outSec: 5 },
      { origin: 'generated', inSec: 0, outSec: 2.5 },
      { origin: 'generated', inSec: 1, outSec: 3 },
      { origin: 'client', inSec: 0, outSec: 1 },
      { origin: 'generated', inSec: 0, outSec: 1 },
    ]);
    expect(labels).toEqual([
      { startSec: 3, endSec: 7.5, text: AI_DISCLOSURE },
      { startSec: 8.5, endSec: 9.5, text: AI_DISCLOSURE },
    ]);
    expect(disclosureLabels([{ origin: 'own', inSec: 0, outSec: 3 }])).toEqual([]);
  });

  it('writes the label as its own boxed ASS style on top of the subtitles', () => {
    const ass = buildAss([{ startSec: 0, endSec: 2, text: 'Hallo' }], { labels: disclosureLabels([{ origin: 'generated', inSec: 0, outSec: 3 }]) });
    expect(ass).toMatch(/^Style: Label,Arial,44,.*,3,14,0,7,/m);
    expect(ass).toContain(`Dialogue: 9,0:00:00.00,0:00:03.00,Label,,0,0,0,,${AI_DISCLOSURE}`);
    expect(ass).toContain('Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,Hallo');
    // labels alone (subtitles off) still make a valid file
    expect(buildAss([], { labels: [{ startSec: 0, endSec: 1, text: AI_DISCLOSURE }] })).toContain(',Label,,');
  });
});
