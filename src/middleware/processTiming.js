/**
 * Adds `X-Process-Time-Ms` to JSON and `send()` responses for §14 spot-checks.
 * Safe if `json` / `send` are called once per request (normal Express handlers).
 */
export function processTimingMiddleware(_req, res, next) {
  const t0 = Date.now();
  function setMs() {
    if (res.getHeader('X-Process-Time-Ms')) return;
    res.setHeader('X-Process-Time-Ms', String(Date.now() - t0));
  }
  const origJson = res.json.bind(res);
  res.json = (body) => {
    setMs();
    return origJson(body);
  };
  const origSend = res.send.bind(res);
  res.send = (body) => {
    setMs();
    return origSend(body);
  };
  next();
}
