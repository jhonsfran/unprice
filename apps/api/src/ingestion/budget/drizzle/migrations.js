import m0000 from "./0000_flashy_hex.sql"
import m0001 from "./0001_budget_receipt_indexes.sql"
import m0002 from "./0002_open_hold_expiry.sql"
import m0003 from "./0003_open_hold_due_backfill.sql"
import m0004 from "./0004_ledger_operations_hold_key_index.sql"
import journal from "./meta/_journal.json"

export default {
  journal,
  migrations: {
    m0000,
    m0001,
    m0002,
    m0003,
    m0004,
  },
}
