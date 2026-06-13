import type { WalkingResponse } from '../walking/types';

declare global {
    type WalkingResponse = import('../walking/types').WalkingResponse;
}
