INSERT INTO "unprice_customers" (
  "id",
  "project_id",
  "created_at_m",
  "updated_at_m",
  "email",
  "name",
  "description",
  "external_id",
  "metadata",
  "active",
  "is_main",
  "default_currency",
  "timezone"
) VALUES (
  'cus_test',
  'proj_test',
  1767225600000,
  1767225600000,
  'billing-test-customer@example.com',
  'Billing Test Customer',
  NULL,
  'billing-test-customer',
  '{}'::json,
  true,
  false,
  'EUR',
  'UTC'
) ON CONFLICT DO NOTHING;
