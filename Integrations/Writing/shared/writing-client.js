function abortError() { return new DOMException('请求已取消', 'AbortError'); }
function waitWithSignal(promise, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const abort = () => {signal.removeEventListener('abort', abort); reject(abortError());};
    signal?.addEventListener('abort', abort, {once: true});
    Promise.resolve(promise).then(value => {signal?.removeEventListener('abort', abort); resolve(value);}, error => {signal?.removeEventListener('abort', abort); reject(error);});
  });
}
function trustedOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('写作服务需要 HTTPS');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('写作服务必须使用本机同源 HTTPS');
  if (url.username || url.password) throw new Error('写作服务地址无效');
  return url.origin;
}

// Only codes actually exposed by WritingBridge are user-visible. Server prose,
// stack traces and unknown model errors never become UI text or Error properties.
const HTTP_FAILURE_MESSAGES = Object.freeze({
  invalid_configuration: '写作服务配置无效，请重新打开加载项。',
  requires_macos_15: '写作检查需要 macOS 15 或更新版本。',
  missing_resources: '写作资源不完整，请重新安装完整应用。',
  tls_unavailable: '本机安全连接不可用，请检查写作服务。',
  listener_unavailable: '本机写作服务未启动，请打开 Ask for GPT。',
  forbidden: '写作连接未获允许，请重新打开加载项。',
  unauthorized: '连接已失效，请关闭并重新打开加载项。',
  invalid_request: '未能读取有效文字，请重新选择内容后检查。',
  payload_too_large: '文字过长，请缩小检查范围',
  writing_busy: '写作服务忙，请稍后重试。',
  writing_timeout: '检查超时，请重试。',
  cancelled: '检查已取消。',
  writing_failed: '写作检查失败，请重试',
});

