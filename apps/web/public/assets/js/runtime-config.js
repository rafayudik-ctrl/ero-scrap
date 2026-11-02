/**
 * Public, non-secret runtime configuration. Set apiBaseUrl to an HTTPS API
 * origin only when the Worker is deployed on a separate hostname. Keep it
 * empty when Worker routes share the Pages hostname.
 */
window.ERO_SCRAP_CONFIG = Object.freeze({
  apiBaseUrl: '',
});
