import {
  BigNumberInput,
  IPaymentModuleService,
  Logger,
} from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  Modules,
  PaymentSessionStatus,
  isPresent,
  promiseAll,
} from "@medusajs/framework/utils"
import { StepResponse, createStep } from "@medusajs/framework/workflows-sdk"

/**
 * One payment session to re-point at a new amount.
 */
export type UpdatePaymentSessionsStepSession = {
  /** The payment session's id. */
  id: string
  /** The amount the session should now be for. */
  amount: BigNumberInput
  /**
   * The amount the session was for before this step, in the module's own
   * units, so compensation can restore it. Never read this back off the
   * provider `data` — Stripe stores minor units there.
   */
  previous_amount: BigNumberInput
  /** The currency the enclosing collection is now in. */
  currency_code: string
  /** The session's own currency, to detect a currency change. */
  session_currency_code: string
  /**
   * The session's current status, passed back on the update so that changing
   * the amount cannot change the status. `updatePaymentSession` otherwise
   * falls back to the status the provider reports, which would overwrite the
   * row from the remote payment's state on every cart change — flipping a
   * session to `error` after a declined card, or to `requires_more`
   * mid-authentication, and hiding it from storefronts whose selectors are
   * pending-only.
   */
  status: PaymentSessionStatus
  /** The session's current provider data. The provider reads its remote id from this. */
  data: Record<string, unknown> | null
}

export type UpdatePaymentSessionsStepInput = {
  sessions: UpdatePaymentSessionsStepSession[]
}

/**
 * The sessions this step could not re-point, shaped as the input of
 * `deletePaymentSessionsWorkflow` so they can be handed straight to it.
 */
export type UpdatePaymentSessionsStepOutput = {
  /** The ids of the payment sessions that could not be updated in place. */
  ids: string[]
}

export const updatePaymentSessionsStepId = "update-payment-sessions"

/**
 * What compensation needs in order to put a session back, and nothing more.
 *
 * Note what it does NOT carry: the session's pre-step `data`. The Stripe
 * provider no-ops an update whose incoming data already encodes the target
 * amount, so passing the pre-step snapshot back on compensation would match
 * the amount being restored to and silently skip the real provider call —
 * reverting the local row while leaving the remote payment at the new amount.
 * `data` here is the data the *forward* call returned.
 */
type RevertablePaymentSession = {
  id: string
  previous_amount: BigNumberInput
  session_currency_code: string
  status: PaymentSessionStatus
  data: Record<string, unknown>
}

/**
 * A session can be re-pointed at a new amount only when all three hold:
 *
 * - it carries provider data, so the provider has a remote payment to address.
 *   `isPresent` rather than a truthiness check: an empty object addresses
 *   nothing. This stays provider-agnostic — it does not know about Stripe's
 *   `data.id` or any other provider-specific key;
 * - its currency has not changed, since providers are only asked to change the
 *   amount;
 * - it is still `pending`. An `authorized`, `captured` or `error` session must
 *   not have its amount moved underneath it: the row's `amount` is what
 *   `authorizePaymentSession` records on the `Payment` and what a capture is
 *   taken for, so re-pointing one would record a payment for an amount that
 *   was never authorized — and re-asserting a stale `error` status would hide
 *   the session from pending-only storefront selectors instead of letting it
 *   be replaced.
 *
 * A session that fails any of these is deleted instead, which is what happened
 * to every session before this step existed.
 */
const canUpdateInPlace = (
  session: UpdatePaymentSessionsStepSession
): boolean => {
  return (
    isPresent(session.data) &&
    session.session_currency_code === session.currency_code &&
    session.status === PaymentSessionStatus.PENDING
  )
}

/**
 * This step re-points existing payment sessions at a new amount, rather than
 * deleting them. Providers that can update a remote payment in place — Stripe
 * updates the PaymentIntent's amount — keep their remote object, so the buyer's
 * mounted payment form stays valid and no abandoned remote payment is left
 * behind. The amount is the only thing that changes: the session's current
 * status is passed back on the update, so an amount change cannot move the
 * status.
 *
 * This step does not delete the sessions it cannot re-point (see
 * `canUpdateInPlace`, and the provider refusals handled below); it returns
 * their ids, so the caller can pass them to `deletePaymentSessionsWorkflow`,
 * which validates that every intended delete actually happened and fails the
 * enclosing workflow when one did not. Deleting is what happened to every
 * session before this step existed, so that fallback is never worse than the
 * previous behaviour.
 *
 * This step's own compensation restores only the sessions it updated. A
 * session handed on to be deleted is not this step's to restore.
 *
 * @example
 * const sessionsToDelete = updatePaymentSessionsStep({
 *   sessions: [
 *     {
 *       id: "payses_123",
 *       amount: 20,
 *       previous_amount: 10,
 *       currency_code: "usd",
 *       session_currency_code: "usd",
 *       status: "pending",
 *       data: { id: "pi_123" },
 *     },
 *   ],
 * })
 */
