-- At most one active tenant per bed (tenants with bed_id null are unconstrained).
-- Already present on the live DB; this file documents it and makes fresh databases match. Idempotent.
-- Will fail to create if two active tenants currently share a bed: resolve those rows first.
create unique index if not exists uniq_active_tenant_per_bed
  on tenants(bed_id) where (is_active and bed_id is not null);
