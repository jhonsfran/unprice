import m0000 from "./0000_flashy_hex.sql"
import m0001 from "./0001_budget_receipt_indexes.sql"
import journal from "./meta/_journal.json"

export default {
  journal,
  migrations: {
    m0000,
    m0001,
  },
}
