import type { ReactNode } from 'react';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';

export const formatNumber = (value: number, digits = 0) =>
  value.toLocaleString('en-US', { maximumFractionDigits: digits });

export const cellCount = (level: number) => 10 * 4 ** level + 2;

export function downloadWorldConfig(value: unknown, name: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
  );
  const downloadLink = document.createElement('a');
  downloadLink.href = url;
  downloadLink.download = name;
  downloadLink.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function Range({
  label,
  value,
  min,
  max,
  step,
  onChange,
  display,
  description,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  display: string;
  description?: string;
}) {
  return (
    <div className="range-field" title={description}>
      <div>
        <label>{label}</label>
        <output>{display}</output>
      </div>
      <Slider
        aria-label={label}
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(sliderValues) => onChange(sliderValues[0])}
      />
      {description && <p>{description}</p>}
    </div>
  );
}

export function Choice({
  label,
  value,
  onChange,
  items,
}: {
  label: string;
  value: string;
  onChange: (optionValue: string) => void;
  items: string[][];
}) {
  return (
    <div className="select-control">
      <label>{label}</label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map(([optionValue, title]) => (
            <SelectItem key={optionValue} value={optionValue}>
              {title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function Toggle({
  label,
  checked,
  onChange,
  description,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  description?: string;
}) {
  const control = (
    <label className="view-toggle" title={description}>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        aria-label={label}
        aria-description={description}
      />
      <span>{label}</span>
    </label>
  );
  return description ? (
    <Tooltip>
      <TooltipTrigger asChild>{control}</TooltipTrigger>
      <TooltipContent>{description}</TooltipContent>
    </Tooltip>
  ) : (
    control
  );
}

export function ToolButton({
  label,
  children,
  onClick,
  active = false,
  disabled = false,
}: {
  label: string;
  children: ReactNode;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          title={label}
          disabled={disabled}
          onClick={onClick}
          className={active ? 'tool-button active' : 'tool-button'}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
