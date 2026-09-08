// This is the entry point for your Cloudflare Worker. It runs on every
// request to saxroll.com. For the checkout route it talks to Stripe using
// your secret key (stored in Cloudflare, never in this file); for every
// other request it just serves your static site (index.html etc.) as before.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/create-checkout-session" && request.method === "POST") {
      return handleCheckout(request, env);
    }

    // Everything else: serve the static site exactly as it did before.
    return env.ASSETS.fetch(request);
  },
};

// TODO: replace with your real Stripe Price ID if it ever changes
const PRICE_ID = "price_1UDOExDgfZTUGc5KxMifklMJ";

async function handleCheckout(request, env) {
  if (!env.STRIPE_SECRET_KEY) {
    return jsonError("Server isn't configured yet (missing STRIPE_SECRET_KEY in Cloudflare).", 500);
  }

  const origin = new URL(request.url).origin;

  const params = new URLSearchParams();
  params.append("mode", "subscription");
  params.append("line_items[0][price]", PRICE_ID);
  params.append("line_items[0][quantity]", "1");
  params.append("success_url", `${origin}/?checkout=success`);
  params.append("cancel_url", `${origin}/?checkout=cancelled`);
  // Lets a future webhook match this payment back to a specific visitor
  // once login + access control gets added.
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
