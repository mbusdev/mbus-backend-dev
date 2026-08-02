import { makeBusRouteLines, Pattern } from "@/services/bustimeCommon";
import { describe, expect, it } from "vitest";

describe('makeBusRouteLines', () => {

    it('should handle short routes', () => {
        const pointsSingleStop: Pattern['pt'] = [
            makeStop(0, 45.0, 46.0, 'C1', 'Central'),
        ];
        const pattern = makePattern(0, 0, '', pointsSingleStop, '', pointsSingleStop);
        const lines = makeBusRouteLines('', pattern, false);
        expect(lines.length).toBe(2);
        expect(lines[0]).toEqual(lines[1]);
        const line = lines[0];
        expect(line.points).toEqual([{ lat: 45.0, lon: 46.0 }]);
        const stop = line.stops[0].stop;
        expect(stop.id).toEqual('C1');
        expect(stop.name).toEqual('Central');
        expect(stop.location.lat).toEqual(45);
        expect(stop.location.lon).toEqual(46);
    });
    
    it('should pass through isRide and rt', () => {
        for (const rt of ["BB", "CN"]) {
            for (const isRide of [true, false]) {
                const pointsSingleStop: Pattern['pt'] = [
                    makeStop(0, 45.0, 46.0, 'C1', 'Central'),
                ];
                const pattern = makePattern(0, 0, '', pointsSingleStop, null, null);
                const lines = makeBusRouteLines(rt, pattern, isRide);
                const line = lines[0];
                expect(line.routeId).toEqual(rt);
                for (const stop of line.stops) {
                    expect(stop.stop.routeId).toBe(rt);
                    expect(stop.stop.isRide).toBe(isRide);
                }
            }
        }
    });

    it('should handle both route and detour', () => {
        const points1: Pattern['pt'] = [
            makeStop(0, 45.0, 46.0, 'C1', 'Central'),
            makeWaypoint(1, 45.1, 45.9),
            makeStop(2, 45.2, 45.8, 'C2', 'Community'),
        ];
        const points2: Pattern['pt'] = [
            makeStop(0, 45.0, 46.0, 'C1', 'Central'),
            makeWaypoint(1, 0.0, 0.0),
            makeWaypoint(1, 2.0, 2.0),
            makeStop(2, 45.2, 45.8, 'C2', 'Community'),
        ];

        const positions = (points: Pattern['pt']) =>
            points.map((p) => { return { lat: p.lat, lon: p.lon}; });

        for (const [points, detourPts] of [[points1, points2], [points2, points1]]) {
            const pattern = makePattern(0, 0, '', points, '', detourPts);
            const lines = makeBusRouteLines('', pattern, false);
            expect(lines[0].points).toEqual(positions(points));
            expect(lines[1].points).toEqual(positions(detourPts));
        }
    });
});

function makeStop(seq: number, lat: number, lon: number, stpid: string, stpnm: string): Pattern['pt'][0] {
    return {
        seq,
        typ: "S",
        lat,
        lon,
        pdist: 0.0,
        stpid,
        stpnm,
    };
}

function makeWaypoint(seq: number, lat: number, lon: number): Pattern['pt'][0] {
    return {
        seq,
        typ: "W",
        lat,
        lon,
    };
}

function makePattern(
    pid: number, ln: number, rtdir: string, points: Pattern['pt'],
    dtrid: string | null, dtrpt: Pattern['pt'] | null,
): Pattern {
    return {
        pid: pid,
        ln: ln,
        rtdir: rtdir,
        pt: points,
        dtrid: dtrid ?? undefined,
        dtrpt: dtrpt ?? undefined,
    };
}
