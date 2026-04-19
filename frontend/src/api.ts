const API = '/api'

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<{ data?: T; error?: string }> {
  const url = path.startsWith('http') ? path : `${API}${path}`
  const res = await fetch(url, options)
  const text = await res.text()
  let body: { error?: string } = {}
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = { error: text || res.statusText }
    }
  }
  if (!res.ok) {
    return { error: body.error || res.statusText || String(res.status) }
  }
  if (!text) return { data: undefined as T }
  try {
    return { data: JSON.parse(text) as T }
  } catch {
    return { data: undefined as T }
  }
}

export const api = {
  get: <T>(path: string) =>
    request<T>(path, { headers: { 'Content-Type': 'application/json' } }),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, {
      method: 'PUT',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
  delete: (path: string) =>
    request(path, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } }),
  // For multipart/form-data — let browser set Content-Type with boundary automatically
  postFile: <T>(path: string, formData: FormData) =>
    request<T>(path, { method: 'POST', body: formData }),
}
