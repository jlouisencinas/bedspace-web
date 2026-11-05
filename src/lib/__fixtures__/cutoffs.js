// Synthetic cutoffs shaped like public.cutoffs rows. Rent/water windows run 1st -> 1st (end exclusive), electric 10th -> 10th.
// Sep 2026 is the first cutoff of the app (appStart); Sep and Oct are closed, Nov is the active one.
export const SEP = {
  id: 1, name: 'Sep 2026', is_active: false,
  water_start: '2026-09-01', water_end: '2026-10-01', electric_start: '2026-09-10', electric_end: '2026-10-10',
  water_bedspace_rate: 21, electric_bedspace_rate: 20, created_at: '2026-09-01T09:00:00+08:00',
}
export const OCT = {
  id: 2, name: 'Oct 2026', is_active: false,
  water_start: '2026-10-01', water_end: '2026-11-01', electric_start: '2026-10-10', electric_end: '2026-11-10',
  water_bedspace_rate: 22, electric_bedspace_rate: 22, created_at: '2026-10-01T09:00:00+08:00',
}
export const NOV = {
  id: 3, name: 'Nov 2026', is_active: true,
  water_start: '2026-11-01', water_end: '2026-12-01', electric_start: '2026-11-10', electric_end: '2026-12-10',
  water_bedspace_rate: 23, electric_bedspace_rate: 24, created_at: '2026-11-01T09:00:00+08:00',
}
export const CUTOFFS = [SEP, OCT, NOV]

// Oct as the active cutoff (the second-to-last-bill advance credit is detected live only on the active cutoff).
export const OCT_ACTIVE = { ...OCT, is_active: true }
