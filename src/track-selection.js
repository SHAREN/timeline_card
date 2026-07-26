export function trackHasVisibleHistory(track) {
    return !track?.error && Array.isArray(track?.segments) && track.segments.length > 0;
}

export function pickAvailableTrackIndex(tracks, preferredIndex = 0) {
    if (!Array.isArray(tracks) || tracks.length === 0) return 0;

    const normalizedPreferred = Number.isInteger(preferredIndex)
        ? Math.min(Math.max(0, preferredIndex), tracks.length - 1)
        : 0;

    if (trackHasVisibleHistory(tracks[normalizedPreferred])) {
        return normalizedPreferred;
    }

    const availableIndex = tracks.findIndex((track) => trackHasVisibleHistory(track));
    return availableIndex >= 0 ? availableIndex : normalizedPreferred;
}
