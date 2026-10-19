import Stripe from 'stripe'

export interface CheckoutRequest {
  campaignId: number
  description: string
  amountCents: number
  currency: string
  email: string
  successUrl: string
  cancelUrl: string
}

export type PaymentEvent =
  | { id: string; kind: 'paid'; sessionId: string; campaignId: number; paymentIntent: string | null; amountCents: number }
  | { id: string; kind: 'expired'; sessionId: string; campaignId: number }
  | { id: string; kind: 'ignored'; type: string }

export interface PaymentGateway {
  createCheckout(req: CheckoutRequest): Promise<{ sessionId: string; url: string }>
  /** Verify the webhook signature and normalize the event. Throws if invalid. */
  parseWebhook(rawBody: Buffer, signature: string | undefined): PaymentEvent
  refund(paymentIntent: string): Promise<string>
}

export class StripeGateway implements PaymentGateway {
  private stripe: Stripe

  constructor(
    secretKey: string,
    private webhookSecret: string,
    options: Stripe.StripeConfig = {},
  ) {
    this.stripe = new Stripe(secretKey, { maxNetworkRetries: 2, timeout: 20_000, ...options })
  }

  async createCheckout(req: CheckoutRequest) {
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        customer_email: req.email,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: req.currency,
              unit_amount: req.amountCents,
              product_data: { name: req.description },
            },
          },
        ],
        metadata: { campaign_id: String(req.campaignId) },
        payment_intent_data: { metadata: { campaign_id: String(req.campaignId) } },
        success_url: req.successUrl,
        cancel_url: req.cancelUrl,
        expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
      },
      // Retrying a create for the same campaign never makes a second session.
      { idempotencyKey: `campaign-${req.campaignId}-checkout` },
    )
    if (!session.url) throw new Error('Stripe did not return a checkout URL')
    return { sessionId: session.id, url: session.url }
  }

  parseWebhook(rawBody: Buffer, signature: string | undefined): PaymentEvent {
    if (!signature) throw new Error('missing Stripe-Signature header')
    const event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret)
    return normalizeEvent(event)
  }

  async refund(paymentIntent: string) {
    const refund = await this.stripe.refunds.create(
      { payment_intent: paymentIntent },
      { idempotencyKey: `refund-${paymentIntent}` },
    )
    return refund.id
  }
}

export function normalizeEvent(event: Stripe.Event): PaymentEvent {
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.expired') {
    const s = event.data.object as Stripe.Checkout.Session
    const campaignId = Number(s.metadata?.campaign_id)
    if (!Number.isInteger(campaignId)) return { id: event.id, kind: 'ignored', type: event.type }
    if (event.type === 'checkout.session.expired') {
      return { id: event.id, kind: 'expired', sessionId: s.id, campaignId }
    }
    if (s.payment_status !== 'paid') return { id: event.id, kind: 'ignored', type: event.type }
    const pi = typeof s.payment_intent === 'string' ? s.payment_intent : (s.payment_intent?.id ?? null)
    return {
      id: event.id,
      kind: 'paid',
      sessionId: s.id,
      campaignId,
      paymentIntent: pi,
      amountCents: s.amount_total ?? 0,
    }
  }
  return { id: event.id, kind: 'ignored', type: event.type }
}
