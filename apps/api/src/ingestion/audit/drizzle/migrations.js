import m0000 from "./0000_audit_storage.sql"
import m0001 from "./0001_crazy_marvel_zombies.sql"
import m0002 from "./0002_nebulous_skin.sql"
import m0003 from "./0003_sharp_tombstone.sql"
import m0004 from "./0004_wonderful_squadron_supreme.sql"
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
