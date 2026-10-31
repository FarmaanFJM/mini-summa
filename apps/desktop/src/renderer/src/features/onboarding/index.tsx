// First run. Over an application that has no projects yet, a checklist says what is needed and what is already in place:
// Claude Code found, a first project, how ChatGPT opens, optional hooks, and for a project with a folder its ChatGPT conversation
// and a first local session. A project needs none of a ChatGPT Project, a GitHub repository or a folder, so the steps that only a
// folder makes possible are not asked of a project that has none.
//
// Every tick is read from the core (model.ts), never remembered. The checklist is never a gate: the application underneath
// is fully usable, the panel can be hidden, and Settings brings it back.
import '../reports/shared.css';
import './onboarding.css';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useApp } from '../../app/runtime';
import { Button, Icon } from '../../ui';
import { SIDEBAR_EDGE_WIDTH } from '../shell/SidebarEdge';
import { Checklist, useSetup } from './Checklist';
import { doneCount, isComplete } from './model';
import { useOnboarding } from './state';

type Place = 'center' | 'corner';

function Panel({ place }: { place: Place }) {
  const setup = useSetup();
  const prefs = useOnboarding();
  const layout = useApp((s) => s.settings?.layout);
  // With projects in place the checklist waits in the corner as a small button, so it never covers the terminal.
  const [open, setOpen] = useState(false);
  const ready = setup.facts.envs !== null;
  const complete = ready && isComplete(setup.steps);

  // Once everything that matters is in place the checklist has nothing left to say.
  useEffect(() => { if (complete && place === 'corner') prefs.dismiss(); }, [complete, place, prefs]);
  // For a returning window the panel waits for the first answer instead of flashing unticked.
  if (place === 'corner' && (!ready || complete)) return null;

  const { done, total } = doneCount(setup.steps);
  const offset = layout?.sidebarCollapsed ? SIDEBAR_EDGE_WIDTH : layout?.sidebarWidth ?? 260;
  const compact = place === 'corner';
  return (
    <div className="ms-onb-layer" data-place={place} style={{ ['--ms-onb-offset' as string]: `${offset}px` }}>
      {compact && !open ? (
        <button type="button" className="ms-onb-pill" aria-expanded="false" onClick={() => setOpen(true)}>
          <Icon name="list-check" size={14} />Setup: {done} of {total} done
        </button>
      ) : (
        <section className="ms-onb" role="region" aria-label="Set up Mini-Summa">
          <header className="ms-onb__head">
            <h2 className="ms-onb__title">Set up Mini-Summa</h2>
            <p className="ms-x-note">{done} of {total} done. You can use Mini-Summa without finishing this.</p>
          </header>
          <Checklist setup={setup} compact={compact} />
          <footer className="ms-onb__foot">
            <p className="ms-x-note">You can bring this back from Settings, under About and setup.</p>
            <div className="ms-x-actions">
              {compact ? <Button variant="ghost" onClick={() => setOpen(false)}>Minimize</Button> : null}
              <Button variant="ghost" onClick={prefs.dismiss}>Hide the checklist</Button>
            </div>
          </footer>
        </section>
      )}
    </div>
  );
}

function OnboardingLayer() {
  const loaded = useApp((s) => s.loaded);
  const noProjects = useApp((s) => s.projects.length === 0);
  const prefs = useOnboarding();
  const { markSeenEmpty } = prefs;

  // An application opened with nothing in it is a new installation. Seeing it so once is what lets the checklist follow
  // the person into their first project; an installation that already had projects is never nagged.
  useEffect(() => { if (loaded && noProjects) markSeenEmpty(); }, [loaded, noProjects, markSeenEmpty]);

  if (!loaded || prefs.dismissed || !(noProjects || prefs.seenEmpty)) return null;
  return <Panel place={noProjects ? 'center' : 'corner'} />;
}

export default function OnboardingGate({ children }: { children?: ReactNode }) {
  return (
    <>
      {children}
      <OnboardingLayer />
    </>
  );
}
