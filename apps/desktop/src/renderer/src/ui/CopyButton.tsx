import { useEffect, useRef, useState } from 'react';
import { useNative } from '../app/native';
import { Button, IconButton } from './Button';
import { toast } from './Toaster';

export interface CopyButtonProps {
  /** The text to copy, or a function that produces it at click time. */
  text: string | (() => string | Promise<string>);
  /** Visible label. Without it the button is icon-only and `label` becomes its accessible name. */
  children?: string;
  label?: string;
  /** Say it in a toast too (useful when the button is far from where the clipboard matters). Default true. */
  announce?: boolean;
  variant?: 'secondary' | 'ghost';
  size?: 'sm' | 'md';
}

/** Copies through the desktop shell's clipboard (or the browser's) and shows a brief confirmation on the button. */
export function CopyButton({ text, children, label = 'Copy', announce = true, variant = 'ghost', size = 'md' }: CopyButtonProps) {
  const native = useNative();
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = async () => {
    try {
      const value = typeof text === 'function' ? await text() : text;
      await native.clipboard.writeText(value);
      setDone(true);
      if (announce) toast({ title: 'Copied to the clipboard', kind: 'success', durationMs: 2500 });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setDone(false), 1800);
    } catch (err) {
      toast({ title: 'Could not copy', body: err instanceof Error ? err.message : 'The clipboard is not available.', kind: 'error' });
    }
  };

  if (children === undefined) {
    return <IconButton label={done ? 'Copied' : label} icon={done ? 'check' : 'copy'} size={size} onClick={() => { void copy(); }} />;
  }
  return (
    <Button variant={variant} size={size === 'sm' ? 'sm' : 'md'} icon={done ? 'check' : 'copy'} onClick={() => { void copy(); }}>
      {done ? 'Copied' : children}
    </Button>
  );
}
