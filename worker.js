// SaxRoll Worker — now with real access control.
//
// Routes:
//   GET  /                        -> landing page (or redirect to /app.html if already logged in)
//   GET  /app.html                -> the real app, ONLY if a valid session cookie is present
//   POST /api/create-checkout-session  -> starts a Stripe subscription checkout
//   GET  /api/checkout-complete   -> Stripe sends people back here after paying; logs them in
//   POST /api/login               -> "already subscribed" email check
//   POST /api/logout              -> clears the session cookie
//   (anything else)               -> served as a normal static file
 
const PRICE_ID = "price_1UDOExDgfZTUGc5KxMifklMJ";
const COOKIE_NAME = "saxroll_session";
const SESSION_DAYS = 30;
 
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
 
    if (url.pathname === "/api/create-checkout-session" && request.method === "POST") {
      return handleCheckout(request, env);
    }
    if (url.pathname === "/api/checkout-complete" && request.method === "GET") {
      return handleCheckoutComplete(request, env);
    }
    if (url.pathname === "/api/login" && request.method === "POST") {
      return handleLogin(request, env);
    }
    if (url.pathname === "/api/logout" && request.method === "POST") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": `${COOKIE_NAME}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
        },
      });
    }
 
    const session = await getSession(request, env);
 
    if (url.pathname === "/app.html") {
      if (!session) return Response.redirect(new URL("/", request.url), 302);
      return env.ASSETS.fetch(request);
    }
 
    if (url.pathname === "/" || url.pathname === "/index.html") {
      if (session) return Response.redirect(new URL("/app.html", request.url), 302);
      return new Response(landingPage(), {
        headers: { "Content-Type": "text/html;charset=UTF-8" },
      });
    }
 
    return env.ASSETS.fetch(request);
  },
};
 
// ---------- Checkout ----------
 
async function handleCheckout(request, env) {
  if (!env.STRIPE_SECRET_KEY) return jsonError("Server isn't configured (missing STRIPE_SECRET_KEY).", 500);
 
  const origin = new URL(request.url).origin;
  const params = new URLSearchParams();
  params.append("mode", "subscription");
  params.append("line_items[0][price]", PRICE_ID);
  params.append("line_items[0][quantity]", "1");
  params.append("success_url", `${origin}/api/checkout-complete?session_id={CHECKOUT_SESSION_ID}`);
  params.append("cancel_url", `${origin}/?checkout=cancelled`);
 
  try {
    const resp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    const session = await resp.json();
    if (!resp.ok) return jsonError(session.error?.message || "Stripe rejected the request.", 500);
    return new Response(JSON.stringify({ url: session.url }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return jsonError("Could not reach Stripe: " + err.message, 500);
  }
}
 
// Stripe sends the customer back here right after a successful payment.
async function handleCheckoutComplete(request, env) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("session_id");
  if (!sessionId) return Response.redirect(new URL("/", request.url), 302);
 
  try {
    const resp = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
      headers: { "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}` },
    });
    const session = await resp.json();
 
    if (!resp.ok || session.status !== "complete") {
      return Response.redirect(new URL("/?checkout=incomplete", request.url), 302);
    }
 
    const email = session.customer_details?.email || session.customer_email;
    if (!email) return Response.redirect(new URL("/", request.url), 302);
 
    const token = await makeSessionToken(email, env.SESSION_SECRET);
    const headers = new Headers();
    headers.set("Set-Cookie", `${COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_DAYS*86400}; Secure; HttpOnly; SameSite=Lax`);
    headers.set("Location", "/app.html");
    return new Response(null, { status: 302, headers });
  } catch (err) {
    return Response.redirect(new URL("/?checkout=error", request.url), 302);
  }
}
 
// "Already subscribed?" email check.
async function handleLogin(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonError("Invalid request.", 400); }
 
  const email = (body.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) return jsonError("Enter a valid email address.", 400);
 
  const active = await hasActiveSubscription(email, env);
  if (!active) return jsonError("No active subscription found for that email.", 403);
 
  const token = await makeSessionToken(email, env.SESSION_SECRET);
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": `${COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_DAYS*86400}; Secure; HttpOnly; SameSite=Lax`,
    },
  });
}
 
