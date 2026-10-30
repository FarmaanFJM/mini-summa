import { DEFAULT_REVIEW_REQUEST } from '@minisumma/shared';
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../app/runtime';
import { activeProjects } from '../../app/selectors';
import { Button, Field, TextArea, TextInput } from '../../ui';
import { Group, SaveStatus, SwitchRow } from './controls';
import { count, parsePartSize, partCountFor, previewMessage } from './model';
import { useSettings } from './useSettings';

const MAX_TEMPLATE = 4000;

/**
 * The words that go with every report handed to ChatGPT, and how long a part may be. The text is kept as the person typed
 * it until Save works; if Save fails it is still there.
 */
export function ReviewSection() {
  const { settings, save, status } = useSettings();
  const projects = useApp((s) => s.projects);
  const stored = settings?.review ?? null;

  const [template, setTemplate] = useState(stored?.requestTemplate ?? '');
  const [partText, setPartText] = useState(stored ? String(stored.maxPartChars) : '');
  const [saving, setSaving] = useState(false);

  // Follow the core when it changes somewhere else, unless there is an unsaved edit here.
  const templateDirty = stored !== null && template !== stored.requestTemplate;
  const partDirty = stored !== null && partText.replace(/[\s,]/g, '') !== String(stored.maxPartChars);
  const storedTemplate = stored?.requestTemplate;
  const storedPart = stored?.maxPartChars;
  useEffect(() => { if (storedTemplate !== undefined && !templateDirty) setTemplate(storedTemplate); }, [storedTemplate, templateDirty]);
  useEffect(() => { if (storedPart !== undefined && !partDirty) setPartText(String(storedPart)); }, [storedPart, partDirty]);

  const partSize = parsePartSize(partText);
  const partProblem = partSize === null ? 'Use a whole number from 2,000 to 100,000.' : undefined;
  const templateProblem = template.length > MAX_TEMPLATE ? `The request can be at most ${count(MAX_TEMPLATE)} characters.` : undefined;
  const projectName = activeProjects(projects)[0]?.name ?? 'Your project';
  const includeRef = stored?.includeSessionRef ?? true;
  const preview = useMemo(() => previewMessage({ requestTemplate: template, includeSessionRef: includeRef, projectName }), [template, includeRef, projectName]);

  if (!settings || !stored) return <p className="ms-x-note">Settings are not loaded yet.</p>;

  const dirty = templateDirty || partDirty;
  const canSave = dirty && partProblem === undefined && templateProblem === undefined;

  const saveAll = async () => {
    if (partSize === null) return;
    setSaving(true);
    await save({ review: { ...(templateDirty ? { requestTemplate: template } : {}), ...(partDirty ? { maxPartChars: partSize } : {}) } });
    setSaving(false);
  };

  return (
    <div className="ms-set-page">
      <div className="ms-set-status"><SaveStatus status={status} /></div>

      <Group title="The request" note="This text follows every report you hand to ChatGPT. Leave it empty to hand over the report without a request.">
        <Field label="Request to the reviewer" error={templateProblem} aside={<span className="ms-x-note">{count(template.length)} of {count(MAX_TEMPLATE)}</span>}>
          <TextArea rows={5} value={template} onChange={(e) => setTemplate(e.target.value)} />
        </Field>
        <div className="ms-x-actions">
          <Button size="sm" variant="ghost" disabled={template === DEFAULT_REVIEW_REQUEST} onClick={() => setTemplate(DEFAULT_REVIEW_REQUEST)}>Use the standard request</Button>
        </div>
      </Group>

      <Group title="What the message includes">
        <SwitchRow
          label="Name the Claude session"
          hint="Adds a line such as a1b2c3d4, managed, Windows, generation 1, so a follow-up can be sent back to the right session."
          checked={includeRef}
          onChange={(v) => { void save({ review: { includeSessionRef: v } }); }}
        />
        <Field label="Longest part, in characters" error={partProblem} hint={`A message longer than this is split into parts you paste one after another. Each part says which one it is. At this size the example below is ${partCountFor(preview.length, partSize ?? stored.maxPartChars)} ${partCountFor(preview.length, partSize ?? stored.maxPartChars) === 1 ? 'part' : 'parts'}.`}>
          <TextInput inputMode="numeric" value={partText} onChange={(e) => setPartText(e.target.value)} autoComplete="off" />
        </Field>
      </Group>

      <Group title="Preview" note="The message built from the settings above, around a short example report. A real report is placed between the two marker lines unchanged.">
        <pre className="ms-x-text ms-mono" aria-label="Message preview" tabIndex={0}>{preview}</pre>
      </Group>

      <div className="ms-x-actions">
        <Button variant="primary" loading={saving} disabled={!canSave} onClick={() => { void saveAll(); }}>Save</Button>
        <Button disabled={!dirty || saving} onClick={() => { setTemplate(stored.requestTemplate); setPartText(String(stored.maxPartChars)); }}>Discard changes</Button>
      </div>
    </div>
  );
}
