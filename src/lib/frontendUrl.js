/** Public app origin for links in emails (no trailing slash). */
export function getFrontendUrl() {
  const raw =
    process.env.FRONTEND_URL ||
    process.env.CLIENT_URL ||
    process.env.APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    '';
  const trimmed = String(raw).trim().replace(/\/+$/, '');
  if (trimmed) return trimmed;
  if (process.env.NODE_ENV !== 'production') {
    return 'http://localhost:5173';
  }
  return '';
}

export function verificationLinkForToken(token) {
  const base = getFrontendUrl();
  if (!base) {
    throw new Error('FRONTEND_URL is not configured.');
  }
  return `${base}/verify-email/${encodeURIComponent(token)}`;
}

export function invitationLinkForToken(token) {
  const base = getFrontendUrl();
  if (!base) {
    throw new Error('FRONTEND_URL is not configured.');
  }
  return `${base}/accept-invite?token=${encodeURIComponent(token)}`;
}
