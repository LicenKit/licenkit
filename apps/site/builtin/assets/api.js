/** Customer requests keep authentication data in memory and never retry writes. */
export class CustomerApiError extends Error {
  constructor(message, { code = "REQUEST_FAILED", status = 0, requestId = null, outcomeUnknown = false } = {}) {
    super(message);
    this.name = "CustomerApiError";
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.outcomeUnknown = outcomeUnknown;
  }
}

export function createCustomerApi(apiBaseUrl, { fetchImpl = globalThis.fetch, origin = globalThis.location?.origin } = {}) {
  const base = new URL(`${apiBaseUrl.replace(/\/+$/, "")}/`, origin);
  let csrfToken = null;
  let csrfRequest = null;

  async function request(path, { method = "GET", body, csrf = true } = {}) {
    const writing = method === "POST";
    if (!path.startsWith("/customer/") || /(?:^|\/)\.\.(?:\/|$)|[?#\\]/u.test(path)) {
      throw new CustomerApiError("The requested customer address is invalid.", { code: "CUSTOMER_REQUEST_INVALID" });
    }
    const headers = new Headers({ Accept: "application/json" });
    if (writing) {
      headers.set("Content-Type", "application/json");
      if (csrf) headers.set("X-CSRF-Token", await getCsrfToken());
    }
    let response;
    try {
      response = await fetchImpl(new URL(path.slice(1), base), {
        method, headers, credentials: "include", cache: "no-store", referrerPolicy: "no-referrer",
        ...(writing ? { body: JSON.stringify(body ?? {}) } : {}),
      });
    } catch {
      throw new CustomerApiError("The server could not be reached.", {
        code: "CUSTOMER_NETWORK_ERROR", outcomeUnknown: writing,
      });
    }
    let envelope;
    try {
      envelope = await response.json();
    } catch {
      throw new CustomerApiError("The server returned an unreadable response.", {
        code: "CUSTOMER_RESPONSE_INVALID", status: response.status,
        requestId: response.headers.get("x-request-id"), outcomeUnknown: writing,
      });
    }
    if (!response.ok || envelope?.success !== true) {
      const failure = envelope?.error;
      throw new CustomerApiError(typeof failure?.message === "string" ? failure.message : "The request could not be completed.", {
        code: typeof failure?.code === "string" ? failure.code : "REQUEST_FAILED",
        status: response.status,
        requestId: typeof failure?.request_id === "string" ? failure.request_id : response.headers.get("x-request-id"),
        outcomeUnknown: writing && response.status >= 500,
      });
    }
    if (envelope.data === undefined || envelope.data === null) {
      throw new CustomerApiError("The server response is incomplete.", {
        code: "CUSTOMER_RESPONSE_INVALID", status: response.status,
        requestId: response.headers.get("x-request-id"), outcomeUnknown: writing,
      });
    }
    return envelope.data;
  }

  async function getCsrfToken() {
    if (csrfToken) return csrfToken;
    if (!csrfRequest) {
      csrfRequest = request("/customer/auth/csrf-token").then((data) => {
        setCsrfToken(data?.csrf_token);
        return csrfToken;
      }).finally(() => { csrfRequest = null; });
    }
    return csrfRequest;
  }

  function setCsrfToken(value) {
    if (typeof value !== "string" || !value) {
      throw new CustomerApiError("The request verification information is missing.", { code: "CUSTOMER_RESPONSE_INVALID" });
    }
    csrfToken = value;
  }

  return {
    get: (path) => request(path),
    post: (path, body = {}, options = {}) => request(path, { ...options, method: "POST", body }),
    setCsrfToken,
    clear: () => { csrfToken = null; },
  };
}

/** Read and immediately remove the fragment before initializing any page. */
export function takeLoginToken(location, history) {
  const parameters = new URLSearchParams(location.hash.replace(/^#/, ""));
  const tokens = parameters.getAll("token");
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  const token = tokens.length === 1 ? tokens[0] : null;
  return typeof token === "string" && token.length >= 32 && token.length <= 256 ? token : null;
}

export function isLoginRequired(error) {
  return error?.status === 401 && ["UNAUTHORIZED", "CUSTOMER_RECENT_AUTH_REQUIRED"].includes(error.code);
}

export function validatePortalUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new CustomerApiError("The payment management address is invalid.", { code: "CUSTOMER_RESPONSE_INVALID" }); }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new CustomerApiError("The payment management address is invalid.", { code: "CUSTOMER_RESPONSE_INVALID" });
  }
  return url.href;
}
