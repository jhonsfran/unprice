// TODO: publish this file to npm
;(() => {
  const STORAGE_KEY = "session-id"
  const storageMethods = {
    cookie: "cookie",
    localStorage: "localStorage",
    sessionStorage: "sessionStorage",
  }
  let STORAGE_METHOD = storageMethods.cookie

  // biome-ignore lint/style/useSingleVarDeclarator: <explanation>
  let proxy, domain, planIds, pageId, projectId
  if (document.currentScript) {
    proxy = document.currentScript.getAttribute("data-proxy")
    domain = document.currentScript.getAttribute("data-domain")
    planIds = document.currentScript.getAttribute("data-plan-ids")
    pageId = document.currentScript.getAttribute("data-page-id")
    projectId = document.currentScript.getAttribute("data-project-id")
    STORAGE_METHOD = document.currentScript.getAttribute("data-storage") || STORAGE_METHOD
  }

  /**
   * Generate uuid to identify the session. Random, not data-derived
   */
  function _uuidv4() {
    return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) =>
      (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)
    )
  }

  function _getSessionIdFromCookie() {
    const cookie = {}
    document.cookie.split(";").forEach((el) => {
      const [key, value] = el.split("=")
      cookie[key.trim()] = value
    })
    return cookie[STORAGE_KEY]
  }

  function _getSessionId() {
    if ([storageMethods.localStorage, storageMethods.sessionStorage].includes(STORAGE_METHOD)) {
      const storage = STORAGE_METHOD === storageMethods.localStorage ? localStorage : sessionStorage
      const serializedItem = storage.getItem(STORAGE_KEY)

      if (!serializedItem) {
        return null
      }

      let item = null

      try {
        item = JSON.parse(serializedItem)
      } catch (_error) {
        return null
      }

      if (typeof item !== "object" || item === null) {
        return null
      }

      const now = new Date()

      if (now.getTime() > item.expiry) {
        storage.removeItem(STORAGE_KEY)
        return null
      }

      return item.value
    }

    return _getSessionIdFromCookie()
  }

  function _setSessionIdFromCookie(sessionId) {
    let cookieValue = `${STORAGE_KEY}=${sessionId}; Max-Age=1800; path=/; secure`

    if (domain) {
      cookieValue += `; domain=${domain}`
    }

    document.cookie = cookieValue
  }

  function _setSessionId() {
    /**
     * Try to keep same session id if it exists, generate a new one otherwise.
     *   - First request in a session will generate a new session id
     *   - The next request will keep the same session id and extend the TTL for 30 more minutes
     */

    const sessionId = _getSessionId() || _uuidv4()
    if ([storageMethods.localStorage, storageMethods.sessionStorage].includes(STORAGE_METHOD)) {
      const now = new Date()
      const item = {
        value: sessionId,
        expiry: now.getTime() + 1800 * 1000,
      }
      const value = JSON.stringify(item)
      const storage = STORAGE_METHOD === storageMethods.localStorage ? localStorage : sessionStorage
      return STORAGE_METHOD === storage.setItem(STORAGE_KEY, value)
    }

    return _setSessionIdFromCookie(sessionId)
  }

  /**
   * Try to mask PPI and potential sensible attributes
   *
   * @param  { object } payload Event payload
   * @return { object } Sanitized payload
   */
  const _maskSuspiciousAttributes = (payload) => {
    const attributesToMask = [
      "username",
      "user",
      "user_id",
      "userid",
      "password",
      "pass",
      "pin",
      "passcode",
      "token",
      "api_token",
      "email",
      "address",
      "phone",
      "sex",
      "gender",
      "order",
      "order_id",
      "orderid",
      "payment",
      "credit_card",
    ]

    // Deep copy
    let _payload = JSON.stringify(payload)
    attributesToMask.forEach((attr) => {
      _payload = _payload.replaceAll(new RegExp(`("${attr}"):(".+?"|\\d+)`, "mgi"), '$1:"********"')
    })

    return _payload
  }

  /**
   * Send event to endpoint
   *
   * @param  { string } name Event name
   * @param  { object } payload Event payload
   * @return { object } request response
   */
  async function _sendEvent(name, payload) {
    _setSessionId()
    // Events only go to the app's own tracking route, never to a third party with a token.
    const url = `${(proxy || "").trim().replace(/\/+$/, "")}/api/tracking`

    // The route accepts the payload only as a JSON string; page_id is always sent.
    const processedPayload = _maskSuspiciousAttributes(
      Object.assign({}, payload, { page_id: pageId })
    )

    const session_id = _getSessionId() || _uuidv4()

    const request = new XMLHttpRequest()
    request.open("POST", url, true)
    request.setRequestHeader("Content-Type", "application/json")
    request.send(
      JSON.stringify({
        // timestamp: new Date().toISOString(),
        action: name,
        // version: "1",
        session_id,
        project_id: projectId,
        payload: processedPayload,
      })
    )
  }

  /**
   * Track page hit
   */
  function _trackPageHit() {
    // If local development environment
    // if (/^localhost$|^127(\.[0-9]+){0,2}\.[0-9]+$|^\[::1?\]$/.test(location.hostname) || location.protocol === 'file:') return;
    // If test environment
    if (window.__nightmare || window.navigator.webdriver || window.Cypress) return

    let locale
    try {
      locale = navigator.languages?.length
        ? navigator.languages[0]
        : navigator.userLanguage || navigator.language || navigator.browserLanguage || "en"
    } catch (_error) {
      // ignore error
    }

    // Wait a bit for SPA routers
    setTimeout(() => {
      _sendEvent("page_hit", {
        locale: locale || "en",
        referrer: document.referrer,
        pathname: window.location.pathname,
        url: window.location.href,
        plan_ids: planIds,
      })
    }, 300)
  }

  // Client
  window.Unprice = { trackEvent: _sendEvent }

  // Event listener
  window.addEventListener("hashchange", _trackPageHit)
  const his = window.history
  if (his.pushState) {
    const originalPushState = his.pushState
    his.pushState = function () {
      // biome-ignore lint/style/noArguments: <explanation>
      originalPushState.apply(this, arguments)
      _trackPageHit()
    }
    window.addEventListener("popstate", _trackPageHit)
  }

  let lastPage
  function handleVisibilityChange() {
    if (!lastPage && document.visibilityState === "visible") {
      _trackPageHit()
    }
  }

  if (document.visibilityState === "prerender") {
    document.addEventListener("visibilitychange", handleVisibilityChange)
  } else {
    _trackPageHit()
  }
})()
