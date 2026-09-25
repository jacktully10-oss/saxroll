// SaxRoll Worker — now with real access control.
//
// Routes:
//   GET  /                        -> landing page (or redirect to /app.html if already logged in)
//   GET  /app.html                -> the real app, ONLY if a valid session cookie is present
//   POST /api/omr-upload          -> sends a PDF to the self-hosted OMR service, returns a jobId. Requires a session.
//   GET  /api/omr-status          -> polls an OMR job's status. Requires a session.
//   GET  /api/omr-result          -> fetches a finished job's MusicXML, then deletes the job server-side. Requires a session.
//   GET  /api/demo-upload-check   -> read-only: how many free demo uploads this IP has left. No session (demo is unauthenticated).
//   POST /api/demo-upload-record  -> counts one demo upload against this IP. Called only after a real, successful parse.
//   POST /api/create-checkout-session  -> starts a Stripe subscription checkout
//   POST /api/checkout-xml-cache  -> one-time purchase: personal XML cache + 3 sourced songs
//   POST /api/checkout-xml-request -> one-time purchase: 3 sourced songs
//   GET  /api/checkout-complete   -> Stripe sends people back here after paying; logs them in
//   POST /api/customer-portal     -> starts a Stripe Customer Portal session (manage/cancel), requires a session
//   POST /api/login               -> "already subscribed" email check
//   POST /api/logout              -> clears the session cookie
//   (anything else)               -> served as a normal static file

