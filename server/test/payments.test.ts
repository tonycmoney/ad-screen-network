import Stripe from 'stripe'
import { describe, expect, it } from 'vitest'
import { StripeGateway } from '../src/payments.js'

const SECRET = 'whsec_test_secret'
const stripe = new Stripe('sk_test_x')

function signed(event: object) {
  const payload = JSON.stringify(event)
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET })
  return { raw: Buffer.from(payload), header }
}

function sessionEvent(type: string, session: object) {
  return { id: 'evt_1', object: 'event', type, data: { object: { id: 'cs_1', object: 'checkout.session', ...session } } }
}

describe('StripeGateway webhooks', () => {
  const gw = new StripeGateway('sk_test_x', SECRET)

  it('verifies the signature and reads a paid session', () => {
    const { raw, header } = signed(
      sessionEvent('checkout.session.completed', {
        payment_status: 'paid',
        payment_intent: 'pi_9',
        amount_total: 8400,
        metadata: { campaign_id: '42' },
      }),
    )
    expect(gw.parseWebhook(raw, header)).toEqual({
      id: 'evt_1',
      kind: 'paid',
      sessionId: 'cs_1',
      campaignId: 42,
      paymentIntent: 'pi_9',
      amountCents: 8400,
    })
  })

  it('rejects a forged or altered payload', () => {
    const { raw, header } = signed(sessionEvent('checkout.session.completed', { metadata: { campaign_id: '1' } }))
    expect(() => gw.parseWebhook(Buffer.from(raw.toString().replace('"1"', '"2"')), header)).toThrow()
    expect(() => gw.parseWebhook(raw, undefined)).toThrow(/missing/)
    const other = new StripeGateway('sk_test_x', 'whsec_other')
    expect(() => other.parseWebhook(raw, header)).toThrow()
  })

  it('maps expiry and ignores unpaid or unrelated events', () => {
    const exp = signed(sessionEvent('checkout.session.expired', { metadata: { campaign_id: '7' } }))
    expect(gw.parseWebhook(exp.raw, exp.header)).toMatchObject({ kind: 'expired', campaignId: 7 })
    const unpaid = signed(
      sessionEvent('checkout.session.completed', { payment_status: 'unpaid', metadata: { campaign_id: '7' } }),
    )
    expect(gw.parseWebhook(unpaid.raw, unpaid.header).kind).toBe('ignored')
    const other = signed({ id: 'evt_2', object: 'event', type: 'invoice.paid', data: { object: {} } })
    expect(gw.parseWebhook(other.raw, other.header)).toEqual({ id: 'evt_2', kind: 'ignored', type: 'invoice.paid' })
  })
})

describe('StripeGateway API calls', () => {
  function recordingGateway() {
    const calls: { url: string; body: string; headers: Record<string, string> }[] = []
    const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
      const headers = Object.fromEntries(new Headers(init?.headers).entries())
      calls.push({ url: String(url), body: String(init?.body ?? ''), headers })
      const body = String(url).includes('/refunds')
        ? { id: 're_1', object: 'refund' }
        : { id: 'cs_test_1', object: 'checkout.session', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const gw = new StripeGateway('sk_test_x', SECRET, {
      httpClient: Stripe.createFetchHttpClient(fetchFn as typeof fetch),
      maxNetworkRetries: 0,
    })
    return { gw, calls }
  }

  it('creates a one time checkout tied to the campaign', async () => {
    const { gw, calls } = recordingGateway()
    const out = await gw.createCheckout({
      campaignId: 5,
      description: '2 screens, 7 days',
      amountCents: 14700,
      currency: 'usd',
      email: 'owner@example.com',
      successUrl: 'https://app/campaign/t?paid=1',
      cancelUrl: 'https://app/?canceled=1',
    })
    expect(out).toEqual({ sessionId: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' })
    const call = calls[0]!
    expect(call.url).toContain('/v1/checkout/sessions')
    const form = new URLSearchParams(call.body)
    expect(form.get('mode')).toBe('payment')
    expect(form.get('line_items[0][price_data][unit_amount]')).toBe('14700')
    expect(form.get('metadata[campaign_id]')).toBe('5')
    expect(call.headers['idempotency-key']).toBe('campaign-5-checkout')
  })

  it('refunds by payment intent with an idempotency key', async () => {
    const { gw, calls } = recordingGateway()
    expect(await gw.refund('pi_9')).toBe('re_1')
    expect(new URLSearchParams(calls[0]!.body).get('payment_intent')).toBe('pi_9')
    expect(calls[0]!.headers['idempotency-key']).toBe('refund-pi_9')
  })
})
