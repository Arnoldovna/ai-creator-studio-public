import { describe, expect, it } from 'vitest';
import { FootageUploadMeta, parseProbe } from '../src';

// Shape of `ffprobe -print_format json -show_format -show_streams` for an upright iPhone clip (coded landscape, display matrix -90).
const IPHONE = JSON.stringify({
  streams: [
    { index: 0, codec_name: 'hevc', codec_type: 'video', width: 1920, height: 1080, avg_frame_rate: '30000/1001', r_frame_rate: '30/1', side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] },
    { index: 1, codec_name: 'aac', codec_type: 'audio' },
    { index: 2, codec_name: 'mjpeg', codec_type: 'video', disposition: { attached_pic: 1 }, width: 320, height: 240 },
  ],
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '12.345678' },
});

describe('ffprobe parser', () => {
  it('applies the display matrix, ignores cover art, rounds fps and duration', () => {
    expect(parseProbe(IPHONE)).toEqual({
      durationSec: 12.346, width: 1920, height: 1080, rotation: 90, displayWidth: 1080, displayHeight: 1920, orientation: 'portrait',
      fps: 29.97, videoCodec: 'hevc', audioCodec: 'aac', hasAudio: true, container: 'mov,mp4,m4a,3gp,3g2,mj2',
    });
  });

  it('reads the legacy rotate tag and tolerates missing or hostile fields', () => {
    const legacy = parseProbe(JSON.stringify({ streams: [{ codec_type: 'video', width: 1080, height: 1920, tags: { rotate: '180' }, avg_frame_rate: '0/0' }], format: {} }));
    expect(legacy).toMatchObject({ rotation: 180, orientation: 'portrait', fps: null, durationSec: null, hasAudio: false });
    expect(parseProbe('{"streams":"x","format":[1]}')).toMatchObject({ width: null, orientation: null, rotation: 0, container: null });
    expect(() => parseProbe('not json')).toThrow();
  });
});

describe('footage upload metadata', () => {
  it('requires confirmed rights and a source for licensed or client material; never accepts generated', () => {
    expect(FootageUploadMeta.parse({ name: 'take1.mov', origin: 'own', rightsConfirmed: true })).toMatchObject({ rightsNote: '' });
    // Etappe 10: own footage carries its rights implicitly (no checkbox), licensed/client footage still needs the confirmation
    expect(FootageUploadMeta.parse({ name: 'a', origin: 'own', rightsConfirmed: false })).toMatchObject({ rightsConfirmed: true, rightsNote: '' });
    expect(FootageUploadMeta.parse({ name: 'a', origin: 'own' })).toMatchObject({ rightsConfirmed: true });
    expect(() => FootageUploadMeta.parse({ name: 'a', origin: 'licensed', rightsConfirmed: false, rightsNote: 'Artlist, Lizenz #123' })).toThrow(/Rechte/);
    expect(() => FootageUploadMeta.parse({ name: 'a', origin: 'client', rightsNote: 'Vertrag vom 1.11.' })).toThrow(/Rechte/);
    expect(() => FootageUploadMeta.parse({ name: 'a', origin: 'client', rightsConfirmed: true })).toThrow(/Quelle/);
    expect(FootageUploadMeta.parse({ name: 'a', origin: 'licensed', rightsConfirmed: true, rightsNote: 'Artlist, Lizenz #123' }).origin).toBe('licensed');
    expect(() => FootageUploadMeta.parse({ name: 'a', origin: 'generated', rightsConfirmed: true })).toThrow();
  });
});
