import { useLayoutEffect, useState } from 'react';
import type { RefObject } from 'react';
import type { Project } from '@minisumma/shared';
import { resolveProject } from '../../app/selectors';
import { useApp, useRoute } from '../../app/runtime';

/** The project the workspace shows: the chosen one, or the first active project when nothing valid is chosen. */
export function useSelectedProject(): Project | null {
  const projects = useApp((s) => s.projects);
  const projectId = useRoute().projectId;
  return resolveProject(projects, projectId);
}

export interface Size { width: number; height: number }

/** The size of an element, kept current. Zero until it has been laid out (or while it is hidden). */
export function useElementSize(ref: RefObject<HTMLElement | null>): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize((prev) => (prev.width === r.width && prev.height === r.height ? prev : { width: r.width, height: r.height }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}
