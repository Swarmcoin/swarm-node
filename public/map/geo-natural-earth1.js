/* ==========================================================================
   geo-natural-earth1.js — the Natural Earth projection, on its own.

   This is a deliberately small stand-in for d3-geo. The map on this site uses
   exactly one projection, a fixed viewBox and geometry that was already cut at
   the antimeridian by tools/build_map_data.mjs, so none of d3-geo's clipping,
   rotation, resampling or fitting machinery is reachable. Shipping d3-geo plus
   d3-array (about 46 KB minified) to reach one polynomial would be most of the
   site's whole JavaScript budget.

   The naturalEarth1Raw polynomial and the scale/translate convention below are
   taken from d3-geo (ISC, Copyright 2010-2024 Mike Bostock) — see the copy of
   its licence in d3-geo.LICENSE next to this file. The projection itself is
   Tom Patterson's Natural Earth, refined by Bojan Šavrič and others; it is in
   the public domain.

   Exposes one global, SwarmGeo, with no dependencies.
   ========================================================================== */
(function (global) {
  "use strict";

  var RAD = Math.PI / 180;

  /* d3-geo: src/projection/naturalEarth1.js — lambda and phi in radians. */
  function naturalEarth1Raw(lambda, phi) {
    var phi2 = phi * phi, phi4 = phi2 * phi2;
    return [
      lambda * (0.8707 - 0.131979 * phi2 + phi4 * (-0.013791 + phi4 * (0.003971 * phi2 - 0.001529 * phi4))),
      phi * (1.007226 + phi2 * (0.015085 + phi4 * (-0.044475 + 0.028874 * phi2 - 0.005916 * phi4)))
    ];
  }

  /* d3-geo scales and flips y the same way: X = k*x + dx, Y = dy - k*y. */
  function naturalEarth1(scale, translate) {
    var k = scale === undefined ? 175.295 : scale;
    var dx = translate ? translate[0] : 480;
    var dy = translate ? translate[1] : 250;
    return function (coord) {
      var p = naturalEarth1Raw(coord[0] * RAD, coord[1] * RAD);
      return [k * p[0] + dx, dy - k * p[1]];
    };
  }

  function round(n) {
    return Math.round(n * 10) / 10;
  }

  /* Path data for a GeoJSON Polygon / MultiPolygon / LineString / MultiLineString
     or a GeometryCollection / Feature / FeatureCollection wrapping them. */
  function path(geometry, project) {
    var out = [];
    draw(geometry, project, out);
    return out.join("");
  }

  function draw(g, project, out) {
    if (!g) return;
    var i;
    switch (g.type) {
      case "FeatureCollection":
        for (i = 0; i < g.features.length; i++) draw(g.features[i], project, out);
        return;
      case "Feature":
        draw(g.geometry, project, out);
        return;
      case "GeometryCollection":
        for (i = 0; i < g.geometries.length; i++) draw(g.geometries[i], project, out);
        return;
      case "Polygon":
        rings(g.coordinates, project, out, true);
        return;
      case "MultiPolygon":
        for (i = 0; i < g.coordinates.length; i++) rings(g.coordinates[i], project, out, true);
        return;
      case "LineString":
        rings([g.coordinates], project, out, false);
        return;
      case "MultiLineString":
        rings(g.coordinates, project, out, false);
        return;
      default:
        return;
    }
  }

  function rings(list, project, out, close) {
    for (var i = 0; i < list.length; i++) {
      var ring = list[i];
      if (!ring || ring.length < 2) continue;
      for (var j = 0; j < ring.length; j++) {
        var p = project(ring[j]);
        out.push(j === 0 ? "M" : "L", round(p[0]), ",", round(p[1]));
      }
      if (close) out.push("Z");
    }
  }

  /* Meridians and parallels, as a MultiLineString in lon/lat. */
  function graticule(step, precision) {
    var s = step || 30;
    var d = precision || 2.5;
    var lines = [];
    var lon, lat, line;
    for (lon = -180; lon <= 180; lon += s) {
      line = [];
      for (lat = -90; lat <= 90; lat += d) line.push([lon, lat]);
      line.push([lon, 90]);
      lines.push(line);
    }
    for (lat = -90 + s; lat < 90; lat += s) {
      line = [];
      for (lon = -180; lon <= 180; lon += d) line.push([lon, lat]);
      line.push([180, lat]);
      lines.push(line);
    }
    return { type: "MultiLineString", coordinates: lines };
  }

  /* The outline of the whole globe in this projection, as a Polygon. */
  function sphere(precision) {
    var d = precision || 2.5;
    var ring = [];
    var lon, lat;
    for (lon = -180; lon <= 180; lon += d) ring.push([lon, -90]);
    for (lat = -90; lat <= 90; lat += d) ring.push([180, lat]);
    for (lon = 180; lon >= -180; lon -= d) ring.push([lon, 90]);
    for (lat = 90; lat >= -90; lat -= d) ring.push([-180, lat]);
    return { type: "Polygon", coordinates: [ring] };
  }

  global.SwarmGeo = {
    naturalEarth1: naturalEarth1,
    naturalEarth1Raw: naturalEarth1Raw,
    path: path,
    graticule: graticule,
    sphere: sphere
  };
})(this);
