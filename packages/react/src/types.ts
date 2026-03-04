import type { Unprice, UnpriceOptions } from "@unprice/api"
import type { PropsWithChildren } from "react"

export type UnpriceClientProviderProps = PropsWithChildren<{
  /**
   * Either provide a pre-configured client instance
   */
  client?: Unprice
  /**
   * Or provide options to create a new client
   * Must include at least the API key
   */
  options?: UnpriceOptions
}>

export interface UnpriceContextType {
  client: Unprice
  isLoading: boolean
  error?: Error
}
