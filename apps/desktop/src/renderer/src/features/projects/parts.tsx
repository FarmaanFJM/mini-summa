// Small pieces both dialogs use: the quiet "Saved", a section of the settings, and the reading of a ChatGPT Project address.
import type { ReactNode } from 'react';
import { Section } from '../../ui';
import { ADDRESS_ONLY_NOTE } from './readings';
import type { AddressReading } from './readings';

/** "Saved" beside a heading for about two seconds after the core accepted a change. Plain text: not a toast and not a tag. */
export function Saved({ on }: { on: boolean }) {
  // The region exists before it has anything to say, so that a screen reader announces the word when it appears.
  return <span className="ms-pj-saved" role="status">{on ? 'Saved' : ''}</span>;
}

export interface SettingsSectionProps {
  title: string;
  saved: boolean;
  children: ReactNode;
}

/** A plain muted heading with its content at the same left edge, and the "Saved" of what changed under it. */
export function SettingsSection({ title, saved, children }: SettingsSectionProps) {
  return (
    <Section title={title} level={3} actions={<Saved on={saved} />} className="ms-pj-section">
      {children}
    </Section>
  );
}

/** What an address pasted for a ChatGPT Project will do, in a sentence. Nothing for an empty or invalid one: the field says what is wrong. */
export function addressReadingText(reading: AddressReading): string | null {
  switch (reading.kind) {
    case 'project':
      return reading.fromConversation
        ? `Title: ${reading.title}. This is a conversation inside the project, so the project page is linked.`
        : `Title: ${reading.title}`;
    case 'as-pasted': return 'Mini-Summa does not recognise this form of address. It will be opened as pasted.';
    default: return null;
  }
}

/** The hint under a ChatGPT Project address: the reading as it is typed, then the one sentence that says what is kept. */
export function AddressHint({ reading }: { reading: AddressReading }) {
  const text = addressReadingText(reading);
  return (
    <>
      <span className="ms-pj-line" aria-live="polite">{text}</span>
      <span className="ms-pj-line">{ADDRESS_ONLY_NOTE}</span>
    </>
  );
}
