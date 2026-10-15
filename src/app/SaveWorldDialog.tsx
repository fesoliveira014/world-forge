import { useRef, useState } from 'react';
import { Check, LoaderCircle, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import type { WorldHandle } from '../core/view/types';

export function SaveWorldDialog({
  handle,
  busy,
  saving,
  onSave,
  onCancel,
}: {
  handle: WorldHandle | null;
  busy: boolean;
  saving: boolean;
  onSave: (name: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const attempt = useRef(0);
  const saved = !!handle && handle.saved !== false;

  function changeOpen(next: boolean) {
    attempt.current++;
    if (next) {
      setName(handle?.name || handle?.config.seed || '');
      setError('');
    } else {
      onCancel();
    }
    setOpen(next);
  }

  async function submit() {
    if (!name.trim() || saving) {
      return;
    }
    const submitted = ++attempt.current;
    setError('');
    try {
      const completed = await onSave(name.trim());
      if (submitted === attempt.current && completed) {
        setOpen(false);
      }
    } catch (caughtError) {
      if (submitted === attempt.current) {
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : 'Could not save this world. It remains open and unsaved; try again.',
        );
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          className="save-world-button"
          disabled={!handle || busy || saving || saved}
          aria-label={saved ? 'World saved' : 'Save world'}
          title={saved ? 'This world is in Saved worlds' : 'Save this exact world in your library'}
        >
          {saved ? <Check size={16} /> : <Save size={16} />}
          <span>{saved ? 'Saved' : 'Save world'}</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="save-world-dialog">
        <DialogHeader>
          <DialogTitle>Save world</DialogTitle>
          <DialogDescription>
            Keep this exact terrain in Saved worlds so you can reopen it without regeneration.
            Worlds are saved only when you choose Save world, locally in this browser.
          </DialogDescription>
        </DialogHeader>
        <form
          className="snapshot-name"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label htmlFor="new-world-name">World name</label>
          <Input
            id="new-world-name"
            value={name}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            disabled={saving}
            autoFocus
          />
          {error && (
            <p role="alert" className="region-error">
              {error} Your world remains open; you can retry saving.
            </p>
          )}
          <div className="snapshot-actions save-world-actions">
            <Button type="button" variant="ghost" onClick={() => changeOpen(false)}>
              {saving ? 'Cancel save' : 'Cancel'}
            </Button>
            <Button type="submit" disabled={saving || busy || !name.trim()}>
              {saving && <LoaderCircle size={16} className="spin" />}
              {saving ? 'Saving world…' : 'Save world'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
