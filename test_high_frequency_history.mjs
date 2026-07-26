import {readFile, writeFile, unlink} from "node:fs/promises";
import {pathToFileURL} from "node:url";
import path from "node:path";

const sourcePath = path.resolve("src/segmentation.js");
const isolatedPath = path.resolve(".tmp-segmentation-under-test.mjs");
let source = await readFile(sourcePath, "utf8");
source = source.replace(
    'import {endOfDay, haversineMeters, startOfDay, toLatLon, toPoint} from "./utils.js";\nimport {resolveStaySegments} from "./reverse-geocoding.js";\nimport {resolveActivities} from "./activity.js";',
    `const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
const endOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
const toLatLon = (point) => ({lat: point.point[0], lon: point.point[1]});
const toPoint = (state) => {
    const attrs = state.a || {};
    const lat = Number(attrs.latitude);
    const lon = Number(attrs.longitude);
    return Number.isFinite(lat) && Number.isFinite(lon)
        ? {point: [lat, lon], timestamp: new Date(state.lu * 1000)}
        : null;
};
const haversineMeters = (a, b) => {
    const toRad = (degrees) => (degrees * Math.PI) / 180;
    const radius = 6371000;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const value = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return radius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
};
const resolveStaySegments = (segments) => {
    for (const segment of segments) {
        if (segment.type === "stay" && !segment.zoneName) segment.placeName = "Unknown location";
    }
};
const resolveActivities = (segments) => segments;`,
);
await writeFile(isolatedPath, source, "utf8");
const modulePath = pathToFileURL(isolatedPath).href + "?test=" + Date.now();
const {getSegmentedTracks, simplifyHistoryPoints} = await import(modulePath);

const start = new Date(2026, 6, 26, 10, 0, 0, 0);
const jitterPoints = Array.from({length: 1200}, (_, index) => ({
    point: [54.4856 + Math.sin(index) * 0.00001, 53.476 + Math.cos(index) * 0.00001],
    timestamp: new Date(start.getTime() + index * 6000),
}));
const simplifiedJitter = simplifyHistoryPoints(jitterPoints);
if (simplifiedJitter.length > 70) {
    throw new Error(`Stationary high-frequency history was not reduced enough: ${simplifiedJitter.length}`);
}
if (simplifiedJitter[0] !== jitterPoints[0] || simplifiedJitter.at(-1) !== jitterPoints.at(-1)) {
    throw new Error("First or last GPS sample was lost");
}

const movingPoints = Array.from({length: 100}, (_, index) => ({
    point: [54.48, 53.47 + index * 0.0005],
    timestamp: new Date(start.getTime() + index * 10000),
}));
const simplifiedMoving = simplifyHistoryPoints(movingPoints);
if (simplifiedMoving.length < 90) {
    throw new Error(`Real movement was reduced too aggressively: ${simplifiedMoving.length}`);
}

const timestamp = (minutes) => new Date(2026, 6, 26, 10, minutes, 0, 0).getTime() / 1000;
const compactState = (entityId, minutes, latitude, longitude) => ({
    entity_id: entityId,
    lu: timestamp(minutes),
    lc: timestamp(minutes),
    a: {latitude, longitude},
});
const histories = {
    "device_tracker.first": [
        compactState("device_tracker.first", 0, 54.48, 53.47),
        compactState("device_tracker.first", 20, 54.48001, 53.47001),
    ],
    "device_tracker.second": [
        compactState("device_tracker.second", 0, 54.49, 53.48),
        compactState("device_tracker.second", 20, 54.49001, 53.48001),
    ],
};
const hass = {
    states: {},
    callWS: async (message) => {
        const entityId = message.entity_ids[0];
        if (entityId === "device_tracker.failed") throw new Error("simulated recorder failure");
        return {[entityId]: histories[entityId] || []};
    },
};
const config = {
    entity: [{entity: "device_tracker.first"}, {entity: "device_tracker.failed"}, {entity: "device_tracker.second"}],
    stay_radius_m: 75,
    min_stay_minutes: 10,
    max_reasonable_speed_kmh: 300,
    osm_api_key: null,
    activity_icon_map: {},
};
const tracks = await getSegmentedTracks(new Date(2026, 6, 26), config, hass, () => {});
if (tracks.length !== 3) throw new Error(`Expected 3 independent tracks, got ${tracks.length}`);
if (tracks[0].error || tracks[0].segments.length === 0) throw new Error("First valid track disappeared");
if (!tracks[1].error || tracks[1].segments.length !== 0) throw new Error("Failed track was not isolated");
if (tracks[2].error || tracks[2].segments.length === 0) throw new Error("Second valid track disappeared");

await unlink(isolatedPath);
console.log(
    `high_frequency_history_test=OK stationary:${jitterPoints.length}->${simplifiedJitter.length} moving:${movingPoints.length}->${simplifiedMoving.length}`,
);
