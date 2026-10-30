import type { Project, ProjectNotificationPrefs, QuietMode as QuietModeSetting, Settings, SettingsPatch } from '@minisumma/shared';
import { useEffect, useState } from 'react';
import { useApi, useApp } from '../../app/runtime';
import { activeProjects } from '../../app/selectors';
import { Field, Select, Switch, TextInput } from '../../ui';
import { useNow } from '../reports/support';
import { Group, PageStatus, SaveStatus, SwitchRow } from './controls';
import { NOTIFICATION_SWITCHES, QUIET_CHOICES, quietSummary, quietUntil, TIME_RE } from './model';
import type { QuietChoice } from './model';
import { useSaveTracker, useSettings } from './useSettings';

type Save = (patch: SettingsPatch) => Promise<boolean>;

/** Whether the manual quiet period is running right now: switched on, and not past the end the person chose. */
function manualQuietOn(quiet: QuietModeSetting, now: number): boolean {
  if (!quiet.enabled) return false;
  const until = quiet.until === null ? Number.NaN : Date.parse(quiet.until);
  return quiet.until === null || Number.isNaN(until) || until > now;
}

function QuietSettings({ settings, save }: { settings: Settings; save: Save }) {
  const quiet = settings.notifications.quiet;
  const now = useNow(30_000);
  const on = manualQuietOn(quiet, now);
  const [choice, setChoice] = useState<QuietChoice>(on && quiet.until === null ? 'forever' : '1h');

  const setManual = (enabled: boolean, c: QuietChoice) => {
    void save({ notifications: { quiet: { enabled, until: enabled ? quietUntil(c) : null } } });
  };

  return (
    <Group title="Quiet mode" note="Everything still appears in Activity.">
      <SwitchRow label="Quiet now" checked={on} onChange={(v) => setManual(v, choice)} />
      <Field label="How long" className="ms-set-narrow">
        <Select<QuietChoice>
          value={choice}
          options={QUIET_CHOICES.map((c) => ({ value: c.value, label: c.label }))}
          onChange={(c) => { setChoice(c); if (on) setManual(true, c); }}
        />
      </Field>
      <SchedulePicker quiet={quiet} save={save} />
      <p className="ms-x-note" role="status">{quietSummary(quiet, now)}</p>
    </Group>
  );
}

/** The daily window. The times are kept as typed until they are valid, so a half-typed time is never lost or sent. */
function SchedulePicker({ quiet, save }: { quiet: QuietModeSetting; save: Save }) {
  const schedule = quiet.schedule;
  const [from, setFrom] = useState(schedule.from);
  const [to, setTo] = useState(schedule.to);
  // Follow the core when it changes from somewhere else (another window), but never while the person is typing a different value.
  useEffect(() => { setFrom(schedule.from); }, [schedule.from]);
  useEffect(() => { setTo(schedule.to); }, [schedule.to]);

  const fromOk = TIME_RE.test(from);
  const toOk = TIME_RE.test(to);
  const commit = (next: { from?: string; to?: string }) => {
    const f = next.from ?? from;
    const t = next.to ?? to;
    if (TIME_RE.test(f) && TIME_RE.test(t) && (f !== schedule.from || t !== schedule.to)) void save({ notifications: { quiet: { schedule: { from: f, to: t } } } });
  };

  return (
    <div className="ms-x-stack ms-x-stack--tight">
      <SwitchRow
        label="Quiet every day"
        hint="In this PC's local time. It may cross midnight."
        checked={schedule.enabled}
        onChange={(v) => { void save({ notifications: { quiet: { schedule: { enabled: v } } } }); }}
      />
      <div className="ms-set-times">
        <Field label="From" error={fromOk ? undefined : 'Use a time such as 22:00.'}>
          <TextInput
            type="time" value={from} step={60}
            onChange={(e) => { setFrom(e.target.value); commit({ from: e.target.value }); }}
          />
        </Field>
        <Field label="To" error={toOk ? undefined : 'Use a time such as 08:00.'}>
          <TextInput
            type="time" value={to} step={60}
            onChange={(e) => { setTo(e.target.value); commit({ to: e.target.value }); }}
          />
        </Field>
      </div>
      {schedule.enabled && fromOk && toOk && from === to ? <p className="ms-x-note">From and To are the same time, so the window is empty and nothing is silenced.</p> : null}
    </div>
  );
}

