import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { NativeProvider } from '../../src/renderer/src/app/native';
import {
  Button, Checkbox, ConfirmDialog, CopyButton, Dialog, EmptyState, Field, IconButton, Menu, Select, SplitPane, Switch, Tabs, TextInput, toast, Toaster,
} from '../../src/renderer/src/ui';
import type { MenuEntry } from '../../src/renderer/src/ui';
import { ICONS } from '../../src/renderer/src/ui/icons.generated';
import { createFakeNative, stubRect } from './helpers';

describe('Button and IconButton', () => {
  it('uses the shared variants, and a destructive button is solid', () => {
    render(<><Button variant="primary">Save</Button><Button variant="destructive" icon="trash">Delete project</Button><Button variant="ghost">Later</Button><Button>Plain</Button></>);
    expect(screen.getByRole('button', { name: 'Save' }).className).toContain('sm-btn--primary');
    expect(screen.getByRole('button', { name: 'Delete project' }).className).toContain('sm-btn--danger');
    expect(screen.getByRole('button', { name: 'Later' }).className).toContain('sm-btn--ghost');
    expect(screen.getByRole('button', { name: 'Plain' }).className).not.toMatch(/--(primary|danger|ghost)/);
  });

  it('keeps its label while loading, announces busy and ignores presses', async () => {
    const onClick = vi.fn();
    render(<Button loading onClick={onClick}>Saving</Button>);
    const button = screen.getByRole('button', { name: 'Saving' });
    expect(button.getAttribute('aria-busy')).toBe('true');
    await userEvent.setup().click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('gives an icon button its accessible name from the required label', () => {
    render(<IconButton label="Reload" icon="refresh" />);
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  });

  it('reports toggled state', () => {
    render(<IconButton label="Maximize" icon="maximize" pressed />);
    expect(screen.getByRole('button', { name: 'Maximize' }).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('Dialog', () => {
  function Opener({ role, children }: { role?: 'dialog' | 'alertdialog'; children?: React.ReactNode }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>Open</button>
        <Dialog open={open} onClose={() => setOpen(false)} title="Rename" description="Choose a new name." role={role} footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary">Save</Button></>}>
          {children ?? <TextInput aria-label="Name" />}
        </Dialog>
      </>
    );
  }

  it('is a labelled modal dialog with its description attached', async () => {
    render(<Opener />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open' }));
    const dialog = screen.getByRole('dialog', { name: 'Rename' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    expect(within(dialog).getByText('Choose a new name.')).toBeTruthy();
  });

  it('puts focus on the first control, keeps Tab inside, and wraps both ways', async () => {
    const user = userEvent.setup();
    render(<Opener />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const field = screen.getByRole('textbox', { name: 'Name' });
    expect(document.activeElement).toBe(field);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Save' }));
    await user.tab(); // past the last control: wraps to the first
    expect(document.activeElement).toBe(field);
    await user.tab({ shift: true }); // before the first: wraps to the last
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Save' }));
  });

  it('closes on Escape and returns focus to what opened it', async () => {
    const user = userEvent.setup();
    render(<Opener />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await user.click(opener);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('closes on a backdrop press, but an alert dialog must be answered', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Opener />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    fireEvent.mouseDown(document.querySelector('.sm-backdrop') as HTMLElement);
    expect(screen.queryByRole('dialog')).toBeNull();
    unmount();

    render(<Opener role="alertdialog" />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    fireEvent.mouseDown(document.querySelector('.sm-backdrop') as HTMLElement);
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('does not close while it is busy', async () => {
    const onClose = vi.fn();
    render(<Dialog open onClose={onClose} title="Saving" busy>Wait</Dialog>);
    await userEvent.setup().keyboard('{Escape}');
    fireEvent.mouseDown(document.querySelector('.sm-backdrop') as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('makes the app behind it inert while open and releases it after', async () => {
    const user = userEvent.setup();
    render(<Opener />, { container: document.getElementById('root') as HTMLElement });
    const root = document.getElementById('root') as HTMLElement;
    expect(root.hasAttribute('inert')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(root.hasAttribute('inert')).toBe(true);
    await user.keyboard('{Escape}');
    expect(root.hasAttribute('inert')).toBe(false);
  });

  it('lets only the topmost of two dialogs react to Escape', async () => {
    const user = userEvent.setup();
    const outer = vi.fn();
    const inner = vi.fn();
    render(<><Dialog open onClose={outer} title="Outer">outer</Dialog><Dialog open onClose={inner} title="Inner">inner</Dialog></>);
    await user.keyboard('{Escape}');
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });
});

describe('ConfirmDialog', () => {
  it('a destructive confirmation names the verb, is an alert dialog and starts on Cancel', () => {
    render(<ConfirmDialog open destructive title="Delete GitManager?" description="This cannot be undone." confirmLabel="Delete project" onConfirm={() => {}} onCancel={() => {}} />);
    const dialog = screen.getByRole('alertdialog', { name: 'Delete GitManager?' });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    const confirm = within(dialog).getByRole('button', { name: 'Delete project' });
    expect(confirm.className).toContain('sm-btn--danger');
  });

  it('a plain confirmation starts on the confirm button, which is the primary action', () => {
    render(<ConfirmDialog open title="Archive?" description="Kept." confirmLabel="Archive project" onConfirm={() => {}} onCancel={() => {}} />);
    const confirm = screen.getByRole('button', { name: 'Archive project' });
    expect(document.activeElement).toBe(confirm);
    expect(confirm.className).toContain('sm-btn--primary');
  });

  it('calls the right callback', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmDialog open title="Stop?" description="Sure?" confirmLabel="Stop session" onConfirm={onConfirm} onCancel={onCancel} />);
    await user.click(screen.getByRole('button', { name: 'Stop session' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('type-to-confirm keeps the button disabled until the exact text is typed', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ConfirmDialog open destructive requireText="Acme" title="Delete workspace?" description="Gone." confirmLabel="Delete workspace" onConfirm={onConfirm} onCancel={() => {}} />);
    const confirm = screen.getByRole('button', { name: 'Delete workspace' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await user.type(screen.getByRole('textbox'), 'acme');
    expect(confirm.disabled).toBe(true);
    await user.clear(screen.getByRole('textbox'));
    await user.type(screen.getByRole('textbox'), 'Acme');
    expect(confirm.disabled).toBe(false);
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalled();
  });

  it('shows a failure inside the dialog so it can be retried', () => {
    render(<ConfirmDialog open title="Delete?" description="x" confirmLabel="Delete" error="The core refused." onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole('alert').textContent).toBe('The core refused.');
  });
});

describe('Menu', () => {
  const run = vi.fn();
  const items: MenuEntry[] = [
    { label: 'Edit project', icon: 'pencil', onSelect: () => run('edit') },
    { label: 'Archive project', icon: 'archive', onSelect: () => run('archive') },
    { label: 'Unavailable', disabled: true, onSelect: () => run('never') },
    { type: 'separator' },
    { label: 'Delete project', icon: 'trash', danger: true, onSelect: () => run('delete') },
  ];
  const ui = () => render(
    <Menu
      label="Project actions"
      items={items}
      trigger={(p) => <button type="button" ref={p.ref as never} onClick={p.onClick} onKeyDown={p.onKeyDown} aria-haspopup="menu" aria-expanded={p['aria-expanded']}>Actions</button>}
    />,
  );

  it('opens from the trigger with arrow keys or a click and focuses the first item', async () => {
    const user = userEvent.setup();
    ui();
    const trigger = screen.getByRole('button', { name: 'Actions' });
    trigger.focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menu', { name: 'Project actions' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Edit project' }));
  });

  it('moves with arrows, wraps, skips disabled items, and jumps with Home and End', async () => {
    const user = userEvent.setup();
    ui();
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Archive project' }));
    await user.keyboard('{ArrowDown}'); // skips the disabled one
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Delete project' }));
    await user.keyboard('{ArrowDown}'); // wraps
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Edit project' }));
    await user.keyboard('{ArrowUp}'); // wraps back
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Delete project' }));
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Edit project' }));
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Delete project' }));
  });

  it('jumps to an item by typing its first letters', async () => {
    const user = userEvent.setup();
    ui();
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await user.keyboard('de');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Delete project' }));
  });

  it('runs the item on Enter, closes, and returns focus to the trigger', async () => {
    run.mockClear();
    const user = userEvent.setup();
    ui();
    const trigger = screen.getByRole('button', { name: 'Actions' });
    await user.click(trigger);
    await user.keyboard('{ArrowDown}{Enter}');
    expect(run).toHaveBeenCalledWith('archive');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on Escape (focus back on the trigger) and on Tab (focus moves on)', async () => {
    const user = userEvent.setup();
    ui();
    const trigger = screen.getByRole('button', { name: 'Actions' });
    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await user.click(trigger);
    await user.keyboard('{Tab}');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes when the pointer goes down outside', async () => {
    const user = userEvent.setup();
    render(<><Menu label="m" items={items} trigger={(p) => <button type="button" ref={p.ref as never} onClick={p.onClick}>Actions</button>} /><p>elsewhere</p></>);
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await user.click(screen.getByText('elsewhere'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('marks the danger item and does not run a disabled one', async () => {
    run.mockClear();
    const user = userEvent.setup();
    ui();
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.getByRole('menuitem', { name: 'Delete project' }).className).toContain('sm-menu__item--danger');
    await user.click(screen.getByRole('menuitem', { name: 'Unavailable' }));
    expect(run).not.toHaveBeenCalled();
  });

  it('opens at a point for a context menu, controlled from outside', async () => {
    const onOpenChange = vi.fn();
    render(<Menu label="ctx" open anchorPoint={{ x: 40, y: 50 }} onOpenChange={onOpenChange} items={items} />);
    expect(screen.getByRole('menu', { name: 'ctx' })).toBeTruthy();
    await userEvent.setup().keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('uses radio items for exclusive choices', async () => {
    const user = userEvent.setup();
    render(<Menu label="Layout" items={[{ label: 'Automatic', checked: true, radio: true, onSelect: () => {} }, { label: 'Stacked', checked: false, radio: true, onSelect: () => {} }]} trigger={(p) => <button type="button" ref={p.ref as never} onClick={p.onClick}>Layout</button>} />);
    await user.click(screen.getByRole('button', { name: 'Layout' }));
    expect(screen.getByRole('menuitemradio', { name: 'Automatic' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('menuitemradio', { name: 'Stacked' }).getAttribute('aria-checked')).toBe('false');
  });
});

describe('Select', () => {
  const options = [{ value: 'a', label: 'Windows' }, { value: 'b', label: 'WSL (Ubuntu)' }, { value: 'c', label: 'Linux' }];

  function Controlled({ opts = options }: { opts?: typeof options }) {
    const [value, setValue] = useState<string | null>('a');
    return <Select aria-label="Environment" value={value} onChange={setValue} options={opts} />;
  }

  it('shows the chosen label, opens a listbox and picks with a click', async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    const trigger = screen.getByRole('button', { name: 'Environment' });
    expect(trigger.textContent).toContain('Windows');
    expect(trigger.getAttribute('aria-haspopup')).toBe('listbox');
    await user.click(trigger);
    expect(screen.getByRole('option', { name: 'Windows' }).getAttribute('aria-selected')).toBe('true');
    await user.click(screen.getByRole('option', { name: 'Linux' }));
    expect(trigger.textContent).toContain('Linux');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('works from the keyboard: open with the arrow, move, choose with Enter', async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    screen.getByRole('button', { name: 'Environment' }).focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('option', { name: 'Windows' })); // starts on the current value
    await user.keyboard('{ArrowDown}{Enter}');
    expect(screen.getByRole('button', { name: 'Environment' }).textContent).toContain('WSL (Ubuntu)');
  });

  it('adds a search field only above seven options, and filters with it', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 9 }, (_, i) => ({ value: `v${i}`, label: i === 4 ? 'Needle' : `Item ${i}` }));
    const { unmount } = render(<Controlled />);
    await user.click(screen.getByRole('button', { name: 'Environment' }));
    expect(screen.queryByRole('textbox', { name: 'Search options' })).toBeNull();
    unmount();

    render(<Controlled opts={many} />);
    await user.click(screen.getByRole('button', { name: 'Environment' }));
    const search = screen.getByRole('textbox', { name: 'Search options' });
    expect(document.activeElement).toBe(search);
    await user.type(search, 'need');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Needle']);
    await user.clear(search);
    await user.type(search, 'zzz');
    expect(screen.getByText('No matches')).toBeTruthy();
  });

  it('closes on Escape and returns focus to the control', async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    const trigger = screen.getByRole('button', { name: 'Environment' });
    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('shows the placeholder when nothing is chosen', () => {
    render(<Select aria-label="WSL" value={null} onChange={() => {}} options={options} placeholder="Which distribution?" />);
    expect(screen.getByRole('button', { name: 'WSL' }).textContent).toContain('Which distribution?');
  });
});

describe('Tabs', () => {
  function Strip({ onClose }: { onClose?: (id: string) => void }) {
    const [value, setValue] = useState('a');
    return (
      <Tabs
        label="Sessions"
        idPrefix="t"
        value={value}
        onChange={setValue}
        items={[
          { id: 'a', label: 'First', closable: true, onClose: () => onClose?.('a') },
          { id: 'b', label: 'Second', closable: true, closeLabel: 'Close second', onClose: () => onClose?.('b') },
          { id: 'c', label: 'Third' },
        ]}
      />
    );
  }

  it('is a tab list with one selected tab that is the only one in the tab order', () => {
    render(<Strip />);
    expect(screen.getByRole('tablist', { name: 'Sessions' })).toBeTruthy();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(tabs.map((t) => t.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
  });

  it('moves and selects with the arrows, wraps, and jumps with Home and End', async () => {
    const user = userEvent.setup();
    render(<Strip />);
    screen.getAllByRole('tab')[0].focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Second' }).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Second' }));
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'First' }).getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Third' }).getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'First' }).getAttribute('aria-selected')).toBe('true');
  });

  it('closes a closable tab with its button or the Delete key, and not an unclosable one', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Strip onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Close second' }));
    expect(onClose).toHaveBeenLastCalledWith('b');
    screen.getByRole('tab', { name: 'First' }).focus();
    await user.keyboard('{Delete}');
    expect(onClose).toHaveBeenLastCalledWith('a');
    screen.getByRole('tab', { name: 'Third' }).focus();
    onClose.mockClear();
    await user.keyboard('{Delete}');
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('Toaster', () => {
  it('shows a toast, announces it politely, and an error assertively', () => {
    render(<Toaster />);
    act(() => { toast({ title: 'Link copied' }); toast({ title: 'Could not save', kind: 'error' }); });
    expect(screen.getByRole('status').textContent).toContain('Link copied');
    expect(screen.getByRole('alert').textContent).toContain('Could not save');
  });

  it('shows the same message once and restarts its timer instead of stacking', () => {
    render(<Toaster />);
    act(() => { toast({ title: 'Saved' }); toast({ title: 'Saved' }); toast({ title: 'Saved' }); });
    expect(screen.getAllByText('Saved')).toHaveLength(1);
  });

  it('runs the action once and dismisses', async () => {
    vi.useFakeTimers();
    const onClick = vi.fn();
    render(<Toaster />);
    act(() => { toast({ title: 'Project archived', action: { label: 'Undo', onClick } }); });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(screen.queryByText('Project archived')).toBeNull();
  });

  it('dismisses on Escape from inside the toast', async () => {
    vi.useFakeTimers();
    render(<Toaster />);
    act(() => { toast({ title: 'Heads up', kind: 'warning' }); });
    fireEvent.keyDown(screen.getByRole('alert'), { key: 'Escape' });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(screen.queryByText('Heads up')).toBeNull();
  });

  it('expires on its own, but keeps an error until it is dismissed', async () => {
    vi.useFakeTimers();
    render(<Toaster />);
    act(() => { toast({ title: 'Quick' }); toast({ title: 'Stays', kind: 'error' }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.queryByText('Quick')).toBeNull();
    expect(screen.getByText('Stays')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(screen.queryByText('Stays')).toBeNull();
  });
});

describe('SplitPane', () => {
  function Split({ direction = 'horizontal' as 'horizontal' | 'vertical', only = null as 'first' | 'second' | null }) {
    const [ratio, setRatio] = useState(0.5);
    const [commits, setCommits] = useState<number[]>([]);
    return (
      <>
        <SplitPane
          direction={direction}
          ratio={ratio}
          onRatioChange={setRatio}
          onRatioCommit={(r) => setCommits((c) => [...c, r])}
          only={only}
          label="Resize panes"
          names={['ChatGPT', 'Claude']}
          first={<p>left side</p>}
          second={<p>right side</p>}
        />
        <output aria-label="ratio">{ratio}</output>
        <output aria-label="commits">{commits.join(',')}</output>
      </>
    );
  }
  const divider = () => screen.getByRole('separator', { name: 'Resize panes' });
  const ratio = () => Number(screen.getByLabelText('ratio').textContent);

  it('exposes a separator with its position in percent and a spoken value', () => {
    render(<Split />);
    expect(divider().getAttribute('aria-orientation')).toBe('vertical');
    expect(divider().getAttribute('aria-valuenow')).toBe('50');
    expect(divider().getAttribute('aria-valuemin')).toBe('15');
    expect(divider().getAttribute('aria-valuemax')).toBe('85');
    expect(divider().getAttribute('aria-valuetext')).toBe('ChatGPT 50 percent, Claude 50 percent');
    expect(divider().getAttribute('tabindex')).toBe('0');
  });

  it('is horizontal for a stacked split', () => {
    render(<Split direction="vertical" />);
    expect(divider().getAttribute('aria-orientation')).toBe('horizontal');
  });

  it('moves with the arrow keys of its axis, by 2 percent or 10 with Shift, and commits each step', async () => {
    const user = userEvent.setup();
    render(<Split />);
    divider().focus();
    await user.keyboard('{ArrowRight}');
    expect(ratio()).toBe(0.52);
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}');
    expect(ratio()).toBe(0.42);
    await user.keyboard('{ArrowUp}'); // wrong axis: nothing
    expect(ratio()).toBe(0.42);
    expect(screen.getByLabelText('commits').textContent).toBe('0.52,0.42');
  });

  it('answers Up and Down when stacked', async () => {
    const user = userEvent.setup();
    render(<Split direction="vertical" />);
    divider().focus();
    await user.keyboard('{ArrowDown}');
    expect(ratio()).toBe(0.52);
    await user.keyboard('{ArrowLeft}');
    expect(ratio()).toBe(0.52);
  });

  it('stops at the ends of the range, with Home and End going straight there', async () => {
    const user = userEvent.setup();
    render(<Split />);
    divider().focus();
    await user.keyboard('{End}');
    expect(ratio()).toBe(0.85);
    await user.keyboard('{ArrowRight}');
    expect(ratio()).toBe(0.85);
    await user.keyboard('{Home}');
    expect(ratio()).toBe(0.15);
  });

  it('resets to even on a double click and on Enter', async () => {
    const user = userEvent.setup();
    render(<Split />);
    divider().focus();
    await user.keyboard('{End}');
    expect(ratio()).toBe(0.85);
    await user.dblClick(divider());
    expect(ratio()).toBe(0.5);
    await user.keyboard('{Home}{Enter}');
    expect(ratio()).toBe(0.5);
  });

  it('follows the pointer while dragging, clamped, and commits once at the end', () => {
    const { container } = render(<Split />);
    stubRect(container.querySelector('.ms-split') as Element, { x: 0, y: 0, width: 1009, height: 600 });
    fireEvent.pointerDown(divider(), { button: 0, pointerId: 1, clientX: 504 });
    fireEvent.pointerMove(divider(), { pointerId: 1, clientX: 304 });
    expect(ratio()).toBeCloseTo(0.3, 1);
    fireEvent.pointerMove(divider(), { pointerId: 1, clientX: 5 });
    expect(ratio()).toBe(0.15);
    fireEvent.pointerUp(divider(), { pointerId: 1 });
    expect(screen.getByLabelText('commits').textContent).toBe('0.15');
    fireEvent.pointerMove(divider(), { pointerId: 1, clientX: 800 }); // after release: ignored
    expect(ratio()).toBe(0.15);
  });

  it('shows one pane alone and drops the divider, keeping the other mounted', () => {
    render(<Split only="second" />);
    expect(screen.queryByRole('separator')).toBeNull();
    expect(screen.getByText('right side').closest('.ms-split__pane')?.hasAttribute('hidden')).toBe(false);
    expect(screen.getByText('left side').closest('.ms-split__pane')?.hasAttribute('hidden')).toBe(true);
  });
});

describe('Field and form controls', () => {
  it('ties label, hint and error to the control', () => {
    render(<Field label="Name" hint="Shown in the sidebar." error="Give the project a name."><TextInput /></Field>);
    const input = screen.getByLabelText('Name');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('Give the project a name.');
    expect(screen.queryByText('Shown in the sidebar.')).toBeNull(); // the error replaces the hint
  });

  it('Switch is a switch that reports its state and toggles', async () => {
    const user = userEvent.setup();
    function S() { const [on, setOn] = useState(false); return <Switch aria-label="Paste assist" checked={on} onChange={setOn} />; }
    render(<S />);
    const sw = screen.getByRole('switch', { name: 'Paste assist' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    await user.click(sw);
    expect(sw.getAttribute('aria-checked')).toBe('true');
    sw.focus();
    await user.keyboard(' ');
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });

  it('Checkbox reports its state', async () => {
    const onChange = vi.fn();
    render(<Checkbox label="Remember" onChange={onChange} />);
    await userEvent.setup().click(screen.getByRole('checkbox', { name: 'Remember' }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('EmptyState states one thing and an optional single action', () => {
    render(<EmptyState action={<Button variant="primary">Create project</Button>}>No projects yet.</EmptyState>);
    expect(screen.getByText('No projects yet.')).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
});

describe('CopyButton', () => {
  it('copies through the host clipboard and says so', async () => {
    const fake = createFakeNative();
    render(<NativeProvider native={fake.native}><Toaster /><CopyButton text="hello">Copy message</CopyButton></NativeProvider>);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Copy message' }));
    expect(fake.native.clipboard.writeText).toHaveBeenCalledWith('hello');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
    expect(screen.getByText('Copied to the clipboard')).toBeTruthy();
  });

  it('reports a clipboard that refuses', async () => {
    const fake = createFakeNative();
    (fake.native.clipboard.writeText as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Clipboard is blocked'));
    render(<NativeProvider native={fake.native}><Toaster /><CopyButton text="x">Copy</CopyButton></NativeProvider>);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByText('Clipboard is blocked')).toBeTruthy();
  });
});

describe('the icon catalog', () => {
  // A line without x1, y1, x2, y2 draws nothing. The generator once dropped attributes whose names contain digits.
  const NEEDS: Record<string, string[]> = {
    path: ['d'], circle: ['cx', 'cy', 'r'], rect: ['width', 'height'], line: ['x1', 'y1', 'x2', 'y2'], polyline: ['points'], polygon: ['points'], ellipse: ['cx', 'cy', 'rx', 'ry'],
  };

  it('gives every shape the attributes its element needs to be seen', () => {
    const broken: string[] = [];
    for (const [name, shapes] of Object.entries(ICONS)) {
      for (const [tag, attrs] of shapes as readonly (readonly [string, Record<string, string>])[]) {
        const missing = (NEEDS[tag] ?? []).filter((a) => !(a in attrs));
        if (missing.length) broken.push(`${name}: <${tag}> lacks ${missing.join(', ')}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('draws the exclamation mark of the alert icon', () => {
    render(<Button icon="circle-alert">Check</Button>);
    expect(document.querySelectorAll('svg line')).toHaveLength(2);
    expect(document.querySelector('svg line')?.getAttribute('y2')).toBe('12');
  });
});
