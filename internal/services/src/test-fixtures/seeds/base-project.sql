INSERT INTO "unprice_user" (
  "id",
  "name",
  "email",
  "emailVerified",
  "image",
  "theme",
  "default_wk_slug",
  "password",
  "onboarding_completed",
  "onboarding_completed_at"
) VALUES (
  'user_test_owner',
  'Billing Test Owner',
  'billing-test-owner@example.com',
  '2026-01-01T00:00:00Z',
  NULL,
  'dark',
  'billing-test',
  NULL,
  true,
  '2026-01-01T00:00:00Z'
) ON CONFLICT DO NOTHING;

INSERT INTO "unprice_workspaces" (
  "id",
  "created_at_m",
  "updated_at_m",
  "slug",
  "name",
  "is_personal",
  "is_internal",
  "is_main",
  "created_by",
  "image_url",
  "unprice_customer_id",
  "plan",
  "enabled"
) VALUES (
  'workspace_test',
  1767225600000,
  1767225600000,
  'billing-test',
  'Billing Test Workspace',
  false,
  false,
  false,
  'user_test_owner',
  NULL,
  'cus_test_owner',
  'PRO',
  true
) ON CONFLICT DO NOTHING;

INSERT INTO "unprice_members" (
  "created_at_m",
  "updated_at_m",
  "workspace_id",
  "user_id",
  "role"
) VALUES (
  1767225600000,
  1767225600000,
  'workspace_test',
  'user_test_owner',
  'OWNER'
) ON CONFLICT DO NOTHING;

INSERT INTO "unprice_projects" (
  "id",
  "workspace_id",
  "created_at_m",
  "updated_at_m",
  "slug",
  "name",
  "url",
  "enabled",
  "is_internal",
  "is_main",
  "default_currency",
  "timezone",
  "contact_email",
  "metadata"
) VALUES (
  'proj_test',
  'workspace_test',
  1767225600000,
  1767225600000,
  'billing-test',
  'Billing Test Project',
  'https://billing-test.example.com',
  true,
  false,
  false,
  'EUR',
  'UTC',
  'billing-test-owner@example.com',
  '{}'::json
) ON CONFLICT DO NOTHING;

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
  'cus_test_owner',
  'proj_test',
  1767225600000,
  1767225600000,
  'billing-test-owner@example.com',
  'Billing Test Owner',
  NULL,
  'billing-test-owner',
  '{}'::json,
  true,
  false,
  'EUR',
  'UTC'
) ON CONFLICT DO NOTHING;

INSERT INTO "unprice_apikeys" (
  "id",
  "project_id",
  "created_at_m",
  "updated_at_m",
  "expires_at_m",
  "last_used_m",
  "revoked_at_m",
  "is_root",
  "name",
  "hash",
  "default_customer_id"
) VALUES (
  'apikey_test_root',
  'proj_test',
  1767225600000,
  1767225600000,
  NULL,
  NULL,
  NULL,
  true,
  'Billing Test Root Key',
  '92488e1e3eeecdf99f3ed2ce59233efb4b4fb612d5655c0ce9ea52b5a502e655',
  NULL
) ON CONFLICT DO NOTHING;

INSERT INTO "unprice_payment_provider_config" (
  "id",
  "project_id",
  "created_at_m",
  "updated_at_m",
  "active",
  "payment_provider",
  "key",
  "key_iv",
  "webhook_secret",
  "webhook_secret_iv",
  "connection_type",
  "mode",
  "status",
  "external_account_id",
  "connection_data"
) VALUES (
  'ppc_test_sandbox',
  'proj_test',
  1767225600000,
  1767225600000,
  true,
  'sandbox',
  NULL,
  NULL,
  'sandbox_test_secret',
  NULL,
  'managed_connection',
  'test',
  'active',
  NULL,
  '{}'::json
) ON CONFLICT DO NOTHING;

INSERT INTO "unprice_events" (
  "id",
  "project_id",
  "created_at_m",
  "updated_at_m",
  "slug",
  "name",
  "available_properties"
) VALUES (
  'evt_test_completions',
  'proj_test',
  1767225600000,
  1767225600000,
  'completions',
  'Completions',
  '["events","keys"]'::json
) ON CONFLICT DO NOTHING;

INSERT INTO "unprice_features" (
  "id",
  "project_id",
  "created_at_m",
  "updated_at_m",
  "slug",
  "code",
  "unit_of_measure",
  "title",
  "description",
  "meter_config"
) VALUES
  (
    'feat_test_access_pro',
    'proj_test',
    1767225600000,
    1767225600000,
    'access-pro',
    1001,
    'access',
    'Access Pro',
    'Paid access entitlement',
    NULL
  ),
  (
    'feat_test_events',
    'proj_test',
    1767225600000,
    1767225600000,
    'events',
    1002,
    'event',
    'Events',
    'Usage events',
    '{"eventId":"evt_test_completions","eventSlug":"completions","aggregationMethod":"sum","aggregationField":"events"}'::json
  ),
  (
    'feat_test_apikeys',
    'proj_test',
    1767225600000,
    1767225600000,
    'apikeys',
    1003,
    'key',
    'API Keys',
    'API key usage',
    '{"eventId":"evt_test_completions","eventSlug":"completions","aggregationMethod":"sum","aggregationField":"keys"}'::json
  )
ON CONFLICT DO NOTHING;
