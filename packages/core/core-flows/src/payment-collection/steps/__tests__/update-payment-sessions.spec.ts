import { MedusaContainer } from "@medusajs/framework"
import {
  asFunction,
  asValue,
  createContainer,
} from "@medusajs/framework/awilix"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  WorkflowResponse,
  createStep,
  createWorkflow,
} from "@medusajs/workflows-sdk"

import { updatePaymentSessionsStep } from "../update-payment-sessions"

/**
 * The fake provider echoes the amount it was called with back into
 * `data.amount`, under that exact key, because `data.amount` is the field
 * Stripe's provider both stores and compares against to decide whether an
 * update is a no-op (`data?.amount === amountNumeric`). Modelling the real key
 * is what makes the compensation test below mean something: it proves the
 * revert passes back the *forward call's* returned data rather than the
 * session's pre-step data, which would encode the amount being restored to and
 * so make the provider skip the real revert.
 */
const paymentServiceFixture = () => ({
  updatePaymentSession: jest.fn(async (data: any) => ({
    id: data.id,
    data: { ...data.data, amount: data.amount },
  })),
  deletePaymentSession: jest.fn(async () => {}),
})

const loggerFixture = () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
})

const failingStep = createStep("update-sessions-test-failure", async () => {
  throw new Error("downstream failure")
})

const session = (over: Record<string, unknown> = {}) => ({
  id: "payses_1",
  amount: 28.32, // what the cart now totals
  previous_amount: 25.03, // what the session was for before this step
  currency_code: "usd",
  session_currency_code: "usd",
  status: "pending",
  data: { id: "pi_123" },
  ...over,
})