const PRICE_ID = "price_1UDOExDgfZTUGc5KxMifklMJ";
const XML_CACHE_PRICE_ID = "price_1UE4EvDgfZTUGc5KzkjIjavw";   // $5 AUD one-time: personal XML cache + 3 sourced songs
const XML_REQUEST_PRICE_ID = "price_1UE4FRDgfZTUGc5KIDPzwDPl"; // $3 AUD one-time: 3 sourced songs
const COOKIE_NAME = "saxroll_session";
const SESSION_DAYS = 7; // matches the weekly billing cycle — see note below

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/omr-upload" && request.method === "POST") {
      const session = await getSession(request, env);
      if (!session) return jsonError("Not logged in.", 401);
      return handleOmrUpload(request, env);
    }
    if (url.pathname === "/api/omr-status" && request.method === "GET") {
      const session = await getSession(request, env);
      if (!session) return jsonError("Not logged in.", 401);
      return handleOmrStatus(request, env);
    }
    if (url.pathname === "/api/omr-result" && request.method === "GET") {
      const session = await getSession(request, env);
      if (!session) return jsonError("Not logged in.", 401);
      return handleOmrResult(request, env, ctx);
    }
    if (url.pathname === "/api/create-checkout-session" && request.method === "POST") {
      return handleCheckout(request, env);
    }
    if (url.pathname === "/api/checkout-xml-cache" && request.method === "POST") {
      return handleOneTimeCheckout(request, env, XML_CACHE_PRICE_ID, "3 songs to source? (email your cache too)", "Sax Roll: your XML cache request + 3 songs sourced. Email saxophoneroll@gmail.com with your cache.");
    }
    if (url.pathname === "/api/checkout-xml-request" && request.method === "POST") {
      return handleOneTimeCheckout(request, env, XML_REQUEST_PRICE_ID, "Which 3 songs would you like sourced?", "Sax Roll: 3 songs sourced for you. Check saxophoneroll@gmail.com if you have questions.");
    }
    if (url.pathname === "/api/checkout-complete" && request.method === "GET") {
      return handleCheckoutComplete(request, env);
    }
    if (url.pathname === "/api/customer-portal" && request.method === "POST") {
      const session = await getSession(request, env);
      if (!session) return jsonError("Not logged in.", 401);
      return handleCustomerPortal(request, env, session.email);
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

    if (url.pathname === "/api/demo-upload-check" && request.method === "GET") {
      return handleDemoUploadCheck(request, env);
    }
    if (url.pathname === "/api/demo-upload-record" && request.method === "POST") {
      return handleDemoUploadRecord(request, env);
    }
    if (url.pathname === "/demo") {
      // Public, no-login demo — same app file, but its own JS detects this path
      // and disables uploads / shows only the built-in public-domain pieces.
      // Important: fetch the asset via the clean "/app" path, not "/app.html" —
      // requesting the literal .html path gets a 307 from Cloudflare's asset layer
      // (redirecting to the clean URL), which would otherwise leak straight through
      // to the browser and change the visible URL away from /demo entirely.
      const assetReq = new Request(new URL("/app", request.url), request);
      return env.ASSETS.fetch(assetReq);
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const session = await getSession(request, env);
      if (session) return Response.redirect(new URL("/app.html", request.url), 302);
      return new Response(landingPage(), {
        headers: {
          "Content-Type": "text/html;charset=UTF-8",
          // Safe to cache briefly: this response never contains per-user content (a
          // logged-in visitor gets redirected above, before this line ever runs).
          // Short duration keeps content updates from being stuck behind a stale cache
          // for long, while still meaningfully cutting repeat-visit Worker invocations.
          "Cache-Control": "public, max-age=300",
        },
      });
    }

    if (url.pathname === "/og-image.png" || url.pathname === "/og-image-wide.png") {
      // Public on purpose, same reasoning as "/" and "/demo" above: browsers request
      // favicons automatically with no session, and social-media link-preview crawlers
      // never have one at all. Without this exception the request falls through to the
      // default-deny block below and gets redirected to "/" instead of the actual image
      // — which can't render as a favicon or a link preview, only a real image response can.
      return env.ASSETS.fetch(request);
    }

    // Default-deny: every other path — /app.html, /app, or anything else Cloudflare's
    // asset serving might resolve to that same file — requires a valid session. Only
    // the routes explicitly handled above are public. This is deliberately the opposite
    // of a blocklist: nothing is reachable unless it's named above.
    const session = await getSession(request, env);
    if (!session) return Response.redirect(new URL("/", request.url), 302);

    const assetResp = await env.ASSETS.fetch(request);
    // Explicitly forbid caching this response anywhere (Cloudflare's edge, the browser,
    // any intermediate proxy). If a previously-authenticated response for this exact path
    // were ever cached, it could get served to a later, unauthenticated visitor — a cache
    // hit skips this Worker entirely, so the session check above would never even run.
    const resp = new Response(assetResp.body, assetResp);
    resp.headers.set("Cache-Control", "private, no-store, no-cache, must-revalidate");
    return resp;
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

// One-time (not subscription) purchases for the manual song-sourcing options — you
// personally source/send the files afterward, so this just takes payment and collects
// what they want via a Stripe Checkout custom field (shows up right in your Stripe
// dashboard alongside the payment, no separate storage needed).
async function handleOneTimeCheckout(request, env, priceId, fieldLabel, receiptDescription) {
  if (!env.STRIPE_SECRET_KEY) return jsonError("Server isn't configured (missing STRIPE_SECRET_KEY).", 500);

  const origin = new URL(request.url).origin;
  const params = new URLSearchParams();
  params.append("mode", "payment");
  params.append("line_items[0][price]", priceId);
  params.append("line_items[0][quantity]", "1");
  params.append("success_url", `${origin}/app.html?purchase=success`);
  params.append("cancel_url", `${origin}/app.html?purchase=cancelled`);
  params.append("custom_fields[0][key]", "song_requests");
  params.append("custom_fields[0][label][type]", "custom");
  params.append("custom_fields[0][label][custom]", fieldLabel);
  params.append("custom_fields[0][type]", "text");
  params.append("custom_fields[0][text][maximum_length]", "255");
  params.append("payment_intent_data[description]", receiptDescription);

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
// ---------- OMR: PDF -> MusicXML via our own self-hosted Audiveris service ----------
// The service itself (solfascribe-omr, MIT wrapper around AGPL-3.0 Audiveris) speaks a
// plain 4-route REST API and ships with NO built-in authentication by design — its own
// docs are explicit that whoever deploys it in front of the public internet must add
// auth. That's done at the Caddy layer in front of the container (see deploy/Caddyfile):
// Caddy checks this same Authorization header before anything reaches the OMR service,
// so a request without the right secret never reaches Audiveris at all.
//
// Flow: upload -> {jobId} (202, async — conversion is genuinely seconds to minutes) ->
// poll status -> once done, fetch the MusicXML for a movement -> hand that text straight
// to the existing parseMusicXML() client-side, completely unchanged, since it already
// expects exactly this.
async function omrFetch(env, path, options) {
  return fetch(`${env.OMR_SERVICE_URL}${path}`, {
    ...options,
    headers: { "Authorization": `Bearer ${env.OMR_SHARED_SECRET}`, ...(options && options.headers) },
  });
}

async function handleOmrUpload(request, env) {
  if (!env.OMR_SERVICE_URL || !env.OMR_SHARED_SECRET) {
    return jsonError("PDF import isn't set up yet.", 503);
  }
  const pdfBytes = await request.arrayBuffer();
  if (pdfBytes.byteLength === 0) return jsonError("That file came through empty — try uploading it again.", 400);
  if (pdfBytes.byteLength > 40 * 1024 * 1024) return jsonError("That PDF is over the 40MB limit.", 413);

  const form = new FormData();
  form.append("file", new Blob([pdfBytes], { type: "application/pdf" }), "upload.pdf");

  let omrResp;
  try {
    omrResp = await omrFetch(env, "/jobs", { method: "POST", body: form });
  } catch (err) {
    return jsonError("Couldn't reach the PDF conversion service — try again in a moment.", 502);
  }
  if (omrResp.status !== 202) {
    const detail = await omrResp.text().catch(() => "");
    return jsonError(`The conversion service couldn't accept that file (${omrResp.status}).${detail ? ' ' + detail.slice(0,200) : ''}`, 502);
  }
  const data = await omrResp.json();
  return new Response(JSON.stringify({ jobId: data.jobId }), { headers: { "Content-Type": "application/json" } });
}

async function handleOmrStatus(request, env) {
  if (!env.OMR_SERVICE_URL || !env.OMR_SHARED_SECRET) {
    return jsonError("PDF import isn't set up yet.", 503);
  }
  const jobId = new URL(request.url).searchParams.get("job");
  if (!jobId) return jsonError("Missing job id.", 400);

  let omrResp;
  try {
    omrResp = await omrFetch(env, `/jobs/${encodeURIComponent(jobId)}`, {});
  } catch (err) {
    return jsonError("Couldn't reach the PDF conversion service — try again in a moment.", 502);
  }
  if (!omrResp.ok) {
    return jsonError(`Couldn't check that job right now (${omrResp.status}).`, 502);
  }
  const data = await omrResp.json();
  return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
}

async function handleOmrResult(request, env, ctx) {
  if (!env.OMR_SERVICE_URL || !env.OMR_SHARED_SECRET) {
    return jsonError("PDF import isn't set up yet.", 503);
  }
  const params = new URL(request.url).searchParams;
  const jobId = params.get("job");
  const fileName = params.get("file");
  if (!jobId || !fileName) return jsonError("Missing job id or file name.", 400);

  let fileResp;
  try {
    fileResp = await omrFetch(env, `/jobs/${encodeURIComponent(jobId)}/files/${encodeURIComponent(fileName)}`, {});
  } catch (err) {
    return jsonError("Couldn't reach the PDF conversion service — try again in a moment.", 502);
  }
  if (!fileResp.ok) {
    return jsonError(`Couldn't fetch that result (${fileResp.status}).`, 502);
  }
  const xmlText = await fileResp.text();

  // Best-effort cleanup: delete the job (and its uploaded PDF) now that we have what we
  // need, rather than waiting for the service's own 20-minute TTL sweeper. waitUntil so
  // this actually gets a chance to finish instead of being cut off with the response.
  if (ctx && ctx.waitUntil) {
    ctx.waitUntil(omrFetch(env, `/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" }).catch(() => {}));
  }

  return new Response(xmlText, { headers: { "Content-Type": "application/vnd.recordare.musicxml+xml" } });
}

// ---------- Demo-mode upload limit, enforced server-side by IP ----------
// The demo page's upload/parse happens entirely client-side (the file never touches this
// Worker), so there's no natural server checkpoint to enforce a limit at all unless one is
// deliberately added here. Before this, the only signal was sessionStorage, which resets
// the moment someone opens an incognito window or clears storage — not an edge case, just
// how private browsing works by default, so it was trivially bypassable by anyone, not
// just someone deliberately trying to cheat it.
//
// IP-based tracking via KV is a real improvement but not a perfect one, worth being honest
// about: people sharing a network (home wifi, office, mobile carrier NAT) share a counter,
// and a VPN still resets it. It raises the bar from "open a private window" to "actively
// route around IP tracking" — meaningfully higher, not airtight.
const DEMO_UPLOAD_LIMIT = 3;
const DEMO_UPLOAD_TTL_SECONDS = 30 * 24 * 60 * 60; // resets 30 days after first use, not a lifetime ban

function demoLimitKey(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  return `demo_uploads:${ip}`;
}

async function handleDemoUploadCheck(request, env) {
  if (!env.DEMO_LIMITS) {
    // KV binding not set up — fail CLOSED. An unconfigured limit blocking real trial
    // uploads until it's bound is a far safer default than the alternative: giving away
    // unlimited free access to anyone who notices uploads still work with no cap. Same
    // generic response shape as a genuinely exhausted limit, so there's nothing here to
    // distinguish "not configured" from "already used your 3" and go looking for.
    return new Response(JSON.stringify({ allowed: false, remaining: 0, configured: false }), {
      headers: { "Content-Type": "application/json" },
    });
  }
  const raw = await env.DEMO_LIMITS.get(demoLimitKey(request));
  const count = raw ? parseInt(raw, 10) : 0;
  const remaining = Math.max(0, DEMO_UPLOAD_LIMIT - count);
  return new Response(JSON.stringify({ allowed: remaining > 0, remaining, configured: true }), {
    headers: { "Content-Type": "application/json" },
  });
}

async function handleDemoUploadRecord(request, env) {
  if (!env.DEMO_LIMITS) {
    return new Response(JSON.stringify({ remaining: 0, configured: false }), {
      headers: { "Content-Type": "application/json" },
    });
  }
  const key = demoLimitKey(request);
  const raw = await env.DEMO_LIMITS.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  const newCount = count + 1;
  await env.DEMO_LIMITS.put(key, String(newCount), { expirationTtl: DEMO_UPLOAD_TTL_SECONDS });
  return new Response(JSON.stringify({ remaining: Math.max(0, DEMO_UPLOAD_LIMIT - newCount) }), {
    headers: { "Content-Type": "application/json" },
  });
}

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

  // One Stripe customer is the common case, but an email can have more than one customer
  // record (e.g. checked out more than once) — firing these in parallel instead of
  // awaiting one at a time avoids paying N sequential round-trips for the rare case.
  const results = await Promise.all(custData.data.map(async (customer) => {
    const subResp = await fetch(`https://api.stripe.com/v1/subscriptions?customer=${customer.id}&status=active&limit=10`, {
      headers: { "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}` },
    });
    const subData = await subResp.json();
    if (!subResp.ok || !subData.data?.length) return false;
    // Confirm it's actually the SaxRoll weekly price, not just any active subscription
    // on the account — matters the moment you add a second product/price.
    const items = subData.data.flatMap(sub => sub.items?.data || []);
    return items.some(item => item.price?.id === PRICE_ID);
  }));
  return results.some(Boolean);
}

// Opens the Stripe-hosted Customer Portal for the logged-in subscriber — self-serve
// cancel, update card, view billing history, no need to email you directly.
async function handleCustomerPortal(request, env, email) {
  if (!env.STRIPE_SECRET_KEY) return jsonError("Server isn't configured (missing STRIPE_SECRET_KEY).", 500);

  const custResp = await fetch(`https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}&limit=10`, {
    headers: { "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  const custData = await custResp.json();
  if (!custResp.ok || !custData.data?.length) {
    return jsonError("Couldn't find a Stripe customer for your account.", 404);
  }

  // If this email somehow has more than one Stripe customer record, prefer whichever
  // one actually has the active subscription, so the portal shows the right billing history.
  let customerId = custData.data[0].id;
  for (const customer of custData.data) {
    const subResp = await fetch(`https://api.stripe.com/v1/subscriptions?customer=${customer.id}&status=active&limit=1`, {
      headers: { "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}` },
    });
    const subData = await subResp.json();
    if (subResp.ok && subData.data?.length) {
      customerId = customer.id;
      break;
    }
  }

  const origin = new URL(request.url).origin;
  const params = new URLSearchParams();
  params.append("customer", customerId);
  params.append("return_url", `${origin}/app.html`);

  try {
    const resp = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    const portalSession = await resp.json();
    if (!resp.ok) return jsonError(portalSession.error?.message || "Stripe rejected the request.", 500);
    return new Response(JSON.stringify({ url: portalSession.url }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return jsonError("Could not reach Stripe: " + err.message, 500);
  }
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
<title>Sax Roll — Play Along on Alto Sax Without Reading Sheet Music</title>
<meta name="description" content="Turn any sheet music — PDF, scan, or MusicXML — into a scrolling fingering guide, timed to the music. See exactly which keys to press for any song on alto sax, no sheet-music reading required.">
<link rel="canonical" href="https://saxroll.com/">
<link rel="icon" type="image/png" href="/og-image.png">

<meta property="og:type" content="website">
<meta property="og:url" content="https://saxroll.com/">
<meta property="og:title" content="Sax Roll — Play Along on Alto Sax Without Reading Sheet Music">
<meta property="og:description" content="Turn any sheet music — PDF, scan, or MusicXML — into a scrolling fingering guide, timed to the music. See exactly which keys to press for any song on alto sax.">
<meta property="og:image" content="https://saxroll.com/og-image-wide.png">
<meta property="og:image:width" content="1536">
<meta property="og:image:height" content="1024">
<meta property="og:image:alt" content="Sax Roll — saxophone with a scrolling fingering highway">

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Sax Roll — Play Along on Alto Sax Without Reading Sheet Music">
<meta name="twitter:description" content="Turn any sheet music — PDF, scan, or MusicXML — into a scrolling fingering guide, timed to the music. See exactly which keys to press for any song on alto sax.">
<meta name="twitter:image" content="https://saxroll.com/og-image-wide.png">

<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#10161C; --panel:#1B242D; --line:#2B3641; --ink:#F1EDE4; --ink-dim:#9BA8B2; --brass:#D9A24B;
  }
  *{box-sizing:border-box;}
  body{
    margin:0; background:var(--bg); color:var(--ink);
    font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;
    display:flex; align-items:center; justify-content:center; min-height:100vh; padding:28px;
    background-image:
      radial-gradient(1px 1px at 15% 20%, rgba(255,255,255,.3) 0, transparent 60%),
      radial-gradient(1px 1px at 75% 12%, rgba(255,255,255,.22) 0, transparent 60%),
      radial-gradient(1px 1px at 40% 75%, rgba(255,255,255,.25) 0, transparent 60%),
      radial-gradient(1px 1px at 88% 60%, rgba(255,255,255,.18) 0, transparent 60%);
  }
  .page-wrap{ max-width:440px; width:100%; display:flex; flex-direction:column; gap:16px; }
  .box{width:100%; background:var(--panel); border:1px solid var(--line); border-radius:16px; padding:36px 32px; box-sizing:border-box;}
  .clarinet-box{ padding:24px 28px; }
  .clarinet-box h2{ font-family:'Fraunces',Georgia,serif; font-weight:600; font-size:19px; margin:0 0 8px; color:var(--ink); }
  .clarinet-box p{ margin-bottom:16px; }
  h1{font-family:'Fraunces',Georgia,serif; font-weight:600; font-size:34px; margin:0 0 8px; letter-spacing:-.01em;}
  h1 em{color:var(--brass); font-style:italic;}
  .tagline{color:var(--ink); font-size:16px; margin:0 0 16px; font-weight:500; line-height:1.4;}
  p{color:var(--ink-dim); font-size:14.5px; line-height:1.65; margin:0 0 14px;}
  ul{color:var(--ink-dim); font-size:14px; line-height:1.8; margin:0 0 22px; padding-left:20px;}
  li{margin-bottom:3px;}
  button{
    width:100%; background:var(--brass); color:#20150A; border:none; padding:13px;
    border-radius:9px; font-weight:600; font-size:15px; cursor:pointer;
    font-family:inherit; margin-top:10px; transition:filter .15s ease, transform .1s ease;
  }
  button:hover{ filter:brightness(1.08); }
  button:active{ transform:scale(.99); }
  button.secondary{ background:transparent; border:1px solid var(--line); color:var(--ink); font-weight:500; }
  button.demo-cta{ border-color:var(--brass); color:var(--brass); font-weight:600; }
  button.demo-cta:hover{ background:rgba(217,162,75,.08); }
  button.tertiary{
    width:100%; background:transparent; border:none; color:var(--ink-dim);
    font-family:inherit; font-size:13.5px; cursor:pointer; text-decoration:underline;
    padding:8px; margin-top:4px;
  }
  button.tertiary:hover{ color:var(--ink); }
  input{
    width:100%; background:#0E141A; border:1px solid var(--line); border-radius:9px;
    color:var(--ink); padding:12px; font-family:inherit; font-size:14.5px;
    box-sizing:border-box; margin-top:14px;
  }
  input:focus{ outline:none; border-color:var(--brass); }
  .msg{font-size:13px; margin-top:10px; min-height:16px; line-height:1.5;}
  .msg a{ color:inherit; }
  .divider{ text-align:center; color:var(--ink-dim); font-size:12.5px; margin:28px 0 16px; }
  .price{ color:#20150A; font-weight:700; }
</style>
</head>
<body>
<div class="page-wrap">
<div class="box">
  <h1>Sax <em>Roll</em></h1>
  <p class="tagline">Learn songs on alto sax without reading sheet music.</p>
  <p>Turn <strong>any sheet music you've got</strong> — a PDF, a scan, or an already-digital file — into a scrolling fingering guide. Colored bars show exactly which keys to press, timed to the actual music, so you can play along with real songs from day one.</p>
  <ul>
    <li>Works from any sheet music — PDF, scan, or MusicXML — pop, jazz, classical</li>
    <li>Slow the tempo down to isolate tricky passages</li>
    <li>Shows trills and extended-range fingerings, not just the basics</li>
  </ul>
  <button id="subscribeBtn">Subscribe — <span class="price">$1.99/week</span></button>
  <button class="secondary demo-cta" id="demoLink" type="button">Try it free — no account, no card, right now</button>
  <div class="divider">— already subscribed? —</div>
  <input id="emailInput" type="email" placeholder="you@example.com">
  <button class="secondary" id="loginBtn">Access my account</button>
  <div class="msg" id="msg"></div>
</div>
<div class="box clarinet-box">
  <h2>Play clarinet?</h2>
  <p>Clarinet Roll is the same idea, built for Bb clarinet — chalumeau and clarion registers, verified fingerings and transposition. Try it free, no account needed.</p>
  <button class="secondary demo-cta" id="clarinetDemoLink" type="button">Try Clarinet Roll free — no account, no card</button>
</div>
</div>
<script>
  const msg = document.getElementById('msg');
  const params = new URLSearchParams(window.location.search);
  if (params.get('checkout') === 'cancelled') { msg.textContent = 'Checkout cancelled — no charge was made.'; }
  if (params.get('checkout') === 'incomplete' || params.get('checkout') === 'error') { msg.textContent = 'Something went wrong finishing checkout — try again.'; msg.style.color = '#E8637A'; }

  document.getElementById('demoLink').addEventListener('click', () => {
    window.location.href = '/demo';
  });
  document.getElementById('clarinetDemoLink').addEventListener('click', () => {
    window.location.href = '/demo?instrument=clarinet';
  });

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
