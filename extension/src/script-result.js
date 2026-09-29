export function unwrapScriptResult(result, method) {
  const frame = Array.isArray(result) ? result[0] : result;
  const error = frame?.error;
  if (error !== undefined && error !== null) {
    const message = typeof error === 'string'
      ? error
      : (error.message ?? JSON.stringify(error));
    const code = typeof error === 'object' && error.code ? error.code : 'PAGE_ERROR';
    throw Object.assign(new Error(String(message)), { code });
  }
  const value = frame?.result;
  if (value === undefined || value === null) return null;
  return value;
}