describe("updatePaymentSessionsStep", () => {
  let container!: MedusaContainer
  let payment!: ReturnType<typeof paymentServiceFixture>
  let logger!: ReturnType<typeof loggerFixture>

  const run = async (sessions: any[], withFailure = false) => {
    // Two distinct workflow ids: the workflow registry keys a workflow by its
    // name and rejects re-registering the same name with a different step
    // graph, and the two branches below (with/without failingStep) are
    // different graphs.
    const workflow = createWorkflow(
      withFailure
        ? "update-payment-sessions-test-with-failure"
        : "update-payment-sessions-test",
      (input: any) => {
        const result = updatePaymentSessionsStep({ sessions: input.sessions })
        if (withFailure) {
          failingStep()
        }
        return new WorkflowResponse(result)
      }
    )
    return workflow(container).run({
      input: { sessions },
      throwOnError: false,
    })
  }

  beforeEach(() => {
    payment = paymentServiceFixture()
    logger = loggerFixture()
    container = createContainer() as unknown as MedusaContainer
    container.register(
      Modules.PAYMENT,
      asFunction(() => payment as any)
    )
    container.register(ContainerRegistrationKeys.LOGGER, asValue(logger as any))
  })

  it("updates a session in place and returns nothing to delete", async () => {
    const { result } = await run([session()])

    expect(payment.updatePaymentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "payses_1",
        amount: 28.32,
        currency_code: "usd",
        data: { id: "pi_123" },
        // The session's own status is passed back, so changing the amount
        // cannot change the status. Omitting it lets the Payment module fall
        // back to the status the provider reports, which would flip the
        // session to `error` or `requires_more` on an unrelated cart change.
        status: "pending",
      })
    )
    // No idempotency key, deliberately. Setting an amount is already
    // idempotent in effect, and Stripe replays a key's cached response for
    // 24h — so a cart whose total returns to a value it held earlier (add an
    // item, remove it again) would skip the real update and leave the remote
    // payment on the amount in between while this row moved.
    expect(payment.updatePaymentSession.mock.calls[0][0]).not.toHaveProperty(
      "context"
    )
    expect(result).toEqual({ ids: [] })
    // Deleting is the caller's job, through deletePaymentSessionsWorkflow.
    expect(payment.deletePaymentSession).not.toHaveBeenCalled()
  })

  it("returns the id for deletion when the currency changed", async () => {
    const { result } = await run([session({ session_currency_code: "eur" })])

    expect(payment.updatePaymentSession).not.toHaveBeenCalled()
    expect(result).toEqual({ ids: ["payses_1"] })
    expect(payment.deletePaymentSession).not.toHaveBeenCalled()
  })

  it("returns the id for deletion when the session carries no provider data", async () => {
    const { result } = await run([session({ data: null })])

    expect(payment.updatePaymentSession).not.toHaveBeenCalled()
    expect(result).toEqual({ ids: ["payses_1"] })
  })

  it("returns the id for deletion when the session's provider data is an empty object", async () => {
    // An empty object must not pass as "has provider data". The generic step
    // must not know about any provider-specific key (e.g. Stripe's `data.id`);
    // it only checks that the object is non-empty.
    const { result } = await run([session({ data: {} })])

    expect(payment.updatePaymentSession).not.toHaveBeenCalled()
    expect(result).toEqual({ ids: ["payses_1"] })
  })

  it.each([
    ["authorized"],
    ["captured"],
    ["error"],
    ["canceled"],
    ["requires_more"],
    ["pending_authorization"],
  ])("returns the id for deletion when the session is %s", async (status) => {
    // Only a `pending` session may be re-pointed. The row's `amount` is what
    // `authorizePaymentSession` records on the Payment and what a capture is
    // taken for, so moving it under an already-authorized session would book a
    // payment for an amount that was never authorized; and re-asserting a
    // stale `error` status would hide the session from pending-only storefront
    // selectors instead of letting it be replaced.
    const { result } = await run([session({ status })])

    expect(payment.updatePaymentSession).not.toHaveBeenCalled()
    expect(result).toEqual({ ids: ["payses_1"] })
  })

  it("returns the id for deletion when the provider returns no data", async () => {
    // `updatePaymentSession` REPLACES the row's data with the provider's
    // return (`createPaymentSession` merges it), so a provider that answers
    // `{ data: {} }` — the stock system provider does — has just erased the
    // reference to its remote payment. Deleting now keeps the fallback equal
    // to the previous behaviour instead of leaving a session that can no
    // longer address, or cancel, its remote payment.
    payment.updatePaymentSession.mockResolvedValueOnce({
      id: "payses_1",
      data: {},
    } as any)

    const { result, errors } = await run([session()])

    expect(result).toEqual({ ids: ["payses_1"] })
    expect(errors).toHaveLength(0)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("payses_1")
    )
  })

  it("does not restore a session whose provider returned no data", async () => {
    payment.updatePaymentSession.mockResolvedValueOnce({
      id: "payses_1",
      data: {},
    } as any)

    await run([session()], true)

    // One call only: the forward update. The session was handed on to be
    // deleted, and the delete carries its own compensation.
    expect(payment.updatePaymentSession).toHaveBeenCalledTimes(1)
  })

  it("returns the id for deletion when the provider rejects the update", async () => {
    payment.updatePaymentSession.mockRejectedValueOnce(
      new Error("stripe said no")
    )

    const { result, errors } = await run([session()])

    expect(result).toEqual({ ids: ["payses_1"] })
    // A rejected update must not fail the step: the session is handed on to be
    // deleted, which is what happened to every session before this step.
    expect(errors).toHaveLength(0)
    // And it must be logged, not swallowed silently.
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("payses_1")
    )
  })

  it("handles a mixed batch: the updatable session is updated, the other is returned", async () => {
    const updatable = session({ id: "payses_1" })
    const notUpdatable = session({
      id: "payses_2",
      session_currency_code: "eur",
    })

    const { result } = await run([updatable, notUpdatable])

    expect(payment.updatePaymentSession).toHaveBeenCalledTimes(1)
    expect(payment.updatePaymentSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: "payses_1" })
    )
    expect(result).toEqual({ ids: ["payses_2"] })
  })

  it("restores the captured amount when the workflow compensates", async () => {
    await run([session()], true)

    // Second call is the compensation, restoring the pre-step amount by id.
    expect(payment.updatePaymentSession).toHaveBeenCalledTimes(2)
    // Restores the session's own pre-step amount in major units. Reading it
    // back off `data.amount` would restore Stripe's minor units — 2503, not
    // 25.03 — and silently multiply the charge by 100.
    expect(payment.updatePaymentSession).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: "payses_1",
        amount: 25.03,
        currency_code: "usd",
        status: "pending",
        // The forward call's *returned* data (amount: 28.32), not the pre-step
        // session.data ({ id: "pi_123" }). Passing the pre-step data back
        // would carry an embedded amount matching the amount being restored
        // to, so the provider's no-op-if-unchanged check (`data?.amount ===
        // amountNumeric`) would skip the real revert call.
        data: { id: "pi_123", amount: 28.32 },
      })
    )
    // The revert carries no idempotency key either — restoring an amount the
    // session has already held is exactly the replay case a key would break.
    expect(payment.updatePaymentSession.mock.calls[1][0]).not.toHaveProperty(
      "context"
    )
  })

  it("excludes a session whose update failed from compensation", async () => {
    const ok = session({ id: "payses_ok" })
    const bad = session({ id: "payses_bad" })

    payment.updatePaymentSession.mockImplementation(async (data: any) => {
      if (data.id === "payses_bad") {
        throw new Error("stripe said no")
      }
      return { id: data.id, data: { ...data.data, amount: data.amount } }
    })

    await run([ok, bad], true)

    // Compensation must only restore sessions this step actually updated.
    // payses_bad's update failed, so it was handed on to be deleted — and the
    // delete has its own compensation. Restoring it from here would reinstate
    // an amount on a session that is on its way out. Only the restore call
    // (amount reverted to previous_amount, 25.03) for payses_ok is expected.
    const compensationCalls = payment.updatePaymentSession.mock.calls.filter(
      ([call]) => call.amount === 25.03
    )
    expect(compensationCalls).toHaveLength(1)
    expect(compensationCalls[0][0]).toEqual(
      expect.objectContaining({ id: "payses_ok" })
    )
    expect(payment.updatePaymentSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: "payses_bad", amount: 25.03 })
    )
  })

  it("restores the other sessions when one revert is refused, and logs it", async () => {
    const first = session({ id: "payses_1" })
    const second = session({ id: "payses_2" })

    payment.updatePaymentSession.mockImplementation(async (data: any) => {
      // Refuse only the revert of payses_1 — the buyer confirmed that intent
      // while the workflow was running, so Stripe will not move its amount.
      if (data.id === "payses_1" && data.amount === 25.03) {
        throw new Error("cannot update amount on a confirmed intent")
      }
      return { id: data.id, data: { ...data.data, amount: data.amount } }
    })

    await run([first, second], true)

    // A refused revert must not throw out of the compensation: the other
    // session is still restored, the same guarantee deletePaymentSessionsStep
    // gives for its own external calls.
    const reverts = payment.updatePaymentSession.mock.calls.filter(
      ([call]) => call.amount === 25.03
    )
    expect(reverts.map(([call]) => call.id).sort()).toEqual([
      "payses_1",
      "payses_2",
    ])
    // And the one that failed has to be findable afterwards — that row is now
    // on the new amount while the collection went back to the old one.
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("payses_1")
    )
  })
})
