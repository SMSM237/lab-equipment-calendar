// Keep the backend address in the deployment environment, not the source code.
const routes = {
  state: ['/api/state', 'GET'],
  login: ['/auth/google/start', 'GET'],
  callback: ['/auth/google/callback', 'GET'],
  logout: ['/api/logout', 'POST'],
  profile: ['/api/profile', 'POST'],
  equipment: ['/api/equipment', 'POST'],
  booking: ['/api/bookings', 'POST'],
  deleteBooking: ['/api/bookings/delete', 'POST'],
};
const routeByPath = Object.fromEntries(Object.entries(routes).map(([key, value]) => [value[0], key]));
const noStore = {'Cache-Control': 'no-store, private', 'Content-Type': 'application/json; charset=utf-8'};
const errorResponse = (message, status) => new Response(JSON.stringify({error:message}), {status, headers:noStore});

export default {
  async fetch(request) {
    const incoming = new URL(request.url);
    const route = routeByPath[incoming.pathname] || incoming.searchParams.get('__calendar_route');
    const target = routes[route];
    if (!target) return errorResponse('요청한 항목을 찾을 수 없습니다.', 404);
    if (request.method !== target[1]) return errorResponse('허용되지 않은 요청입니다.', 405);
    let origin;
    try {
      origin = new URL(process.env.WORKER_ORIGIN);
      if (origin.protocol !== 'https:' || origin.origin !== process.env.WORKER_ORIGIN ||
          !origin.hostname.endsWith('.workers.dev') || origin.username || origin.password) throw new Error();
    } catch { return errorResponse('서버 연결 설정이 완료되지 않았습니다.', 503); }
    const destination = new URL(target[0], origin);
    for (const [key, value] of incoming.searchParams) {
      if (key !== '__calendar_route') destination.searchParams.append(key, value);
    }
    const headers = new Headers();
    for (const name of ['cookie', 'origin', 'content-type']) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    let body;
    if (request.method === 'POST') {
      if (Number(request.headers.get('content-length') || 0) > 32768) return errorResponse('요청 내용이 너무 큽니다.', 400);
      body = await request.arrayBuffer();
      if (body.byteLength > 32768) return errorResponse('요청 내용이 너무 큽니다.', 400);
    }
    try {
      const result = await fetch(destination, {method:request.method, headers, body, redirect:'manual', signal:AbortSignal.timeout(10000)});
      const responseHeaders = new Headers();
      for (const name of ['content-type', 'cache-control', 'cdn-cache-control', 'vercel-cdn-cache-control', 'x-content-type-options', 'x-frame-options', 'referrer-policy', 'location', 'set-cookie']) {
        const value = result.headers.get(name);
        if (value) responseHeaders.set(name, value);
      }
      responseHeaders.set('Cache-Control', 'no-store, private');
      return new Response(result.body, {status:result.status, headers:responseHeaders});
    } catch { return errorResponse('서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.', 503); }
  },
};