function Defaults({ settings, save }: { settings: Settings; save: Save }) {
  const defaults = settings.notifications.defaults;
  return (
    <Group title="For new projects" note="Projects that already exist keep their own choices.">
      <SwitchRow
        label="Notify about new projects"
        hint="Activity is still recorded when this is off."
        checked={defaults.enabled}
        onChange={(v) => { void save({ notifications: { defaults: { enabled: v } } }); }}
      />
      {NOTIFICATION_SWITCHES.map((item) => (
        <SwitchRow
          key={item.key}
          label={item.label}
          hint={item.hint ? item.description : undefined}
          checked={defaults[item.key]}
          disabled={!defaults.enabled}
          onChange={(v) => { void save({ notifications: { defaults: { [item.key]: v } } }); }}
        />
      ))}
    </Group>
  );
}

const PROJECT_COLUMNS = [{ key: 'enabled', column: 'Notify', label: 'Notify' }, ...NOTIFICATION_SWITCHES.map((s) => ({ key: s.key, column: s.column, label: s.label }))] as const;

/** One switch per project and kind. The project's own choice wins over the defaults. */
function ProjectTable() {
  const api = useApi();
  const projects = useApp((s) => s.projects);
  const { status, track } = useSaveTracker();
  const [overlay, setOverlay] = useState<Record<string, boolean>>({});
  const rows = activeProjects(projects);

  // Once the core's copy of a project agrees with what was chosen, the choice no longer needs to be remembered here.
  useEffect(() => {
    setOverlay((o) => {
      const keys = Object.keys(o);
      const keep = keys.filter((k) => {
        const [id, key] = k.split(':') as [string, keyof ProjectNotificationPrefs];
        return projects.find((p) => p.id === id)?.notificationPrefs[key] !== o[k];
      });
      return keep.length === keys.length ? o : Object.fromEntries(keep.map((k) => [k, o[k]]));
    });
  }, [projects]);

  const set = async (project: Project, key: keyof ProjectNotificationPrefs, value: boolean) => {
    const id = `${project.id}:${key}`;
    setOverlay((o) => ({ ...o, [id]: value }));
    const result = await track(() => api.call('projects.update', { params: { id: project.id }, body: { notificationPrefs: { [key]: value } } }));
    if (!result.ok) setOverlay((o) => { const { [id]: _gone, ...rest } = o; return rest; });
  };

  return (
    <Group title="Per project" actions={<SaveStatus status={status} />}>
      {rows.length === 0 ? (
        <p className="ms-x-note">There are no projects yet.</p>
      ) : (
        <div className="ms-set-table-wrap">
          <table className="ms-set-table" aria-label="Notifications per project">
            <thead>
              <tr>
                <th scope="col" className="ms-set-table__name">Project</th>
                {PROJECT_COLUMNS.map((c) => <th key={c.key} scope="col" title={c.label}>{c.column}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <th scope="row" className="ms-set-table__name">{p.name}</th>
                  {PROJECT_COLUMNS.map((c) => {
                    const value = overlay[`${p.id}:${c.key}`] ?? p.notificationPrefs[c.key];
                    return (
                      <td key={c.key}>
                        <Switch aria-label={`${c.label}, ${p.name}`} checked={value} disabled={c.key !== 'enabled' && !(overlay[`${p.id}:enabled`] ?? p.notificationPrefs.enabled)} onChange={(v) => { void set(p, c.key, v); }} />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Group>
  );
}

export function NotificationsSection() {
  const { settings, save, status } = useSettings();
  const canShow = useApp((s) => s.system?.nativeCapabilities.notifications ?? false);
  if (!settings) return <p className="ms-x-note">Settings are not loaded yet.</p>;

  return (
    <div className="ms-set-page">
      <PageStatus status={status} />

      <Group title="On this PC">
        <SwitchRow
          label="Show desktop notifications"
          checked={settings.notifications.native}
          onChange={(v) => { void save({ notifications: { native: v } }); }}
        />
        {!canShow ? <p className="ms-x-note">This window cannot show system notifications, so nothing appears even when this is on. The Activity feed still records everything.</p> : null}
      </Group>

      <QuietSettings settings={settings} save={save} />
      <Defaults settings={settings} save={save} />
      <ProjectTable />
    </div>
  );
}
