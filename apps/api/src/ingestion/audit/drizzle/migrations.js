import m0000 from "./0000_audit_storage.sql"
import m0001 from "./0001_crazy_marvel_zombies.sql"
import journal from "./meta/_journal.json"

export default {
  journal,
  migrations: {
    m0000,
    m0001,
  },
}
