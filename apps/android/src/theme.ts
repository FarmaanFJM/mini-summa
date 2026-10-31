// Design tokens from the vendored Summa-UI guidance (third_party/summa-ui-guidance/css/tokens.css, v0.1.0).
// Surfaces run dark to light with elevation, one emerald accent is reserved for the primary action of a view,
// and selection and focus are neutral.
//
// Deliberate exceptions for a phone, as the guidance allows with a stated reason:
//  * Type is larger than the desktop scale (body 16) because reading on a handheld at arm's length needs it.
//  * Touch targets are 48 (the guidance control height is 32 to 40 for pointers).

export const colors = {
  s0: '#141515', // page
  s1: '#1b1c1c', // panels and grouped lists
  s2: '#232424', // inputs, pressed rows, cards on a panel
  s3: '#2c2d2d', // raised controls, selected rows
  s4: '#373838', // sheets, dialogs, toasts, pressed controls
  line: 'rgba(255, 255, 255, 0.07)',
  lineStrong: 'rgba(255, 255, 255, 0.12)',
  text: '#ececeb',
  text2: '#a3a6a4',
  text3: '#6f7371',
  accent: '#10b981',
  accentHover: '#34c997',
  accentInk: '#04281d',
  accentText: '#3dd6a0',
  focus: 'rgba(236, 236, 235, 0.5)',
  select: 'rgba(255, 255, 255, 0.085)',
  selectStrong: 'rgba(255, 255, 255, 0.16)',
  danger: '#f27f7f',
  dangerSolid: '#c53d3d',
  dangerSolidHover: '#b23535',
  dangerInk: '#ffffff',
  warn: '#e0b04a',
  backdrop: 'rgba(0, 0, 0, 0.6)',
} as const;

export const radius = { sm: 6, md: 8, lg: 12, xl: 16 } as const;

export const space = { s1: 4, s2: 8, s3: 12, s4: 16, s5: 24, s6: 32, s7: 48 } as const;

export const type = {
  xs: 12,
  sm: 13.5,
  base: 16,
  lg: 18,
  xl: 22,
  xxl: 28,
} as const;

export const touch = { min: 48 } as const;

export const mono = 'monospace';
