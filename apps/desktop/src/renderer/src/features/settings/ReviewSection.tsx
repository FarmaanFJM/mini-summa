import { DEFAULT_REVIEW_REQUEST } from '@minisumma/shared';
import { useMemo, useState } from 'react';
import { useApp } from '../../app/runtime';
import { activeProjects } from '../../app/selectors';
import { Button, Field, TextArea, TextInput } from '../../ui';
import { Group, PageStatus, SwitchRow } from './controls';
import { count, parsePartSize, partCountFor, previewMessage } from './model';
import { useSettings } from './useSettings';

const MAX_TEMPLATE = 4000;

/**
 * The words that go with every report handed to ChatGPT, and how long a part may be.
 *
 * What the person typed is a draft: until they type, the fields show what the core has (even if it arrives late or changes
 * from another window); once they type, the draft is theirs until it is saved or discarded. If Save fails the draft is
 * still there.
 */
export function ReviewSection() {
  const { settings, save, status } = useSettings();
  const projects = useApp((s) => s.projects);
  const stored = settings?.review ?? null;

  const [templateDraft, setTemplateDraft] = useState<string | null>(null);
  const [partDraft, setPartDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const template = templateDraft ?? stored?.requestTemplate ?? '';
  const partText = partDraft ?? (stored ? String(stored.maxPartChars) : '');
  const templateDirty = stored !== null && templateDraft !== null && templateDraft !== stored.requestTemplate;
  const partSize = parsePartSize(partText);
  const partDirty = stored !== null && partDraft !== null && partSize !== stored.maxPartChars;

  const partProblem = partSize === null ? 'Use a whole number from 2,000 to 100,000.' : undefined;
  const templateProblem = template.length > MAX_TEMPLATE ? `The request can be at most ${count(MAX_TEMPLATE)} characters.` : undefined;
  const projectName = activeProjects(projects)[0]?.name ?? 'Your project';
  const includeRef = stored?.includeSessionRef ?? true;
  const preview = useMemo(() => previewMessage({ requestTemplate: template, includeSessionRef: includeRef, projectName }), [template, includeRef, projectName]);

  if (!settings || !stored) return <p className="ms-x-note">Settings are not loaded yet.</p>;

  const dirty = templateDirty || partDirty;
  const canSave = dirty && partProblem === undefined && templateProblem === undefined;
  const parts = partCountFor(preview.length, partSize ?? stored.maxPartChars);

  const saveAll = async () => {
    if (partSize === null) return;
    const sentTemplate = templateDirty ? template : null;
    const sentPart = partDirty ? partText : null;
    setSaving(true);
    const ok = await save({ review: { ...(sentTemplate !== null ? { requestTemplate: sentTemplate } : {}), ...(sentPart !== null ? { maxPartChars: partSize } : {}) } });
    setSaving(false);
    // Only what was sent is let go. Anything typed while the save ran stays a draft.
    if (ok) {
      setTemplateDraft((d) => (d === sentTemplate ? null : d));
      setPartDraft((d) => (d === sentPart ? null : d));
    }
  };

  return (
    <div className="ms-set-page">
      <PageStatus status={status} />

      <Group title="The request" note="This text follows every report you hand to ChatGPT. Leave it empty to hand over the report without a request.">
        <Field label="Request to the reviewer" error={templateProblem} aside={<span className="ms-x-note">{count(template.length)} of {count(MAX_TEMPLATE)}</span>}>
          <TextArea rows={5} value={template} onChange={(e) => setTemplateDraft(e.target.value)} />
        </Field>
        <div className="ms-x-actions">
          <Button size="sm" variant="ghost" disabled={template === DEFAULT_REVIEW_REQUEST} onClick={() => setTemplateDraft(DEFAULT_REVIEW_REQUEST)}>Use the standard request</Button>
        </div>
      </Group>

      <Group title="What the message includes">
        <SwitchRow
          label="Name the Claude session"
          hint="Adds a line such as a1b2c3d4, managed, Windows, generation 1, so a follow-up can be sent back to the right session."
          checked={includeRef}
          onChange={(v) => { void save({ review: { includeSessionRef: v } }); }}
        />
        <Field
          label="Longest part, in characters"
          className="ms-set-narrow"
          error={partProblem}
          hint={`A message longer than this is split into parts you paste one after another. Each part says which one it is. At this size the example below is ${parts} ${parts === 1 ? 'part' : 'parts'}.`}
        >
          <TextInput inputMode="numeric" value={partText} onChange={(e) => setPartDraft(e.target.value)} autoComplete="off" />
        </Field>
      </Group>

      <Group title="Preview" note="The message built from the settings above, around a short example report. A real report is placed between the two marker lines unchanged.">
        <pre className="ms-x-text ms-mono" aria-label="Message preview" tabIndex={0}>{preview}</pre>
      </Group>

      <div className="ms-x-actions">
        <Button variant="primary" loading={saving} disabled={!canSave} onClick={() => { void saveAll(); }}>Save</Button>
        <Button disabled={!dirty || saving} onClick={() => { setTemplateDraft(null); setPartDraft(null); }}>Discard changes</Button>
      </div>
    </div>
  );
}
