// REST client.
const TOKEN_KEY = 'yapper_token';

export const token = {
  get: () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set: (t) => { try { localStorage.setItem(TOKEN_KEY, t); } catch { /* ignore */ } },
  clear: () => { try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } },
};

export async function api(method, path, body) {
  const headers = {};
  const t = token.get();
  if (t) headers.Authorization = `Bearer ${t}`;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  let res;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: payload });
  } catch {
    throw new Error("Can't reach Yapper. Check your connection.");
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    if (res.status === 401 && t && !path.startsWith('/auth/')) {
      token.clear();
      location.href = '/login';
    }
    throw Object.assign(new Error(data?.error || `Request failed (${res.status})`), { status: res.status });
  }
  return data;
}

export const GET = (p) => api('GET', p);
export const POST = (p, b) => api('POST', p, b ?? {});
export const PATCH = (p, b) => api('PATCH', p, b ?? {});
export const PUT = (p, b) => api('PUT', p, b ?? {});
export const DEL = (p, b) => api('DELETE', p, b);

// Upload with progress (used for message attachments).
export function upload(path, form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api${path}`);
    const t = token.get();
    if (t) xhr.setRequestHeader('Authorization', `Bearer ${t}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* empty */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data?.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Can't reach Yapper. Check your connection."));
    xhr.send(form);
  });
}
