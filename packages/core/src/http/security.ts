// Response headers that every answer carries.

/**
 * Strict policy for the bundled UI. `connect-src 'self'` covers the UI's own /ws socket (a same-origin WebSocket matches
 * 'self' in current Chromium), so no other host can be contacted. `style-src` keeps 'unsafe-inline' because the terminal
 * (xterm.js) injects <style> elements at run time; scripts stay `'self'` only.
 */
export const UI_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

export const isUiPath = (pathname: string): boolean => pathname === '/ui' || pathname.startsWith('/ui/');

/** Sets the security headers on a response in place and returns it. Never sets any Access-Control-* header. */
export function applySecurityHeaders(res: Response, pathname: string): Response {
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('Referrer-Policy', 'no-referrer');
  res.headers.set('X-Frame-Options', 'DENY');
  if (isUiPath(pathname)) {
    res.headers.set('Content-Security-Policy', UI_CSP);
    if (!res.headers.has('Cache-Control')) res.headers.set('Cache-Control', 'no-cache');
  } else {
    res.headers.set('Cache-Control', 'no-store');
  }
  return res;
}
