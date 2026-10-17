import m0000 from "./0000_familiar_kate_bishop.sql"
import m0001 from "./0001_silly_kitty_pryde.sql"
import m0002 from "./0002_natural_kree.sql"
import journal from "./meta/_journal.json"

export default {
  journal,
  migrations: {
    m0000,
    m0001,
    m0002,
  },
}
