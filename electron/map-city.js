// The operator's own city, and how it joins the published map.
//
// Two separate things live here, and keeping them separate is the point:
//
//   * the PUBLISHED map is a file the project hosts (swarm.green/data/
//     swarm-map.json). Nobody can add themselves to it from inside the app, and
//     this app never sends anything anywhere by itself.
//   * the operator's OWN city is a setting on this machine. It is drawn on this
//     machine's map the moment it is chosen, labelled as not published, and it
//     leaves the machine only if the operator copies the request and sends it.
//
// Pure: no Electron, no network, no disk. The main process owns the store, the
// map page owns the drawing, and both call in here so the two cannot disagree
// about what a valid city is or how the lists merge.

'use strict';

const MAX_CITY = 80;
const MAX_COUNTRY = 8;

/** A city the operator picked, or the reason it was refused. */
function validateCity(value) {
  if (!value || typeof value !== 'object') return { ok: false, error: 'No city was given.' };
  const city = typeof value.city === 'string' ? value.city.trim() : '';
  const country = typeof value.country === 'string' ? value.country.trim().toUpperCase() : '';
  const lon = Number(value.lon);
  const lat = Number(value.lat);
  if (!city) return { ok: false, error: 'Give the city a name.' };
  if (city.length > MAX_CITY) return { ok: false, error: `Keep the city name under ${MAX_CITY} characters.` };
  if (country.length > MAX_COUNTRY) return { ok: false, error: 'Keep the country code short (for example DE).' };
  if (/[\x00-\x1f]/.test(city + country)) return { ok: false, error: 'That name contains control characters.' };
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) return { ok: false, error: 'Longitude must be between -180 and 180.' };
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return { ok: false, error: 'Latitude must be between -90 and 90.' };
  // City level, never finer. Two decimals is about a kilometre of granularity
  // and is the most this feature is allowed to know.
  return {
    ok: true,
    city: {
      city,
      country,
      lon: Math.round(lon * 100) / 100,
      lat: Math.round(lat * 100) / 100
    }
  };
}

const key = (place) => `${String(place.city).toLowerCase()}|${String(place.country || '').toUpperCase()}`;

/**
 * What the map draws: the published places, plus the operator's own city.
 *
 * Never two markers in one spot: once the file already names the operator's
 * city, THAT entry is marked as theirs rather than a second dot being drawn
 * beside it. Marked, not dropped — the entry stays `published: true` and keeps
 * its count, because it is still the file's place and still the file's count;
 * `mine` only says "and this is where you are".
 *
 * This matters more since the map became a live census of the seed's peers. A
 * connected node now puts its OWN city in the file, so the marker the operator
 * set on the Swarm map page vanished at exactly the moment it became true —
 * the one case where the answer is "yes, that dot is you".
 *
 * Each entry says where it came from, so the page can label the difference
 * instead of implying the operator's city is public when it is not.
 */
function mergePlaces(published, mine) {
  const publishedList = Array.isArray(published) ? published.filter(Boolean) : [];
  const out = publishedList.map((n) => ({ ...n, mine: false, published: true }));
  if (!mine || !mine.city) return out;

  const alreadyThere = out.find((n) => key(n) === key(mine));
  if (alreadyThere) {
    alreadyThere.mine = true;
    return out;
  }

  out.push({ ...mine, count: 1, mine: true, published: false });
  return out;
}

/** The line the operator copies when they want the project to publish it. */
function publishRequest(mine) {
  if (!mine || !mine.city) return '';
  const where = mine.country ? `${mine.city}, ${mine.country}` : mine.city;
  return `Please add my node to the SWARM heat map: ${where} (${mine.lon}, ${mine.lat}). City level only.`;
}

module.exports = { validateCity, mergePlaces, publishRequest, key };
