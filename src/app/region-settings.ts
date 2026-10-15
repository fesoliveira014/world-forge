export interface RegionSettings {
  radiusMetres: number;
  targetSpacingMetres: number;
  footprint: 'region' | 'watershed';
}

export function regionSettingsError(settings: RegionSettings, planetRadius: number): string {
  if (
    settings.footprint === 'region' &&
    (!Number.isFinite(settings.radiusMetres) || settings.radiusMetres <= 0)
  ) {
    return 'Enter a positive region radius.';
  }

  if (settings.footprint === 'region' && settings.radiusMetres > Math.PI * planetRadius) {
    return 'The region radius cannot exceed half the planet’s circumference.';
  }

  if (!Number.isFinite(settings.targetSpacingMetres) || settings.targetSpacingMetres <= 0) {
    return 'Enter a positive target spacing.';
  }

  if (settings.targetSpacingMetres / planetRadius < Math.sqrt(3) * 1e-8) {
    return 'Target spacing is below the mesh’s numerical precision at this planet radius.';
  }

  return '';
}
