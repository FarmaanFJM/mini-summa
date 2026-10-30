export const ICON_SIZES: number[];
/** RGBA pixels, size x size. */
export function renderIconPixels(size: number): Buffer;
/** A complete PNG file. */
export function renderIconPng(size: number): Buffer;
export function writeIcons(dir: string, sizes?: number[]): Promise<string[]>;