async function hasActiveSubscription(email, env) {
  const custResp = await fetch(`https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}&limit=10`, {
    headers: { "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  const custData = await custResp.json();
  if (!custResp.ok || !custData.data?.length) return false;
 
  for (const customer of custData.data) {
    const subResp = await fetch(`https://api.stripe.com/v1/subscriptions?customer=${customer.id}&status=active&limit=10`, {
      headers: { "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}` },
    });
    const subData = await subResp.json();
    if (!subResp.ok || !subData.data?.length) continue;
    // Confirm it's actually the SaxRoll weekly price, not just any active subscription
    // on the account — matters the moment you add a second product/price.
    for (const sub of subData.data) {
      const items = sub.items?.data || [];
      if (items.some(item => item.price?.id === PRICE_ID)) return true;
    }
  }
  return false;
}
 
// ---------- Sessions (signed cookie, no database needed) ----------
 
async function getSession(request, env) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const match = cookieHeader.match(new RegExp(`(?:^|; )${COOKIE_NAME}=([^;]*)`));
  if (!match) return null;
  return verifySessionToken(decodeURIComponent(match[1]), env.SESSION_SECRET);
}
 
async function makeSessionToken(email, secret) {
  const expiry = Date.now() + SESSION_DAYS*86400*1000;
  const payload = `${email}|${expiry}`;
  const sig = await hmacSign(payload, secret);
  return btoa(payload) + "." + sig;
}
 
async function verifySessionToken(token, secret) {
  if (!token || !secret) return null;
  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) return null;
  let payload;
  try { payload = atob(payloadB64); } catch { return null; }
  const expectedSig = await hmacSign(payload, secret);
  if (sig !== expectedSig) return null;
  const [email, expiryStr] = payload.split("|");
  if (Date.now() > parseInt(expiryStr, 10)) return null;
  return { email };
}
 
async function hmacSign(message, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}
 
function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
 
// ---------- Landing page (shown to anyone without an active subscription) ----------
 
function landingPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sax Highway</title>
<style>
  body{margin:0;background:#10161C;color:#EFE9DD;font-family:'JetBrains Mono',monospace;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;}
  .box{max-width:420px;width:100%;}
  h1{font-family:Georgia,serif;font-size:32px;margin:0 0 10px;}
  h1 em{color:#D9A24B;font-style:italic;}
  p{color:#9BA8B2;font-size:14px;line-height:1.6;}
  button{width:100%;background:#D9A24B;color:#20150A;border:none;padding:12px;border-radius:8px;font-weight:700;font-size:14px;cursor:pointer;font-family:inherit;margin-top:8px;}
  button.secondary{background:transparent;border:1px solid #2B3641;color:#EFE9DD;}
  input{width:100%;background:#0E141A;border:1px solid #2B3641;border-radius:8px;color:#EFE9DD;padding:11px;font-family:inherit;font-size:14px;box-sizing:border-box;margin-top:14px;}
  .msg{font-size:12.5px;margin-top:10px;min-height:16px;}
  .divider{text-align:center;color:#9BA8B2;font-size:12px;margin:26px 0 16px;}
</style>
</head>
<body>
<div class="box">
  <h1>Sax <em>Highway</em></h1>
  <p>Upload a MusicXML file and follow the fingering roll, timed to the music. Subscribe to get access.</p>
  <button id="subscribeBtn">Subscribe — $1.99/week</button>
  <div class="divider">— already subscribed? —</div>
  <input id="emailInput" type="email" placeholder="you@example.com">
  <button class="secondary" id="loginBtn">Access my account</button>
  <div class="msg" id="msg"></div>
</div>
<script>
  const msg = document.getElementById('msg');
  const params = new URLSearchParams(window.location.search);
  if (params.get('checkout') === 'cancelled') { msg.textContent = 'Checkout cancelled — no charge was made.'; }
  if (params.get('checkout') === 'incomplete' || params.get('checkout') === 'error') { msg.textContent = 'Something went wrong finishing checkout — try again.'; msg.style.color = '#E8637A'; }
 
  document.getElementById('subscribeBtn').addEventListener('click', async () => {
    msg.textContent = '';
    try {
      const res = await fetch('/api/create-checkout-session', { method: 'POST' });
      const data = await res.json();
      if (data.url) window.location.href = data.url;
      else { msg.textContent = data.error || 'Something went wrong.'; msg.style.color = '#E8637A'; }
    } catch { msg.textContent = "Couldn't reach the server."; msg.style.color = '#E8637A'; }
  });
 
  document.getElementById('loginBtn').addEventListener('click', async () => {
    const email = document.getElementById('emailInput').value.trim();
    msg.style.color = '#9BA8B2';
    msg.textContent = 'Checking…';
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (res.ok) window.location.href = '/app.html';
      else { msg.textContent = data.error || 'No active subscription found.'; msg.style.color = '#E8637A'; }
    } catch { msg.textContent = "Couldn't reach the server."; msg.style.color = '#E8637A'; }
  });
</script>
</body>
</html>`;
}
 
