import type { Dinero, DineroSnapshot } from "dinero.js"
import { dinero } from "dinero.js"
import superjson from "superjson"
import type { SuperJSONResult } from "superjson"

superjson.registerCustom(
  {
    isApplicable: (val): val is Dinero<number> => {
      try {
        // if this doesn't crash we're kinda sure it's a Dinero instance
        ;(val as Dinero<number>).calculator.add(1, 2)
        return true
      } catch {
        return false
      }
    },
    serialize: (val) => {
      return val.toJSON() as SuperJSONResult["json"]
    },
    deserialize: (val) => {
      return dinero(val as DineroSnapshot<number>)
    },
  },
  "Dinero"
)

export const transformer = superjson
