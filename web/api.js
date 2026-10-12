// Thin client for the local server: token handling, JSON calls, and the SSE event stream.
const TOKEN_KEY = "polyphony.token";

export function initToken() {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get("token");
  if (fromUrl) {
    try { localStorage.setItem(TOKEN_KEY, fromUrl); } catch { /* private mode */ }
    url.searchParams.delete("token");
    history.replaceState(null, "", url.pathname + (url.search || "") + url.hash);
    return fromUrl;
  }
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}

let token = "";

export function setToken(t) {
  token = t;
}

export function getToken() {
  return token;
}

/** Uploads one File; resolves to the attachment record. */
export async function uploadFile(file) {
  const data = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
  return post("/api/upload", { name: file.name, mime: file.type, data });
}

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `HTTP ${status}`);
    this.status = status;
    this.code = body?.code || "error";
  }
}

export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", "x-polyphony-token": token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const get = (p) => api("GET", p);
export const post = (p, b) => api("POST", p, b ?? {});
export const patch = (p, b) => api("PATCH", p, b);
export const del = (p) => api("DELETE", p);
export const put = (p, b) => api("PUT", p, b);

/** Opens the SSE stream and dispatches each event to handlers[event]. Reconnects automatically. */
export function connectEvents(handlers) {
  let es = null;
  let retry = 1000;
  const open = () => {
    es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    for (const name of Object.keys(handlers)) {
      es.addEventListener(name, (e) => {
        try { handlers[name](JSON.parse(e.data)); } catch (err) { console.error(err); }
      });
    }
    es.onopen = () => { retry = 1000; handlers.__open?.(); };
    es.onerror = () => {
      es.close();
      handlers.__closed?.();
      setTimeout(open, retry);
      retry = Math.min(retry * 2, 15000);
    };
  };
  open();
  return () => es?.close();
}
