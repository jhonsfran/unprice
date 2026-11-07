import { Err, Ok, type Result } from "@unprice/error"
import { UnPriceBudgetError } from "../../budgets"
import type { CardRows } from "../../pricing"
import type { RateCardService } from "../../rate-cards"
import type { CardSource } from "./budget-client"

/** Budgets read their cards from the project's rate cards, every row included. */
export function rateCardSource(rateCards: Pick<RateCardService, "getCard">): CardSource {
  return {
    async read(projectId, cardIds): Promise<Result<CardRows[], UnPriceBudgetError>> {
      const cards: CardRows[] = []
      for (const cardId of new Set(cardIds)) {
        const read = await rateCards.getCard(projectId, cardId)
        if (read.err?.code === "CARD_NOT_FOUND") {
          return Err(new UnPriceBudgetError({ code: "CARD_NOT_FOUND", cardId }))
        }
        // Anything else is the source failing, not a missing card: the caller may retry.
        if (read.err) throw read.err
        cards.push(read.val)
      }
      return Ok(cards)
    },
  }
}
