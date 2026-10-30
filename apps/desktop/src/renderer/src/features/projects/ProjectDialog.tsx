// The project dialog the shell mounts once. The ui store asks for it with openProjectDialog({ mode: 'create' }) or
// openProjectDialog({ mode: 'edit', projectId }): the first is the New project dialog, the second the project's settings.
import { useUi } from '../../app/runtime';
import { NewProject } from './NewProject';
import { ProjectSettings } from './ProjectSettings';

export function ProjectDialog() {
  const state = useUi((s) => s.projectDialog);
  const close = useUi((s) => s.closeProjectDialog);
  if (!state) return null;
  return state.mode === 'create'
    ? <NewProject key="create" onClose={close} />
    : <ProjectSettings key={state.projectId} projectId={state.projectId} onClose={close} />;
}
