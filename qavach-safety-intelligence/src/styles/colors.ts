// Colours for code that cannot use a CSS variable directly (canvas, image export). The values live in tokens.css.
export const cssVar = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();
