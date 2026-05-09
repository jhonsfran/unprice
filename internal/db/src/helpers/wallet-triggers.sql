-- Real-time invariant: SUM(wallet_credits.remaining_amount where active)
-- == balance(customer.{cid}.available.granted) converted to ledger minor units.
--
-- Enforced via deferred constraint trigger that fires AFTER COMMIT for each
-- modified wallet_credits row. Any transaction that violates the invariant
-- aborts at commit time, eliminating drift by construction.
--
-- All granted-balance changes go through wallet_credits writes:
--   - adjust(positive, granted source) creates a row + transfers in
--   - drainGrantedFIFO updates remaining + transfers out (granted -> reserved)
--   - expireGrant updates expired_at + transfers out (granted -> funding.*)
--
-- so the trigger catches every state change. Reads are zero-cost (no trigger
-- fires for SELECTs); writes pay one extra query at COMMIT per affected row,
-- which is fine — wallet_credits writes are infrequent compared to events.

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

-- Constraint trigger: deferred to commit, fires per row.
-- Multiple wallet_credits writes for the same customer in one tx will fire
-- the trigger N times — wasteful but correct. The check is read-only and
-- cheap (one indexed SUM, one indexed SELECT).
CREATE CONSTRAINT TRIGGER wallet_credits_invariant_check
  AFTER INSERT OR UPDATE OR DELETE ON unprice_wallet_credits
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION assert_wallet_credits_match_ledger();
