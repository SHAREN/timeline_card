import {pickAvailableTrackIndex, trackHasVisibleHistory} from "./src/track-selection.js";

const segment = {type: "stay", start: new Date(), end: new Date()};
const yesterdayTracks = [
    {entityId: "device_tracker.renat_sharipov", segments: [segment], points: []},
    {entityId: "device_tracker.alsu_g", segments: [segment], points: []},
    {entityId: "device_tracker.alsu_sharipova_iandeks", segments: [], points: []},
];

if (pickAvailableTrackIndex(yesterdayTracks, 2) !== 0) {
    throw new Error("An empty Yandex track did not fall back to the first tracker with history");
}
if (pickAvailableTrackIndex(yesterdayTracks, 1) !== 1) {
    throw new Error("A selected tracker with history was not preserved");
}
if (pickAvailableTrackIndex([{segments: []}, {segments: []}], 1) !== 1) {
    throw new Error("Preferred selection should be preserved when all tracks are empty");
}
if (trackHasVisibleHistory({segments: [segment], error: "failed"})) {
    throw new Error("A failed track must not be treated as visible history");
}
if (pickAvailableTrackIndex([], 2) !== 0) {
    throw new Error("Empty track list must safely resolve to index zero");
}

console.log("track_selection_test=OK yandex-empty->renat-history");