async function boundedFailureCode(response, timers) {
  let reader, timeout;
  const cancel = () => { try { void Promise.resolve(reader?.cancel()).catch(() => {}); } catch {} };
  try {
    if (response.headers?.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return null;
    reader = response.body?.getReader();
    if (!reader) return null;
    const read = (async () => {
      const chunks = []; let length = 0;
      for (let index = 0; index < 64; index++) {
        const {done, value} = await reader.read();
        if (done) {
          const bytes = new Uint8Array(length); let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          const object = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
          const code = object?.error?.code;
          return typeof code === 'string' && code.length <= 64
            && Object.prototype.hasOwnProperty.call(HTTP_FAILURE_MESSAGES, code) ? code : null;
        }
        if (!(value instanceof Uint8Array) || value.byteLength > 4096 - length) { cancel(); return null; }
        chunks.push(value); length += value.byteLength;
      }
      cancel(); return null;
    })().catch(() => null);
    return await Promise.race([read, new Promise(resolve => {
      timeout = timers.setTimeout(() => { cancel(); resolve(null); }, 2000);
    })]);
  } catch { cancel(); return null; }
  finally {
    if (timeout !== undefined) timers.clearTimeout(timeout);
    try { reader?.releaseLock(); } catch {}
  }
}

async function httpFailure(response, timers, fallback) {
  let code = response.status === 401 ? 'unauthorized' : response.status === 413 ? 'payload_too_large' : null;
  if (code) { try { void Promise.resolve(response.body?.cancel()).catch(() => {}); } catch {} }
  else code = await boundedFailureCode(response, timers);
  const error = new Error(code ? HTTP_FAILURE_MESSAGES[code] : fallback);
  error.code = code || 'writing_failed';
  return error;
}

/** Token and original text live only in memory; redirects and cross-origin hops fail closed. */
export class WritingClient {
  #origin; #fetch; #timers; #configuration = null; #bootstrap = null; #bootstrapController = null; #disposed = false; #active = new Map();
  constructor({origin = globalThis.location?.origin, fetch = globalThis.fetch?.bind(globalThis), timers = globalThis} = {}) {
    this.#origin = trustedOrigin(origin);
    if (typeof fetch !== 'function') throw new Error('无法连接写作服务');
    this.#fetch = fetch;
    this.#timers = timers;
  }

  async #loadConfiguration() {
    if (this.#disposed) throw abortError();
    if (this.#configuration) return this.#configuration;
    if (!this.#bootstrap) {
      this.#bootstrapController = new AbortController();
      this.#bootstrap = (async () => {
        const response = await this.#fetch(`${this.#origin}/v1/writing/bootstrap`, {method: 'GET', headers: {'X-AskGPT-Writing': '1'}, signal: this.#bootstrapController.signal, cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer'});
        if (!response.ok) throw await httpFailure(response, this.#timers, '无法连接写作服务');
        const configuration = await response.json();
        if (this.#disposed) throw abortError();
        if (trustedOrigin(configuration.baseURL) !== this.#origin) throw new Error('写作服务必须同源');
        if (typeof configuration.token !== 'string' || !configuration.token || /[\r\n]/.test(configuration.token)) throw new Error('写作服务凭证无效');
        if (typeof configuration.skillVersion !== 'string' || !configuration.skillVersion) throw new Error('写作规则不可用');
        this.#configuration = {token: configuration.token, skillVersion: configuration.skillVersion};
        return this.#configuration;
      })().catch(error => { this.#bootstrap = null; throw error; });
    }
    return this.#bootstrap;
  }

  async #post(path, payload, configuration, signal, closing = false) {
    if ((this.#disposed && !closing) || signal?.aborted) throw abortError();
    const cancellation = path === 'cancel' ? new AbortController() : null;
    const timeout = cancellation ? this.#timers.setTimeout(() => cancellation.abort(), 2000) : null;
    try {
      const response = await this.#fetch(`${this.#origin}/v1/writing/${path}`, {method: 'POST',
        headers: {'Content-Type': 'application/json', Authorization: `Bearer ${configuration.token}`},
        body: JSON.stringify(payload), signal: cancellation?.signal || signal, keepalive: path === 'cancel',
        cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer'});
      if (!response.ok) throw await httpFailure(response, this.#timers, '写作检查失败，请重试');
      return await response.json();
    } finally {if (timeout !== null) this.#timers.clearTimeout(timeout);}
  }

  async check(snapshot, mode, profile, {signal} = {}) {
    if (!['spelling', 'polish'].includes(mode)) throw new Error('检查类型无效');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) controller.abort();
    this.#active.set(snapshot.requestID, controller);
    try {
      if (controller.signal.aborted || this.#disposed) throw abortError();
      const configuration = await waitWithSignal(this.#loadConfiguration(), controller.signal);
      const result = await waitWithSignal(this.#post('check', {snapshot, mode, profile}, configuration, controller.signal), controller.signal);
      if (controller.signal.aborted || this.#disposed) throw abortError();
      if (result.requestID !== snapshot.requestID || result.snapshotHash !== snapshot.snapshotHash || !['completed', 'cancelled', 'stale', 'failed'].includes(result.status) || !Array.isArray(result.issues)) throw new Error('写作检查响应无效');
      if (typeof result.skillVersion !== 'string' || !result.skillVersion || (mode === 'polish' && result.skillVersion !== configuration.skillVersion)) throw new Error('写作规则版本不匹配');
      return result;
    } finally { signal?.removeEventListener('abort', abort); if (this.#active.get(snapshot.requestID) === controller) this.#active.delete(snapshot.requestID); }
  }

  async cancel(requestID) {
    this.#active.get(requestID)?.abort();
    // Before bootstrap completes no check can have reached the service.
    if (this.#disposed || !this.#configuration) return;
    return this.#post('cancel', {requestID}, this.#configuration);
  }

  async dispose() {
    if (this.#disposed) return;
    const ids = [...this.#active.keys()];
    const configuration = this.#configuration;
    this.#disposed = true;
    this.#bootstrapController?.abort();
    for (const controller of this.#active.values()) controller.abort();
    this.#active.clear(); this.#configuration = null; this.#bootstrap = null;
    if (configuration) await Promise.allSettled(ids.map(requestID => this.#post('cancel', {requestID}, configuration, undefined, true)));
  }
}
