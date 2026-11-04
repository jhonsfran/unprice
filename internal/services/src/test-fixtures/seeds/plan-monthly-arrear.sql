INSERT INTO "unprice_plans" (
  "id",
  "project_id",
  "created_at_m",
  "updated_at_m",
  "slug",
  "title",
  "active",
  "description",
  "metadata",
  "default_plan",
  "enterprise_plan"
) VALUES (
  'plan_test_pro',
  'proj_test',
  1767225600000,
  1767225600000,
  'pro',
  'PRO',
  true,
  'Billing test pro plan',
  '{}'::json,
  false,
  false
) ON CONFLICT DO NOTHING;

INSERT INTO "unprice_plan_versions" (
  "id",
  "project_id",
  "created_at_m",
  "updated_at_m",
  "plan_id",
  "description",
  "latest",
  "title",
  "tags",
  "active",
  "plan_version_status",
  "published_at_m",
  "published_by",
  "archived",
  "archived_at_m",
  "archived_by",
  "payment_providers",
  "due_behaviour",
  "currency",
  "billing_config",
  "when_to_bill",
  "grace_period",
  "collection_method",
  "trial_units",
  "auto_renew",
  "metadata",
  "payment_method_required",
  "version"
) VALUES (
  'pv_test_monthly_arrear',
  'proj_test',
  1767225600000,
  1767225600000,
  'plan_test_pro',
  'Monthly arrears billing test version',
  true,
  'PRO Arrears',
  '[]'::json,
  true,
  'published',
  1767225600000,
  'user_test_owner',
  false,
  NULL,
  NULL,
  'sandbox',
  'cancel',
  'EUR',
  '{"name":"monthly","billingInterval":"month","billingIntervalCount":1,"billingAnchor":"dayOfCreation","planType":"recurring"}'::json,
  'pay_in_arrear',
  3,
  'charge_automatically',
  0,
  true,
  '{}'::json,
  false,
  1
) ON CONFLICT DO NOTHING;

INSERT INTO "unprice_plan_versions_features" (
  "id",
  "project_id",
  "created_at_m",
  "updated_at_m",
  "plan_version_id",
  "feature_config_type",
  "feature_id",
  "feature_type",
  "unit_of_measure",
  "features_config",
  "billing_config",
  "reset_config",
  "metadata",
  "order",
  "default_quantity",
  "limit",
  "meter_config"
) VALUES
  (
    'fv_test_arrear_access',
    'proj_test',
    1767225600000,
    1767225600000,
    'pv_test_monthly_arrear',
    'feature',
    'feat_test_access_pro',
    'flat',
    'access',
    '{"price":{"dinero":{"amount":9900,"currency":{"code":"EUR","base":10,"exponent":2},"scale":2},"displayAmount":"99"}}'::json,
    '{"name":"monthly","billingInterval":"month","billingIntervalCount":1,"billingAnchor":"dayOfCreation","planType":"recurring"}'::json,
    '{"name":"monthly","resetInterval":"month","resetIntervalCount":1,"resetAnchor":"dayOfCreation","planType":"recurring"}'::json,
    '{}'::json,
    1,
    1,
    NULL,
    NULL
  ),
  (
    'fv_test_arrear_events',
    'proj_test',
    1767225600000,
    1767225600000,
    'pv_test_monthly_arrear',
    'feature',
    'feat_test_events',
    'usage',
    'event',
    '{"tiers":[{"unitPrice":{"dinero":{"amount":1,"currency":{"code":"EUR","base":10,"exponent":2},"scale":3},"displayAmount":"0.001"},"flatPrice":{"dinero":{"amount":100,"currency":{"code":"EUR","base":10,"exponent":2},"scale":2},"displayAmount":"1"},"firstUnit":1,"lastUnit":1000},{"unitPrice":{"dinero":{"amount":1,"currency":{"code":"EUR","base":10,"exponent":2},"scale":1},"displayAmount":"0.1"},"flatPrice":{"dinero":{"amount":0,"currency":{"code":"EUR","base":10,"exponent":2},"scale":2},"displayAmount":"0.00"},"firstUnit":1001,"lastUnit":null}],"usageMode":"tier"}'::json,
    '{"name":"monthly","billingInterval":"month","billingIntervalCount":1,"billingAnchor":"dayOfCreation","planType":"recurring"}'::json,
    '{"name":"monthly","resetInterval":"month","resetIntervalCount":1,"resetAnchor":"dayOfCreation","planType":"recurring"}'::json,
    '{}'::json,
    2,
    NULL,
    10000,
    '{"eventId":"evt_test_completions","eventSlug":"completions","aggregationMethod":"sum","aggregationField":"events"}'::json
  )
ON CONFLICT DO NOTHING;

-- The plan version's EUR rate card (ADR-0008 D2): a 99 EUR flat fee for access, and the graduated
-- events price the payer budget charges at ingestion.
INSERT INTO "unprice_rate_cards" ("id", "project_id", "name", "unit", "margin_policy") VALUES (
  'card_test_arrear',
  'proj_test',
  'PRO Arrears EUR',
  'money:EUR',
  '{"type":"manual"}'::jsonb
) ON CONFLICT DO NOTHING;

INSERT INTO "unprice_rate_card_rows" (
  "id",
  "project_id",
  "rate_card_id",
  "feature_slug",
  "match",
  "price",
  "cost",
  "effective_from",
  "effective_to",
  "source",
  "source_ref"
) VALUES
  (
    'row_test_arrear_access',
    'proj_test',
    'card_test_arrear',
    'access-pro',
    '{}'::jsonb,
    '{"type":"flat","amount":"99"}'::jsonb,
    NULL,
    0,
    NULL,
    'manual',
    NULL
  ),
  (
    'row_test_arrear_events',
    'proj_test',
    'card_test_arrear',
    'events',
    '{}'::jsonb,
    '{"type":"graduated","property":"events","per":1,"tiers":[{"upTo":1000,"rate":"0.001","flat":"1"},{"upTo":null,"rate":"0.1","flat":"0"}]}'::jsonb,
    NULL,
    0,
    NULL,
    'manual',
    NULL
  )
ON CONFLICT DO NOTHING;

INSERT INTO "unprice_plan_version_rate_cards" (
  "id",
  "project_id",
  "plan_version_id",
  "currency",
  "rate_card_id"
) VALUES (
  'pvrc_test_arrear',
  'proj_test',
  'pv_test_monthly_arrear',
  'EUR',
  'card_test_arrear'
) ON CONFLICT DO NOTHING;
