import { useEffect, useState } from 'react';
import { FolderOpen } from 'lucide-react';
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
import {
  deleteSnapshot,
  listSnapshots,
  renameSnapshot,
  type SnapshotDescriptor,
} from '../core/storage';
import type { WorldHandle } from '../core/view/types';
import { formatNumber } from './controls';

export function WorldLibrary({
  handle,
  busy,
  revision,
  onOpen,
  onClose,
}: {
  handle: WorldHandle | null;
  busy: boolean;
  revision: number;
  onOpen: (id: string) => Promise<WorldHandle | null>;
  onClose: () => () => Promise<WorldHandle | null>;
}) {
  const [open, setOpen] = useState(false);
  const [snapshots, setSnapshots] = useState<SnapshotDescriptor[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [nameEdit, setNameEdit] = useState<{ id: string; value: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const active = snapshots.find((snapshot) => snapshot.id === handle?.snapshotId);

  useEffect(() => {
    if (!open) {
      return;
    }
    let current = true;
    void listSnapshots()
      .then((items) => {
        if (current) {
          setSnapshots(items);
        }
      })
      .catch((caughtError) => {
        if (current) {
          setError(String(caughtError));
        }
      });
    return () => {
      current = false;
    };
  }, [open, revision, refresh]);

  const name = nameEdit?.id === active?.id ? (nameEdit?.value ?? '') : (active?.name ?? '');

  async function rename() {
    if (!active || !name.trim()) {
      return;
    }
    setWorking(true);
    setError('');
    try {
      await renameSnapshot(active.id, name.trim());
      setRefresh((value) => value + 1);
    } catch (caughtError) {
      setError(String(caughtError));
    } finally {
      setWorking(false);
    }
  }

  async function remove(snapshot: SnapshotDescriptor) {
    setWorking(true);
    setError('');
    const wasActive = snapshot.id === handle?.snapshotId;
    const restoreIfUnchanged = wasActive ? onClose() : null;
    try {
      await deleteSnapshot(snapshot.id);
      setConfirmDelete(null);
      setRefresh((value) => value + 1);
    } catch (caughtError) {
      await restoreIfUnchanged?.();
      setError(String(caughtError));
    } finally {
      setWorking(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Saved worlds" title="Saved worlds">
          <FolderOpen size={18} />
        </Button>
      </DialogTrigger>
      <DialogContent className="world-library">
        <DialogHeader>
          <DialogTitle>Saved worlds</DialogTitle>
          <DialogDescription>
            Worlds you save appear here. Opening one restores its exact terrain without
            regeneration. Browser storage is local to this device and site.
          </DialogDescription>
        </DialogHeader>
        {active && (
          <form
            className="snapshot-name"
            onSubmit={(event) => {
              event.preventDefault();
              void rename();
            }}
          >
            <label htmlFor="saved-world-name">Current world name</label>
            <div>
              <Input
                id="saved-world-name"
                value={name}
                maxLength={120}
                onChange={(event) => setNameEdit({ id: active.id, value: event.target.value })}
                disabled={working || busy}
              />
              <Button
                type="submit"
                disabled={working || busy || !name.trim() || name.trim() === active.name}
              >
                Save name
              </Button>
            </div>
          </form>
        )}
        {error && (
          <p role="alert" className="region-error">
            {error}
          </p>
        )}
        <ul className="snapshot-list">
          {snapshots.map((snapshot) => (
            <li key={snapshot.id}>
              <div>
                <strong>
                  {snapshot.name}
                  {snapshot.id === handle?.snapshotId ? ' · Current' : ''}
                </strong>
                <p>
                  {snapshot.seed} · {formatNumber(snapshot.surfaceCells)} cells ·{' '}
                  {(snapshot.bytes / 1048576).toFixed(1)} MiB
                  <br />
                  {new Date(snapshot.createdAt).toLocaleString()}
                </p>
              </div>
              {confirmDelete === snapshot.id ? (
                <div className="snapshot-actions">
                  <span>Delete this saved world?</span>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={working || busy}
                    onClick={() => void remove(snapshot)}
                  >
                    Delete permanently
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={working}
                    onClick={() => setConfirmDelete(null)}
                  >
                    Keep
                  </Button>
                </div>
              ) : (
                <div className="snapshot-actions">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={working || busy || snapshot.id === handle?.snapshotId}
                    onClick={async () => {
                      setWorking(true);
                      setError('');
                      const loaded = await onOpen(snapshot.id);
                      setWorking(false);
                      if (loaded) {
                        setOpen(false);
                      } else {
                        setError(
                          'This saved world could not be opened. It may be unavailable or incompatible.',
                        );
                      }
                    }}
                  >
                    Open
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={working || busy}
                    onClick={() => setConfirmDelete(snapshot.id)}
                  >
                    Delete
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
        {!snapshots.length && (
          <p className="panel-note">
            No saved worlds yet. Choose Save world to keep the current terrain.
          </p>
        )}
        <p className="panel-note">
          Export recipe keeps settings and refinement history for regeneration. Clearing site data
          removes saved terrain.
        </p>
      </DialogContent>
    </Dialog>
  );
}
