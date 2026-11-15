import type { LatLon } from '@/services/bustimeCommon';
import { TurnDirectionSchema, type Directions, type DirectionInstruction } from './directions';
import { haversine } from './loadMap';

const DEFAULT_DENSITY = 0.25;

// controls placeholder instruction generation without changing the walking path
export interface MockDirectionsOptions {
    /**
     Fraction of interior coordinates to select, between 0 and 1
     defaults to MOCK_DIRECTIONS_DENSITY / 100, or 0.25; also used by invalid values
     */
    density?: number;
    // random values in [0, 1), can pass as an argument for repeatable tests – defaults to Math.random
    random?: () => number;
}

/**
 Adds mock instructions to an existing path; these do not describe actual turns or crossings
 Departure and arrival are always included for paths with at least two coordinates
 Density is the independent probability of selecting each interior coordinate
 Distances follow the supplied polyline in meters. No path or cache objects are modified.
 */
export function generateMockDirections(
    pathCoords: readonly LatLon[], options: MockDirectionsOptions = {},
): Directions {
    if (pathCoords.length < 2) return [];

    // use 0.25 as default density
    const density = DEFAULT_DENSITY;
    const random = options.random ?? Math.random;

    // start with depart point
    const steps: Directions = [{
        path_index: 0, distance: 0, onto: null, landmark: null, instruction: { type: 'depart' },
    }];

    const cumulativeDistances = [0];

    for (let i = 1; i < pathCoords.length; ++i) {
        const prev = pathCoords[i - 1];
        const curr = pathCoords[i];
        const segmentDistance = haversine(prev.lat, prev.lon, curr.lat, curr.lon);
        cumulativeDistances.push(cumulativeDistances[i - 1] + segmentDistance);

        // save i - 1 position for arrive instruction
        if (i === pathCoords.length - 1 || random() >= density) continue;

        let instruction: DirectionInstruction;
        switch (Math.floor(random() * 3)) {
            case 0:
                instruction = {
                    type: 'turn',
                    direction: TurnDirectionSchema.options[Math.floor(random() * TurnDirectionSchema.options.length)],
                };
                break;
            case 1:
                instruction = { type: 'continue' };
                break;
            default:
                instruction = { type: 'cross', street: null };
        }
        steps.push({ path_index: i, distance: 0, onto: null, landmark: null, instruction });
    }

    steps.push({
        path_index: pathCoords.length - 1, distance: 0, onto: null, landmark: null, instruction: { type: 'arrive' },
    });

    // fill in distance per step
    for (let i = 0; i < steps.length - 1; ++i) {
        steps[i].distance = cumulativeDistances[steps[i + 1].path_index] - cumulativeDistances[steps[i].path_index];
    }

    return steps;
}
