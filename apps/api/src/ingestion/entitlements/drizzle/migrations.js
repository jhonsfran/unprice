import m0000 from "./0000_odd_sleeper.sql"
import m0001 from "./0001_drop_config_grants.sql"
import journal from "./meta/_journal.json"

export default {
  journal,
  migrations: {
    m0000,
    m0001,
  },
}
