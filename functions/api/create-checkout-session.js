// Cloudflare Pages Function — deploys automatically at:
//   https://saxroll.com/api/create-checkout-session
//
// This runs on Cloudflare's servers, never in the browser, so your Stripe
// SECRET key (stored as an encrypted environment variable in Cloudflare,
// never in this file or in GitHub) is never exposed to visitors.
 
// TODO: replace with your real Stripe Price ID from the Stripe Dashboard
// (Products -> your product -> click the price -> starts with "price_")
const PRICE_ID = "price_1UDOExDgfZTUGc5KxMifklMJ";
 
export async function onRequestPost(context) {
  const { env, request } = context;
 
  if (!env.STRIPE_SECRET_KEY) {
    return jsonError("Server isn't configured yet (missing STRIPE_SECRET_KEY in Cloudflare).", 500);
  }
  if (PRICE_ID === "price_REPLACE_ME") {
    return jsonError("Server isn't configured yet (missing Stripe Price ID in create-checkout-session.js).", 500);
  }
 
  const origin = new URL(request.url).origin;
 
  const params = new URLSearchParams();
  params.append("mode", "subscription");
  params.append("line_items[0][price]", PRICE_ID);
  params.append("line_items[0][quantity]", "1");
  params.append("success_url", `${origin}/?checkout=success`);
  params.append("cancel_url", `${origin}/?checkout=cancelled`);
  // Lets the webhook (added in the next step) match this payment back to a
  // specific visitor/email once you add login + access control.
  params.append("client_reference_id", crypto.randomUUID());
 
  try {
    const stripeResp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
 
    const session = await stripeResp.json();
 
    if (!stripeResp.ok) {
      return jsonError(session.error?.message || "Stripe rejected the request.", 500);
    }
 
    return new Response(JSON.stringify({ url: session.url }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return jsonError("Could not reach Stripe: " + err.message, 500);
  }
}
 
function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
