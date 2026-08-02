let _cache = null

export function cacheBilling(cutoffId, perTenant) {
  _cache = { cutoffId, perTenant }
}

export function getCachedBilling(cutoffId) {
  if (!_cache || _cache.cutoffId !== cutoffId) return null
  return _cache.perTenant
}
