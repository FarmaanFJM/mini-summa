import { envLabel } from '@minisumma/shared';
import type { Project } from '@minisumma/shared';
import { useState } from 'react';
import { Button, Dialog, Field, Select, TextInput } from '../../ui';

export interface NewSessionDialogProps {
  project: Project;
  open: boolean;
  starting: boolean;
  onStart: (options: { rootId: string; name: string }) => void;
  onClose: () => void;
}

/** Asked only when the project has more than one folder: which one (and so which environment) the session starts in. */
export function NewSessionDialog({ project, open, starting, onStart, onClose }: NewSessionDialogProps) {
  const roots = project.roots.slice().sort((a, b) => a.position - b.position);
  const preferred = roots.find((r) => r.env === project.defaultEnv) ?? roots[0];
  const [rootId, setRootId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const chosen = rootId ?? preferred?.id ?? null;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New local session"
      size="sm"
      busy={starting}
      footer={(
        <>
          <Button onClick={onClose} disabled={starting}>Cancel</Button>
          <Button variant="primary" loading={starting} disabled={!chosen} onClick={() => chosen && onStart({ rootId: chosen, name: name.trim() })}>Start session</Button>
        </>
      )}
    >
      <Field label="Folder">
        <Select
          value={chosen}
          onChange={setRootId}
          options={roots.map((r) => ({ value: r.id, label: r.path, description: envLabel(r.env) }))}
        />
      </Field>
      <Field label="Name (optional)">
        <TextInput value={name} maxLength={120} autoComplete="off" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && chosen) { e.preventDefault(); onStart({ rootId: chosen, name: name.trim() }); } }} />
      </Field>
    </Dialog>
  );
}
