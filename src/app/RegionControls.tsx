import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Choice } from './controls';

import { regionSettingsError, type RegionSettings } from './region-settings';

export function RegionControls({
  settings,
  planetRadius,
  busy,
  watershedAvailable,
  onChange,
  onRefine,
}: {
  settings: RegionSettings;
  planetRadius: number;
  busy: boolean;
  watershedAvailable: boolean;
  onChange: (settings: RegionSettings) => void;
  onRefine: () => void;
}) {
  const error =
    regionSettingsError(settings, planetRadius) ||
    (settings.footprint === 'watershed' && !watershedAvailable
      ? 'Select a cell with an established river to refine its whole river-system watershed.'
      : '');

  return (
    <section className="region-controls">
      <h3>Refine this region</h3>
      <p className="panel-note">
        Add detail around the selected location while preserving its terrain and sediment.
      </p>
      <Choice
        label="Refinement footprint"
        value={settings.footprint}
        items={[
          ['region', 'Selected region'],
          ['watershed', 'River system watershed'],
        ]}
        onChange={(footprint) => {
          if (!busy) {
            onChange({ ...settings, footprint: footprint as RegionSettings['footprint'] });
          }
        }}
      />
      {settings.footprint === 'watershed' && (
        <p className="panel-note">
          Refines the whole watershed sharing this river system’s final outlet, including connected
          lakes.
        </p>
      )}
      <div className="region-inputs">
        {settings.footprint === 'region' && (
          <label>
            Region radius · km
            <Input
              aria-label="Region radius in kilometres"
              type="number"
              min="0"
              step="10"
              value={settings.radiusMetres / 1000 || ''}
              disabled={busy}
              onChange={(event) =>
                onChange({ ...settings, radiusMetres: Number(event.target.value) * 1000 })
              }
            />
          </label>
        )}
        <label>
          Target spacing · km
          <Input
            aria-label="Region target spacing in kilometres"
            type="number"
            min="0"
            step="0.1"
            value={settings.targetSpacingMetres / 1000 || ''}
            disabled={busy}
            onChange={(event) =>
              onChange({ ...settings, targetSpacingMetres: Number(event.target.value) * 1000 })
            }
          />
        </label>
      </div>
      <p className="panel-note">
        Uses the current world. Parameter edits apply with Generate world. Finer spacing and larger
        watersheds increase time, memory and local storage.
      </p>
      {error && <p className="region-error">{error}</p>}
      <Button disabled={busy || !!error} onClick={onRefine}>
        Refine region
      </Button>
    </section>
  );
}
