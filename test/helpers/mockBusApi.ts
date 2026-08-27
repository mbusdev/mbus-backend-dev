/**
 * Builders for realistic BusTime v3 API payloads, shaped like the real
 * responses from mbus.ltp.umich.edu (see src/services/mbus.ts).
 */

export interface PrdOverrides {
    stpid: string;
    stpnm: string;
    rt: string;
    rtdir: string;
    /** Minutes until arrival as the API reports it: a number string or "DUE". */
    prdctdn: string;
    vid?: string;
    tatripid?: string;
    des?: string;
    prdtm?: string;
    [key: string]: unknown;
}

/**
 * One prediction entry as returned inside bustime-response.prd.
 * Fields not under test are filled with realistic constants.
 */
export function prd(overrides: PrdOverrides): Record<string, unknown> {
    const minutes = overrides.prdctdn === 'DUE' ? 1 : parseInt(overrides.prdctdn, 10);
    const base: Record<string, unknown> = {
        tmstmp: '20260826 12:00:00',
        typ: 'A',
        dstp: 1200,
        vid: '4001',
        tatripid: '999001',
        origtatripno: '999001',
        tablockid: 'BB -401',
        des: 'Bursley-Baits',
        dly: false,
        zone: '',
        // The route rebuild requests unixTime, so prdtm parses as epoch millis.
        prdtm: String(Date.parse('2026-08-26T12:00:00Z') + minutes * 60_000),
    };
    return { ...base, ...overrides };
}

/** Wraps predictions in the chunked response shape fetchPredictions returns. */
export function predictionChunk(prds: Record<string, unknown>[]): Record<string, unknown> {
    return { 'bustime-response': { prd: prds } };
}

export interface PatternStop {
    stpid: string;
    stpnm: string;
    lat: number;
    lon: number;
}

/**
 * A route pattern in the shape of bustime-response.ptr, as cached in
 * state.cachedRoutes by initializeRoutes. Interleaves waypoints ("W") between
 * stops the way the real feed does; processPredictions must skip them.
 */
export function pattern(rtdir: string, stops: PatternStop[]): Record<string, unknown> {
    const pt: Record<string, unknown>[] = [];
    stops.forEach((s, i) => {
        pt.push({
            seq: pt.length + 1,
            typ: 'S',
            stpid: s.stpid,
            stpnm: s.stpnm,
            lat: String(s.lat),
            lon: String(s.lon),
            pdist: i * 800,
        });
        if (i < stops.length - 1) {
            pt.push({
                seq: pt.length + 1,
                typ: 'W',
                lat: String(s.lat + 0.001),
                lon: String(s.lon + 0.001),
                pdist: i * 800 + 400,
            });
        }
    });
    return { pid: 1000 + pt.length, ln: stops.length * 800, rtdir, pt };
}