export const updatePaymentSessionsStep = createStep(
  updatePaymentSessionsStepId,
  async (input: UpdatePaymentSessionsStepInput, { container }) => {
    const paymentModule = container.resolve<IPaymentModuleService>(
      Modules.PAYMENT
    )
    const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER)

    const updatable: UpdatePaymentSessionsStepSession[] = []
    const notUpdatable: UpdatePaymentSessionsStepSession[] = []

    // One pass, so the two lists cannot disagree about the predicate. Deriving
    // the complement with `!updatable.includes(s)` would make it depend on the
    // first pass having preserved object identity.
    for (const session of input.sessions) {
      ;(canUpdateInPlace(session) ? updatable : notUpdatable).push(session)
    }

    const updated: RevertablePaymentSession[] = []
    const failed: UpdatePaymentSessionsStepSession[] = []

    await promiseAll(
      updatable.map(async (session) => {
        try {
          const result = await paymentModule.updatePaymentSession({
            id: session.id,
            amount: session.amount,
            currency_code: session.currency_code,
            data: session.data!,
            // Carried through so that re-pointing the amount cannot move the
            // session's status — see the field's own documentation above.
            status: session.status,
            // No idempotency key, deliberately. Setting an amount is already
            // idempotent in effect — sending the same amount twice leaves the
            // remote payment at that amount — so a key buys nothing, and it
            // actively breaks the common case: Stripe replays a key's cached
            // response for 24h, so a cart whose total returns to a value it
            // held earlier (add an item, remove it again) would skip the real
            // `paymentIntents.update` and leave the remote payment on the
            // amount in between, while this row moved.
          })

          // `updatePaymentSession` *replaces* the row's `data` with whatever
          // the provider returned, where `createPaymentSession` merges it. So
          // a provider whose `updatePayment` returns `{ data: {} }` — the
          // stock system provider does — has just had the reference to its
          // remote payment erased: the next refresh would find no provider
          // data, delete the session, and call `deletePayment` with nothing to
          // address, leaving the remote payment uncancelled. Hand it on to be
          // deleted now instead, so the fallback is the previous behaviour
          // rather than a session that has lost its remote payment.
          if (!isPresent(result.data)) {
            logger.warn(
              `Payment session ${session.id} was re-pointed but its provider returned no data, so the reference to its remote payment is gone - deleting the session instead`
            )
            failed.push(session)
            return
          }

          updated.push({
            id: session.id,
            previous_amount: session.previous_amount,
            session_currency_code: session.session_currency_code,
            status: session.status,
            data: result.data,
          })
        } catch (e) {
          // A database blip or a bug inside the Payment module must not read
          // as "the provider refused the update" without a trace — log it,
          // the same way deletePaymentSessionsStep does for its own calls.
          logger.error(
            `Encountered an error when trying to update payment session ${session.id} in place - ${e}`
          )
          failed.push(session)
        }
      })
    )

    const ids = [...notUpdatable, ...failed].map((s) => s.id)

    const output: UpdatePaymentSessionsStepOutput = { ids }

    return new StepResponse(output, { updated })
  },
  async (revertData, { container }) => {
    if (!revertData?.updated?.length) {
      return
    }

    const paymentModule = container.resolve<IPaymentModuleService>(
      Modules.PAYMENT
    )
    const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER)

    // Restore by id, with each session's captured amount and status and the
    // *forward* call's returned data (see RevertablePaymentSession). Sessions
    // this step handed on to be deleted are not restored here: that delete
    // carries its own compensation, and re-creating a session from here would
    // mint a second remote payment.
    //
    // Per session, and logged, for the same reason deletePaymentSessionsStep
    // does it for its own external calls: a revert reaches the provider, so
    // one refusal — a buyer who has since confirmed, a rate limit — must not
    // throw out of the compensation and leave every other session's outcome
    // unrecorded. A failed revert leaves that row on the new amount while the
    // collection goes back to the old one, and that is exactly the state that
    // has to be diagnosable afterwards.
    await promiseAll(
      revertData.updated.map(async (session) => {
        try {
          await paymentModule.updatePaymentSession({
            id: session.id,
            amount: session.previous_amount,
            currency_code: session.session_currency_code,
            data: session.data,
            status: session.status,
          })
        } catch (e) {
          logger.error(
            `Encountered an error when trying to restore payment session ${session.id} to its previous amount - it may still be on the new one - ${e}`
          )
        }
      })
    )
  }
)
