/**
 * Cloudflare Worker: solar-lookup-proxy
 *
 * Holds your Google Maps Platform API key as a secret and proxies three things
 * to the browser so the key is never exposed client-side:
 *   GET /lookup?address=...        -> geocode + Solar API buildingInsights
 *   GET /staticmap?lat=..&lng=..   -> satellite static map image (binary passthrough)
 *
 * Setup:
 *   1. Install wrangler: npm install -g wrangler
 *   2. wrangler login
 *   3. In this folder: wrangler init (or just deploy this file directly, see below)
 *   4. Set your key as a secret (never put it in this file or wrangler.toml):
 *        wrangler secret put GOOGLE_MAPS_API_KEY
 *      (paste your key when prompted)
 *   5. wrangler deploy
 *   6. Copy the resulting URL (e.g. https://solar-lookup-proxy.YOURNAME.workers.dev)
 *      into WORKER_BASE_URL in index.html
 *
 * Also make sure, in Google Cloud Console, this key has:
 *   - Geocoding API enabled
 *   - Solar API enabled
 *   - Maps Static API enabled
 *   - API restrictions limited to just those three (defense in depth, since this
 *     key now only ever gets called from your Worker, not the browser)
 *
 * CORS lockdown (do this before/at go-live, not after):
 *   By default this Worker answers CORS preflight for any origin ('*'), which is fine
 *   for local testing but means any website could call your Worker (and burn your
 *   Google API quota) once the URL leaks. Once your GitHub Pages / WordPress domain is
 *   known, set it as a plain (non-secret) Worker variable:
 *        wrangler secret put ALLOWED_ORIGIN
 *      (paste e.g. https://yourusername.github.io — no trailing slash — when prompted;
 *      "secret put" works fine for non-secret vars too and keeps setup to one command)
 *   With ALLOWED_ORIGIN set, only that origin will receive a non-null
 *   Access-Control-Allow-Origin header; everything else is silently denied by the
 *   browser's CORS check. Leave it unset while developing locally (file:// or
 *   localhost) — the Worker falls back to '*' automatically until you set it.
 */

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*', // set ALLOWED_ORIGIN before going live, see header comment
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
  };
}

function json(obj, status = 200, env = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders(env), 'Content-Type': 'application/json' }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const CORS_HEADERS = corsHeaders(env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (!env.GOOGLE_MAPS_API_KEY) {
      return json({ error: 'Server is missing GOOGLE_MAPS_API_KEY. Run: wrangler secret put GOOGLE_MAPS_API_KEY' }, 500, env);
    }

    if (url.pathname === '/lookup') {
      const address = url.searchParams.get('address');
      if (!address) return json({ error: 'address query param is required' }, 400, env);

      try {
        const geoRes = await fetch(
          `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${env.GOOGLE_MAPS_API_KEY}`
        );
        const geoData = await geoRes.json();
        if (geoData.status !== 'OK' || !geoData.results?.[0]) {
          return json({ error: 'Could not geocode that address (status: ' + geoData.status + ')' }, 400, env);
        }
        const loc = geoData.results[0].geometry.location;
        const formatted = geoData.results[0].formatted_address;

        const solarRes = await fetch(
          `https://solar.googleapis.com/v1/buildingInsights:findClosest?location.latitude=${loc.lat}&location.longitude=${loc.lng}&key=${env.GOOGLE_MAPS_API_KEY}`
        );
        const solarData = await solarRes.json();
        if (!solarRes.ok) {
          return json({ error: solarData.error?.message || 'Solar API request failed' }, solarRes.status, env);
        }
        if (!solarData.solarPotential) {
          return json({ error: 'No solar potential data returned for this building (imagery may not be available here).' }, 404, env);
        }

        return json({
          lat: loc.lat,
          lng: loc.lng,
          formatted,
          solarPotential: solarData.solarPotential
        }, 200, env);
      } catch (err) {
        return json({ error: err.message }, 500, env);
      }
    }

    if (url.pathname === '/staticmap') {
      const lat = url.searchParams.get('lat');
      const lng = url.searchParams.get('lng');
      const zoom = url.searchParams.get('zoom') || '20';
      const size = url.searchParams.get('size') || '420x260';
      if (!lat || !lng) return json({ error: 'lat and lng query params are required' }, 400, env);

      const mapUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=${zoom}&size=${size}&scale=2&maptype=satellite&markers=color:red|${lat},${lng}&key=${env.GOOGLE_MAPS_API_KEY}`;
      const imgRes = await fetch(mapUrl);
      if (!imgRes.ok) return json({ error: 'Static map request failed' }, imgRes.status, env);

      return new Response(imgRes.body, {
        headers: {
          ...CORS_HEADERS,
          'Content-Type': imgRes.headers.get('Content-Type') || 'image/png',
          'Cache-Control': 'public, max-age=86400'
        }
      });
    }

    return json({ error: 'Not found. Use /lookup?address=... or /staticmap?lat=..&lng=..' }, 404, env);
  }
};
