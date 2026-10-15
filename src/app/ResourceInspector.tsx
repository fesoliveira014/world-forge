import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import type {
  DepositInspection,
  DepositPage,
  WorldSummary,
  WorldViewSource,
} from '../core/view/types';
import { RESOURCE_PRESETS, FORMATION_NAMES, resourcePreset } from '../core/resource-presets';
import type { FertilityEvaluation } from '../core/generation/fertility';
import type { ResourceFilter } from '../render/ResourceMarkers';
import { Choice, formatNumber } from './controls';

export function ResourceControls({
  source,
  summary,
  filter,
  selected,
  onFilter,
  onSelect,
}: {
  source: WorldViewSource;
  summary: WorldSummary;
  filter: ResourceFilter;
  selected: string | null;
  onFilter: (filter: ResourceFilter) => void;
  onSelect: (id: string | null) => void;
}) {
  const [cursor, setCursor] = useState(0);
  const [result, setResult] = useState<{
    source: WorldViewSource;
    filter: ResourceFilter;
    cursor: number;
    page: DepositPage;
  } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  useEffect(() => {
    let active = true;
    void source
      .listDeposits(filter, cursor, 100)
      .then((page) => {
        if (active) {
          setResult({ source, filter, cursor, page });
          setFailure(null);
        }
      })
      .catch((caughtError) => {
        if (active) {
          setFailure({
            key: `${filter}:${cursor}`,
            message:
              caughtError instanceof Error ? caughtError.message : 'Could not load deposits.',
          });
        }
      });
    return () => {
      active = false;
    };
  }, [source, filter, cursor]);
  const page =
    result?.source === source && result.filter === filter && result.cursor === cursor
      ? result.page
      : null;
  const error = failure?.key === `${filter}:${cursor}` ? failure.message : '';
  const deposits = page?.items ?? [];
  const total = filter === 'all' ? summary.depositCount : summary.resourceTotals[filter].count;
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
        {formatNumber(total)} deposits
        {filter !== 'all' && ` · ${formatNumber(summary.resourceTotals[filter].amount)} units`}
      </p>
      {deposits.length > 0 ? (
        <Choice
          label="Inspect deposit"
          value={selected ?? 'none'}
          onChange={(id) => onSelect(id === 'none' ? null : id)}
          items={[
            ['none', 'Select a marker or deposit'],
            ...(selected && !deposits.some((deposit) => deposit.id === selected)
              ? [[selected, 'Selected map deposit']]
              : []),
            ...deposits.map((deposit) => [
              deposit.id,
              `${resourcePreset(deposit.resourceType).name} · ${deposit.id.split(':').slice(1).join('.')} · ${formatNumber(deposit.amount)} units`,
            ]),
          ]}
        />
      ) : (
        <p className="panel-note">
          {!page
            ? 'Loading deposits…'
            : 'No deposits of this resource in this world. Frequency and geological settings control their occurrence.'}
        </p>
      )}
      {error && (
        <p className="panel-note" role="alert">
          {error}
        </p>
      )}
      {total > 100 && (
        <div className="deposit-pagination">
          <Button
            variant="outline"
            size="sm"
            disabled={cursor === 0 || !page}
            onClick={() => setCursor(Math.max(0, cursor - 100))}
          >
            Previous
          </Button>
          <span>
            {page
              ? `${cursor + 1}–${cursor + deposits.length} of ${formatNumber(total)}`
              : 'Loading…'}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page?.nextCursor == null}
            onClick={() => setCursor(page!.nextCursor!)}
          >
            Next
          </Button>
        </div>
      )}
      <p className="panel-note">Initial quantities. Units are comparable within each resource.</p>
    </section>
  );
}

export function DepositInspector({
  source,
  id,
  onClose,
}: {
  source: WorldViewSource;
  id: string;
  onClose: () => void;
}) {
  const [result, setResult] = useState<{
    source: WorldViewSource;
    id: string;
    inspection: DepositInspection | null;
  } | null>(null);
  const [failure, setFailure] = useState<{
    source: WorldViewSource;
    id: string;
    message: string;
  } | null>(null);
  useEffect(() => {
    let active = true;
    void source
      .inspectDeposit(id)
      .then((inspection) => {
        if (active) {
          setResult({ source, id, inspection });
          setFailure(null);
        }
      })
      .catch((caughtError) => {
        if (active) {
          setFailure({
            source,
            id,
            message:
              caughtError instanceof Error
                ? caughtError.message
                : 'Could not inspect this deposit.',
          });
        }
      });
    return () => {
      active = false;
    };
  }, [source, id]);
  const error = failure?.source === source && failure.id === id ? failure.message : '';
  const ready = result?.source === source && result.id === id;
  const inspection = ready ? result.inspection : null;
  if (!inspection) {
    return (
      <p className="panel-note" role="status">
        {error || (ready ? 'Deposit not found in this saved world.' : 'Loading deposit…')}{' '}
        <button onClick={onClose}>Close</button>
      </p>
    );
  }
  const { deposit, surface, latitude, longitude } = inspection;
  const preset = resourcePreset(deposit.resourceType);
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

export function FertilityDetails({
  fertility,
  storedScore,
  salinityModeled = false,
}: {
  fertility: FertilityEvaluation;
  storedScore: number;
  salinityModeled?: boolean;
}) {
  return (
    <section className="fertility-details">
      <h4>Fertility · general land potential</h4>
      <dl>
        <div>
          <dt>Cell mean</dt>
          <dd>{storedScore.toFixed(1)} / 100</dd>
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
        {salinityModeled && fertility.salineFraction > 0 && fertility.salinityLimit < 1 && (
          <>
            <div>
              <dt>Salt-affected soil</dt>
              <dd>{formatNumber(fertility.salineFraction * 100, 1)}% of cell</dd>
            </div>
            <div>
              <dt>Local soil salinity</dt>
              <dd>{formatNumber(fertility.soilSalinity, 2)} g/L</dd>
            </div>
            <div>
              <dt>Salt suitability</dt>
              <dd>{formatNumber(fertility.salinityLimit * 100, 1)}% of exposed-land potential</dd>
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
        Annual potential, not crop yield. Exposed land and local corridor coverage weight the score.{' '}
        {salinityModeled
          ? 'Lake and river salinity limit freshwater benefits; salt-affected soil reduces local potential without changing the climatic biome.'
          : 'This saved world has no modeled salinity. Lake freshwater suitability uses throughflow as a proxy.'}
      </p>
    </section>
  );
}
