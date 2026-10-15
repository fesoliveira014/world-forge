import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/core/model';
import { validateConfig } from '../src/core/config';
import {
  applyQualityPreset,
  matchingQualityPreset,
  QUALITY_PRESETS,
} from '../src/core/quality-presets';

test('quality presets stay valid and preserve a customized physical world', () => {
  const customized = {
    ...DEFAULT_CONFIG,
    seed: 'PRESERVE-MY-WORLD',
    radius: 4000000,
    plates: 24,
    erosion: 0,
    windErosion: 1.5,
    hillslopeStrength: 0.5,
    fluvialDuration: 2,
    depositFrequency: 0,
  };
  const original = { ...customized };

  for (const preset of QUALITY_PRESETS) {
    const applied = applyQualityPreset(customized, preset);
    assert.doesNotThrow(() => validateConfig(applied));
    assert.deepEqual(applied, { ...original, ...preset.settings });
    assert.deepEqual(customized, original);
    assert.equal(matchingQualityPreset(applied)?.id, preset.id);
    assert.equal(matchingQualityPreset({ ...applied, seed: 'ANOTHER-SEED' })?.id, preset.id);
    assert.equal(matchingQualityPreset({ ...applied, refinementStrength: 0 }), undefined);
  }
});
