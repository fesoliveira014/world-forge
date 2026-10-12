import { X } from 'lucide-react';
import type { World } from '../core/model';
import { nearestCell } from '../core/grid/build';
import { RESOURCE_PRESETS, FORMATION_NAMES, resourcePreset } from '../core/resource-presets';
import { evaluateFertilityCell } from '../core/generation/fertility';
import { isLakeCell } from '../render/SurfaceHabitats';
import type { ResourceFilter } from '../render/ResourceMarkers';
import { Choice, formatNumber } from './controls';

export function ResourceControls({
  world,
  filter,
  selected,
  onFilter,
  onSelect,
}: {
  world: World;
  filter: ResourceFilter;
  selected: string | null;
  onFilter: (filter: ResourceFilter) => void;
  onSelect: (id: string | null) => void;
}) {
  const deposits = world.resources.deposits.filter(
    (deposit) => filter === 'all' || deposit.resourceType === filter,
  );
  return (
    <section className="resource-controls">
      <div className="panel-heading">
        <h2>Mineral endowment</h2>
      </div>
      <Choice
        label="Resource"
        value={filter}
        onChange={(value) => onFilter(value as ResourceFilter)}
        items={[
          ['all', 'All resources'],
          ...RESOURCE_PRESETS.map((preset) => [preset.type, preset.name]),
        ]}
      />
      <p className="panel-note">
        {formatNumber(deposits.length)} deposits
        {filter !== 'all' &&
          ` · ${formatNumber(deposits.reduce((sum, deposit) => sum + deposit.amount, 0))} units`}
      </p>
      {deposits.length > 0 ? (
        <Choice
          label="Inspect deposit"
          value={selected ?? 'none'}
          onChange={(id) => onSelect(id === 'none' ? null : id)}
          items={[
            ['none', 'Select a marker or deposit'],
            ...deposits.map((deposit) => [
              deposit.id,
              `${resourcePreset(deposit.resourceType).name} · ${deposit.id.split(':').slice(1).join('.')} · ${formatNumber(deposit.amount)} units`,
            ]),
          ]}
        />
      ) : (
        <p className="panel-note">
          No deposits of this resource in this world. Frequency and geological settings control
          their occurrence.
        </p>
      )}
      <p className="panel-note">Initial quantities. Units are comparable within each resource.</p>
    </section>
  );
}

export function DepositInspector({
  world,
  id,
  onClose,
}: {
  world: World;
  id: string;
  onClose: () => void;
}) {
  const deposit = world.resources.deposits.find((item) => item.id === id);
  if (!deposit) {
    return null;
  }
  const preset = resourcePreset(deposit.resourceType);
  const cell = nearestCell(world.grid, ...deposit.anchor);
  const surface = world.terrain.ocean[cell]
    ? 'Beneath ocean'
    : isLakeCell(world, cell)
      ? 'Beneath inland water'
      : 'Land';
  const latitude = (Math.asin(deposit.anchor[1]) * 180) / Math.PI;
  const longitude = (Math.atan2(deposit.anchor[2], deposit.anchor[0]) * 180) / Math.PI;
  return (
    <aside className="cell-inspector deposit-inspector">
      <div className="inspector-heading">
        <span className="eyebrow">DEPOSIT {deposit.id}</span>
        <button aria-label="Close deposit inspector" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <h3>
        <span style={{ background: preset.color }} />
        {preset.name}
      </h3>
      <p className="coordinates">
        {Math.abs(latitude).toFixed(2)}° {latitude < 0 ? 'S' : 'N'} ·{' '}
        {Math.abs(longitude).toFixed(2)}° {longitude < 0 ? 'W' : 'E'}
      </p>
      <dl>
        <div>
          <dt>Initial amount</dt>
          <dd>{formatNumber(deposit.amount)} units</dd>
        </div>
        <div>
          <dt>Extent radius</dt>
          <dd>{formatNumber(deposit.extentKm, 1)} km</dd>
        </div>
        <div>
          <dt>Current surface</dt>
          <dd>{surface}</dd>
        </div>
        <div>
          <dt>Formation</dt>
          <dd>{FORMATION_NAMES[deposit.formationCause]}</dd>
        </div>
      </dl>
      <p className="panel-note">
        Formation is a procedural geological association. Amount is an abstract quantity; purity and
        mining access are not modeled.
      </p>
      <p className="panel-note">
        The pale outline shows geographic extent. Marker size shows amount.
      </p>
    </aside>
  );
}

export function FertilityDetails({ world, cell }: { world: World; cell: number }) {
  const fertility = evaluateFertilityCell(world, cell);
  return (
    <section className="fertility-details">
      <h4>Fertility · general land potential</h4>
      <dl>
        <div>
          <dt>Cell mean</dt>
          <dd>{world.resources.fertility[cell].toFixed(1)} / 100</dd>
        </div>
        <div>
          <dt>Surrounding land</dt>
          <dd>{fertility.regionalScore.toFixed(1)} / 100</dd>
        </div>
        {fertility.landFraction > 0 && fertility.landFraction < 1 && (
          <div>
            <dt>Exposed land coverage</dt>
            <dd>{formatNumber(fertility.landFraction * 100, 1)}%</dd>
          </div>
        )}
        {fertility.corridorFraction > 0 && (
          <>
            <div>
              <dt>Corridor peak</dt>
              <dd>{fertility.corridorScore.toFixed(1)} / 100</dd>
            </div>
            <div>
              <dt>Corridor mean</dt>
              <dd>{fertility.meanCorridorScore.toFixed(1)} / 100</dd>
            </div>
            <div>
              <dt>Corridor coverage</dt>
              <dd>{formatNumber(fertility.corridorFraction * 100, 1)}%</dd>
            </div>
          </>
        )}
        {(
          [
            ['Sediment benefit', fertility.sediment],
            ...(fertility.corridorFraction > 0
              ? [
                  ['Corridor alluvium', fertility.corridorSediment],
                  ['Local freshwater', fertility.freshwater],
                ]
              : []),
            ['Rain adequacy', fertility.rain],
            ['Volcanic benefit', fertility.volcanic],
          ] as [string, number][]
        ).map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>{formatNumber(value * 100)}%</dd>
          </div>
        ))}
      </dl>
      {fertility.limitations.length > 0 && (
        <p className="panel-note">Limited by: {fertility.limitations.join(', ').toLowerCase()}.</p>
      )}
      <p className="panel-note">
        Annual potential, not crop yield. Exposed land and local corridor coverage weight the score.
        Lake freshwater suitability uses throughflow; salinity is not simulated.
      </p>
    </section>
  );
}
