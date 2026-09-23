// The cities the Swarm map's opt-in offers to choose from.
//
// Why a list and not a text box: the map draws a place from coordinates, and
// asking an operator to type numbers invites a wrong number. Every entry here is
// a city centre rounded to two decimals — about a kilometre, which is the most
// this feature is allowed to know — and the list is the whole of what the app
// can offer without a geocoding service (a service would mean telling a third
// party which city somebody is thinking about, which is exactly what this map
// refuses to do).
//
// The published map (swarm.green/data/swarm-map.json) remains authoritative. If
// a place is missing here, the map page builds a request the operator sends
// themselves; nothing in this file ever leaves the machine.

export const CITIES = [
  { city: 'Amsterdam', country: 'NL', lon: 4.90, lat: 52.37 },
  { city: 'Athens', country: 'GR', lon: 23.73, lat: 37.98 },
  { city: 'Atlanta', country: 'US', lon: -84.39, lat: 33.75 },
  { city: 'Auckland', country: 'NZ', lon: 174.76, lat: -36.85 },
  { city: 'Bangkok', country: 'TH', lon: 100.50, lat: 13.76 },
  { city: 'Barcelona', country: 'ES', lon: 2.17, lat: 41.39 },
  { city: 'Beijing', country: 'CN', lon: 116.40, lat: 39.90 },
  { city: 'Belgrade', country: 'RS', lon: 20.46, lat: 44.79 },
  { city: 'Berlin', country: 'DE', lon: 13.40, lat: 52.52 },
  { city: 'Bogotá', country: 'CO', lon: -74.07, lat: 4.71 },
  { city: 'Boston', country: 'US', lon: -71.06, lat: 42.36 },
  { city: 'Bratislava', country: 'SK', lon: 17.11, lat: 48.15 },
  { city: 'Brisbane', country: 'AU', lon: 153.03, lat: -27.47 },
  { city: 'Brussels', country: 'BE', lon: 4.35, lat: 50.85 },
  { city: 'Bucharest', country: 'RO', lon: 26.10, lat: 44.43 },
  { city: 'Budapest', country: 'HU', lon: 19.04, lat: 47.50 },
  { city: 'Buenos Aires', country: 'AR', lon: -58.38, lat: -34.60 },
  { city: 'Cairo', country: 'EG', lon: 31.24, lat: 30.04 },
  { city: 'Cape Town', country: 'ZA', lon: 18.42, lat: -33.92 },
  { city: 'Chicago', country: 'US', lon: -87.63, lat: 41.88 },
  { city: 'Copenhagen', country: 'DK', lon: 12.57, lat: 55.68 },
  { city: 'Dallas', country: 'US', lon: -96.80, lat: 32.78 },
  { city: 'Delhi', country: 'IN', lon: 77.21, lat: 28.61 },
  { city: 'Denver', country: 'US', lon: -104.99, lat: 39.74 },
  { city: 'Dubai', country: 'AE', lon: 55.27, lat: 25.20 },
  { city: 'Dublin', country: 'IE', lon: -6.26, lat: 53.35 },
  { city: 'Frankfurt', country: 'DE', lon: 8.68, lat: 50.11 },
  { city: 'Geneva', country: 'CH', lon: 6.14, lat: 46.20 },
  { city: 'Glasgow', country: 'GB', lon: -4.25, lat: 55.86 },
  { city: 'Hamburg', country: 'DE', lon: 9.99, lat: 53.55 },
  { city: 'Helsinki', country: 'FI', lon: 24.94, lat: 60.17 },
  { city: 'Hong Kong', country: 'HK', lon: 114.17, lat: 22.32 },
  { city: 'Houston', country: 'US', lon: -95.37, lat: 29.76 },
  { city: 'Istanbul', country: 'TR', lon: 28.98, lat: 41.01 },
  { city: 'Jakarta', country: 'ID', lon: 106.85, lat: -6.21 },
  { city: 'Johannesburg', country: 'ZA', lon: 28.05, lat: -26.20 },
  { city: 'Kyiv', country: 'UA', lon: 30.52, lat: 50.45 },
  { city: 'Kuala Lumpur', country: 'MY', lon: 101.69, lat: 3.14 },
  { city: 'Lagos', country: 'NG', lon: 3.38, lat: 6.52 },
  { city: 'Lima', country: 'PE', lon: -77.04, lat: -12.05 },
  { city: 'Lisbon', country: 'PT', lon: -9.14, lat: 38.72 },
  { city: 'Ljubljana', country: 'SI', lon: 14.51, lat: 46.06 },
  { city: 'London', country: 'GB', lon: -0.13, lat: 51.51 },
  { city: 'Los Angeles', country: 'US', lon: -118.24, lat: 34.05 },
  { city: 'Madrid', country: 'ES', lon: -3.70, lat: 40.42 },
  { city: 'Manila', country: 'PH', lon: 120.98, lat: 14.60 },
  { city: 'Melbourne', country: 'AU', lon: 144.96, lat: -37.81 },
  { city: 'Mexico City', country: 'MX', lon: -99.13, lat: 19.43 },
  { city: 'Miami', country: 'US', lon: -80.19, lat: 25.76 },
  { city: 'Milan', country: 'IT', lon: 9.19, lat: 45.46 },
  { city: 'Montreal', country: 'CA', lon: -73.57, lat: 45.50 },
  { city: 'Moscow', country: 'RU', lon: 37.62, lat: 55.75 },
  { city: 'Mumbai', country: 'IN', lon: 72.88, lat: 19.08 },
  { city: 'Munich', country: 'DE', lon: 11.58, lat: 48.14 },
  { city: 'Nairobi', country: 'KE', lon: 36.82, lat: -1.29 },
  { city: 'New York', country: 'US', lon: -74.01, lat: 40.71 },
  { city: 'Oslo', country: 'NO', lon: 10.75, lat: 59.91 },
  { city: 'Paris', country: 'FR', lon: 2.35, lat: 48.86 },
  { city: 'Perth', country: 'AU', lon: 115.86, lat: -31.95 },
  { city: 'Prague', country: 'CZ', lon: 14.44, lat: 50.08 },
  { city: 'Reykjavík', country: 'IS', lon: -21.83, lat: 64.15 },
  { city: 'Riga', country: 'LV', lon: 24.11, lat: 56.95 },
  { city: 'Rio de Janeiro', country: 'BR', lon: -43.17, lat: -22.91 },
  { city: 'Riyadh', country: 'SA', lon: 46.72, lat: 24.71 },
  { city: 'Rome', country: 'IT', lon: 12.50, lat: 41.90 },
  { city: 'San Francisco', country: 'US', lon: -122.42, lat: 37.77 },
  { city: 'Santiago', country: 'CL', lon: -70.65, lat: -33.45 },
  { city: 'São Paulo', country: 'BR', lon: -46.63, lat: -23.55 },
  { city: 'Seattle', country: 'US', lon: -122.33, lat: 47.61 },
  { city: 'Seoul', country: 'KR', lon: 126.98, lat: 37.57 },
  { city: 'Singapore', country: 'SG', lon: 103.82, lat: 1.35 },
  { city: 'Sofia', country: 'BG', lon: 23.32, lat: 42.70 },
  { city: 'Stockholm', country: 'SE', lon: 18.07, lat: 59.33 },
  { city: 'Sydney', country: 'AU', lon: 151.21, lat: -33.87 },
  { city: 'Taipei', country: 'TW', lon: 121.57, lat: 25.03 },
  { city: 'Tallinn', country: 'EE', lon: 24.75, lat: 59.44 },
  { city: 'Tel Aviv', country: 'IL', lon: 34.78, lat: 32.08 },
  { city: 'Tokyo', country: 'JP', lon: 139.69, lat: 35.69 },
  { city: 'Toronto', country: 'CA', lon: -79.38, lat: 43.65 },
  { city: 'Vancouver', country: 'CA', lon: -123.12, lat: 49.28 },
  { city: 'Vienna', country: 'AT', lon: 16.37, lat: 48.21 },
  { city: 'Vilnius', country: 'LT', lon: 25.28, lat: 54.69 },
  { city: 'Warsaw', country: 'PL', lon: 21.01, lat: 52.23 },
  { city: 'Washington', country: 'US', lon: -77.04, lat: 38.91 },
  { city: 'Wellington', country: 'NZ', lon: 174.78, lat: -41.29 },
  { city: 'Zagreb', country: 'HR', lon: 15.98, lat: 45.81 },
  { city: 'Zürich', country: 'CH', lon: 8.54, lat: 47.38 },
];

/** Case- and accent-insensitive enough for a search box. */
function fold(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** The entries whose city or country contains `query`. Empty query: the first 12. */
export function searchCities(query, limit = 12) {
  const needle = fold(query).trim();
  if (!needle) return CITIES.slice(0, limit);
  return CITIES.filter((c) => fold(c.city).includes(needle) || fold(c.country).includes(needle)).slice(0, limit);
}

/** The entry matching a stored city, so the page can show it is still in the list. */
export function findCity(city, country) {
  return CITIES.find((c) => fold(c.city) === fold(city) && fold(c.country) === fold(country || '')) || null;
}
