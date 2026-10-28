-- Let hard deletes of customers (and the projects/workspaces that cascade to
-- them) commit. wallet_credits rows cascade away with their customer, but the
-- customer's pgledger accounts are kept (ledger history is never rewritten),
-- so the deferred wallet_credits_invariant_check used to fail at COMMIT with
-- check_violation. On DELETE, skip the check when the owning customer row no
-- longer exists; INSERT/UPDATE and deletes of live customers' credits are
-- still checked. Keep in sync with src/helpers/wallet-triggers.sql.

CREATE OR REPLACE FUNCTION assert_wallet_credits_match_ledger()
RETURNS TRIGGER AS $$
DECLARE
  v_customer_id    TEXT;
  v_credit_sum           NUMERIC;
  v_ledger_balance       NUMERIC;
  v_ledger_balance_minor NUMERIC;
  v_account_name         TEXT;
BEGIN
  -- TG_OP is 'INSERT', 'UPDATE', or 'DELETE'. NEW is null for DELETE.
  v_customer_id := COALESCE(NEW.customer_id, OLD.customer_id);
  v_account_name := 'customer.' || v_customer_id || '.available.granted';

  -- A credit row removed because its customer was deleted in the same
  -- transaction (customer -> wallet_credits ON DELETE CASCADE, e.g. a
  -- project/workspace hard-delete) has no wallet left to reconcile. The
  -- pgledger accounts are append-only history and are not removed, so their
  -- balance would never match the (now empty) credits set. Skip the check
  -- only in that case; every other write keeps the invariant.
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1
      FROM unprice_customers
     WHERE id = OLD.customer_id
       AND project_id = OLD.project_id
  ) THEN
    RETURN NULL;
  END IF;

  -- Sum active credits for this customer (post-commit state).
  SELECT COALESCE(SUM(remaining_amount), 0)
    INTO v_credit_sum
    FROM unprice_wallet_credits
   WHERE customer_id = v_customer_id
     AND expired_at IS NULL
     AND voided_at IS NULL;

  -- Pgledger balance of the granted sub-account.
  -- COALESCE handles the case where the account hasn't been seeded yet
  -- (which is only valid if there are also no active credits).
  SELECT COALESCE(balance, 0)
    INTO v_ledger_balance
    FROM pgledger_accounts_view
   WHERE name = v_account_name;

  IF v_ledger_balance IS NULL THEN
    v_ledger_balance := 0;
  END IF;

  -- wallet_credits stores amounts as ledger-scale minor units. pgledger
  -- stores account balances as decimal money at scale 8, so normalize before
  -- comparing or tiny valid grants such as 1 minor unit fail at commit.
  v_ledger_balance_minor := v_ledger_balance * 100000000;

  IF v_credit_sum <> v_ledger_balance_minor THEN
    RAISE EXCEPTION
      'wallet_credits invariant violated for customer %: credits_sum_minor=%, granted_balance_minor=%, granted_balance=% (account=%)',
      v_customer_id, v_credit_sum, v_ledger_balance_minor, v_ledger_balance, v_account_name
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
