(function (root) {
  'use strict';
  const route = '/askgpt/paper', skew = 10000, maximumNonces = 128;
  const ascii = value => Uint8Array.from(value, character => character.charCodeAt(0));
  function reply(status) {
    return [status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}, status === 200 ? '{"ok":true}' : '{"ok":false}'];
  }
  function register({Zotero, Services, readConnection, open, now = Date.now}) {
    const endpoints = Zotero.Server?.Endpoints;
    if (!endpoints || Object.hasOwn(endpoints, route)) return () => {};
    const used = new Map();
    let closed = false;
    async function handle(request) {
      const {headers, data} = request;
      if (closed) return reply(503);
      if (request.method !== 'POST' || request.pathname !== route || request.searchParams?.toString()
          || !headers || headers.host !== '127.0.0.1:23119' || 'origin' in headers || 'authorization' in headers
          || headers['content-type']?.split(';', 1)[0] !== 'application/json' || headers['content-length'] !== '2'
          || !data || Array.isArray(data) || typeof data !== 'object' || Object.keys(data).length) return reply(403);
      const timestamp = headers['x-askgpt-timestamp'], nonce = headers['x-askgpt-nonce'], proof = headers['x-askgpt-proof'];
      if (!/^[0-9]{13}$/.test(timestamp) || !/^[a-f0-9]{32}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(proof)
          || Math.abs(now() - Number(timestamp)) > skew) return reply(403);
      try {
        const connection = await readConnection();
        const subtle = Services.focus?.activeWindow?.crypto?.subtle || Zotero.getMainWindow?.()?.crypto?.subtle;
        if (!subtle) return reply(503);
        // Zotero logs incoming headers. The reusable pairing token stays local;
        // the expiring proof only authorizes one nonce on this fixed route.
        const key = await subtle.importKey('raw', ascii(connection.token), {name: 'HMAC', hash: 'SHA-256'}, false, ['verify']);
        const signature = Uint8Array.from(proof.match(/../g), pair => parseInt(pair, 16));
        const message = ascii('askgpt-paper-v1\n' + timestamp + '\n' + nonce);
        if (!await subtle.verify('HMAC', key, signature, message)) return reply(403);
        const time = now();
        if (closed) return reply(503);
        if (Math.abs(time - Number(timestamp)) > skew) return reply(403);
        for (const [previous, expires] of used) if (expires < time) used.delete(previous);
        if (used.has(nonce)) return reply(409);
        if (used.size >= maximumNonces) return reply(503);
        used.set(nonce, Number(timestamp) + skew);
        const result = await open(nonce, connection);
        return reply({ok: 200, no_reader: 404, busy: 409, stopped: 409}[result] || 503);
      } catch (_) {
        return reply(503);
      }
    }
    function Endpoint() {}
    Endpoint.prototype = {supportedMethods: ['POST'], supportedDataTypes: ['application/json'], init: handle};
    endpoints[route] = Endpoint;
    return () => {
      closed = true;
      used.clear();
      if (endpoints[route] === Endpoint) delete endpoints[route];
    };
  }
  const api = {register};
  root.AskGPTPaperShortcut = api;
  if (typeof module !== 'undefined') module.exports = api;
})(this);
