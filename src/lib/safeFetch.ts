export interface ApiResponse<T> {
  ok: boolean;
  status: number;
  data: T;
}

function getEndpointLabel(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input.split('?')[0];
  if (input instanceof URL) return input.pathname;
  return input.url.split('?')[0];
}

/**
 * Safely parses JSON responses from API endpoints.
 * Prevents "Unexpected token '<', '<!doctype ...' is not valid JSON" when an HTML
 * fallback, stale Service Worker response, or proxy auth page is returned.
 */
export async function safeFetchJson<T extends { error?: string }>(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<ApiResponse<T>> {
  const headers = new Headers(init?.headers);
  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json');
  }

  const res = await fetch(input, {
    cache: 'no-store',
    credentials: 'same-origin',
    ...init,
    headers,
  });

  const rawText = await res.text();
  const trimmed = rawText.trim();

  if (!trimmed) {
    return {
      ok: res.ok,
      status: res.status,
      data: {} as T,
    };
  }

  if (trimmed.startsWith('<')) {
    const endpoint = getEndpointLabel(input);
    const titleMatch = /<title>([^<]+)<\/title>/i.exec(trimmed);
    const htmlTitle = titleMatch ? titleMatch[1].trim() : '';

    // Refresh any stale Service Worker registrations automatically
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker
        .getRegistrations()
        .then((regs) => regs.forEach((r) => r.update().catch(() => undefined)))
        .catch(() => undefined);
    }

    if (res.redirected || (htmlTitle && !htmlTitle.toLowerCase().includes('vicky'))) {
      throw new Error(
        `Session or preview auth interrupted ${endpoint} (${htmlTitle || `HTTP ${res.status}`}). Reload the page and sign in again.`
      );
    }

    throw new Error(
      `API endpoint ${endpoint} returned the web app HTML instead of JSON (HTTP ${res.status}). Hard-reload the page to clear any cached service worker.`
    );
  }

  let parsed: T;
  try {
    parsed = JSON.parse(trimmed) as T;
  } catch {
    const endpoint = getEndpointLabel(input);
    throw new Error(
      `Invalid JSON response from ${endpoint} (HTTP ${res.status}). Please try again.`
    );
  }

  return {
    ok: res.ok,
    status: res.status,
    data: parsed,
  };
}
