import { env } from "../env"
import { Analytics } from "./analytics"

export const analytics = new Analytics({
  emit: true,
  tinybirdToken: env.TINYBIRD_TOKEN,
  tinybirdUrl: env.TINYBIRD_URL,
})
