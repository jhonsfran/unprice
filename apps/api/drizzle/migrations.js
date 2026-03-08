import m0000 from "./0000_cynical_puff_adder.sql"
import m0001 from "./0001_sturdy_storage_kernel.sql"
import m0002 from "./0002_direct_metadata_buffer.sql"
import m0003 from "./0003_ack_seq_cursor_model.sql"
import journal from "./meta/_journal.json"

export default {
  journal,
  migrations: {
    m0000,
    m0001,
    m0002,
    m0003,
  },
}
