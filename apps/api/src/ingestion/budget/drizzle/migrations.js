import m0000 from "./0000_flashy_hex.sql"
import m0001 from "./0001_budget_receipt_indexes.sql"
import m0002 from "./0002_open_hold_expiry.sql"
import m0003 from "./0003_open_hold_due_backfill.sql"
import m0004 from "./0004_ledger_operations_hold_key_index.sql"
import m0005 from "./0005_burly_blazing_skull.sql"
import m0006 from "./0006_youthful_yellowjacket.sql"
import m0007 from "./0007_reset_rows_before_usage_vectors.sql"
import m0008 from "./0008_statements_positions_cards.sql"
import m0009 from "./0009_operation_journal.sql"
import m0010 from "./0010_budget_funding.sql"
import m0011 from "./0011_journal_backlog.sql"
import journal from "./meta/_journal.json"

export default {
  journal,
  migrations: {
    m0000,
    m0001,
    m0002,
    m0003,
    m0004,
    m0005,
    m0006,
    m0007,
    m0008,
    m0009,
    m0010,
    m0011,
  },
}
