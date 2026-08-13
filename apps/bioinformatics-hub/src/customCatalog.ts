/**
 * User-defined sites and categories, persisted in localStorage.
 *
 * Custom sites render with the same card design as the built-in catalog and,
 * once selected into a session, behave like any `open_only` site (opened in
 * batches, result URL capture, research bundle export).
 */

export type CustomGroup = {
  id: string
  name: string
}

export type CustomSite = {
  id: string
  groupId: string
  name: string
  entryUrl: string
  note?: string
}

export type CustomCatalog = {
  groups: CustomGroup[]
  sites: CustomSite[]
}

const STORAGE_KEY = 'bioinformaticshub.customSites.v1'

export function newCustomId(prefix: 'group' | 'site'): string {
  const rand = Math.random().toString(36).slice(2, 10)
  return `custom_${prefix}_${Date.now().toString(36)}${rand}`
}

export function loadCustomCatalog(): CustomCatalog {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { groups: [], sites: [] }
    const parsed = JSON.parse(raw) as Partial<CustomCatalog>
    const groups = Array.isArray(parsed.groups)
      ? parsed.groups.filter(
          (g): g is CustomGroup => Boolean(g && typeof g.id === 'string' && typeof g.name === 'string'),
        )
      : []
    const sites = Array.isArray(parsed.sites)
      ? parsed.sites.filter(
          (s): s is CustomSite =>
            Boolean(
              s &&
                typeof s.id === 'string' &&
                typeof s.groupId === 'string' &&
                typeof s.name === 'string' &&
                typeof s.entryUrl === 'string',
            ),
        )
      : []
    return { groups, sites }
  } catch {
    return { groups: [], sites: [] }
  }
}

export function saveCustomCatalog(catalog: CustomCatalog): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(catalog))
  } catch {
    /* storage unavailable or full */
  }
}

export function normalizeCustomUrl(value: string): string | null {
  try {
    const url = new URL(value.trim())
    if (!['http:', 'https:'].includes(url.protocol)) return null
    return url.toString()
  } catch {
    return null
  }
}
