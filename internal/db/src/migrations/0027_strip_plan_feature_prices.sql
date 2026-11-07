-- Custom SQL migration file, put your code below! --
-- ADR-0008 D2: a plan feature stores no price, tiers, or currency; the plan version's rate card owns them.
UPDATE "unprice_plan_versions_features"
SET "features_config" = ("features_config"::jsonb - 'price' - 'tiers')::json
WHERE "features_config"::jsonb ?| array['price', 'tiers'];
