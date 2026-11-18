import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    DAMPING_DEFAULT,
    DAMPING_FLICK,
    DECELERATION_RATE,
    FAST_FLICK_VELOCITY,
    FLICK_MIN_VELOCITY,
    SIDE_OPACITY,
    SIDE_SCALE,
    SLIDE_GAP_PX,
    SPRING_RESPONSE_S,
    STRIDE_FRACTION,
    VELOCITY_WINDOW_MS,
    DragGesture,
    SpringAnimator,
    canLoop,
    constrainPosition,
    dampingForRelease,
    isSpringAtRest,
    mod,
    pickSnapIndex,
    projectMomentum,
    rubberBand,
    slideStyle,
    slideVisual,
    stepSpring,
    velocityFromSamples,
    wrapDistance,
    type SpringState
} from './carouselPhysics';

const STRIDE = 800;
const FRAME = 1 / 60;

function settle(start: SpringState, target: number, damping: number, seconds = 4): SpringState[] {
    const frames: SpringState[] = [start];
    let state = start;
    for (let t = 0; t < seconds; t += FRAME) {
        state = stepSpring(state, target, { damping, response: SPRING_RESPONSE_S }, FRAME);
        frames.push(state);
    }
    return frames;
}

describe('projectMomentum', () => {
    it('matches Apple\'s projection formula', () => {
        const velocity = 1000;
        expect(projectMomentum(velocity)).toBeCloseTo((velocity / 1000) * DECELERATION_RATE / (1 - DECELERATION_RATE), 6);
    });

    it('keeps the sign of the velocity and is zero at rest', () => {
        expect(projectMomentum(-1000)).toBeLessThan(0);
        expect(projectMomentum(0)).toBe(0);
    });
});

describe('velocityFromSamples', () => {
    it('measures px/s over the recent window', () => {
        const samples = [ { x: 0, t: 0 }, { x: 10, t: 50 }, { x: 20, t: 100 } ];
        expect(velocityFromSamples(samples, 100)).toBeCloseTo(200, 6);
    });

    it('ignores samples older than the window', () => {
        const samples = [ { x: 0, t: 0 }, { x: 500, t: 300 }, { x: 510, t: 400 } ];
        expect(velocityFromSamples(samples, 400)).toBeCloseTo(100, 6);
    });

    it('is zero when the pointer rested before release', () => {
        const samples = [ { x: 0, t: 0 }, { x: 100, t: 50 } ];
        expect(velocityFromSamples(samples, 50 + VELOCITY_WINDOW_MS + 1)).toBe(0);
    });

    it('is zero with fewer than two samples', () => {
        expect(velocityFromSamples([], 0)).toBe(0);
        expect(velocityFromSamples([{ x: 1, t: 0 }], 0)).toBe(0);
    });
});

describe('pickSnapIndex', () => {
    it('stays on the slide for a small, slow drag', () => {
        expect(pickSnapIndex(2, 100, 0, STRIDE, 5)).toBe(2);
        expect(pickSnapIndex(2, -100, 0, STRIDE, 5)).toBe(2);
    });

    it('goes to the next slide when dragged past halfway to the left', () => {
        expect(pickSnapIndex(2, -STRIDE * 0.6, 0, STRIDE, 5)).toBe(3);
    });

    it('goes to the previous slide when dragged past halfway to the right', () => {
        expect(pickSnapIndex(2, STRIDE * 0.6, 0, STRIDE, 5)).toBe(1);
    });

    it('lets a short, quick flick carry to the next slide through projection', () => {
        const velocity = -1200;
        expect(Math.abs(projectMomentum(velocity))).toBeGreaterThan(STRIDE / 2);
        expect(pickSnapIndex(2, -40, velocity, STRIDE, 5)).toBe(3);
    });

    it('travels at most one slide for an ordinary flick', () => {
        const velocity = -(FAST_FLICK_VELOCITY - 1);
        expect(pickSnapIndex(2, 0, velocity, STRIDE, 5)).toBe(3);
    });

    it('may travel two slides for a very fast flick', () => {
        expect(pickSnapIndex(2, 0, -FAST_FLICK_VELOCITY, STRIDE, 5)).toBe(4);
        expect(pickSnapIndex(2, 0, FAST_FLICK_VELOCITY, STRIDE, 5)).toBe(0);
    });

    it('returns an unwrapped index when looping so the spring takes the short way', () => {
        expect(pickSnapIndex(4, -STRIDE, 0, STRIDE, 5)).toBe(5);
        expect(pickSnapIndex(0, STRIDE, 0, STRIDE, 5)).toBe(-1);
    });

    it('clamps to the ends when the carousel does not loop', () => {
        expect(canLoop(2)).toBe(false);
        expect(pickSnapIndex(1, -STRIDE, 0, STRIDE, 2)).toBe(1);
        expect(pickSnapIndex(0, STRIDE, 0, STRIDE, 2)).toBe(0);
        expect(pickSnapIndex(0, -STRIDE, 0, STRIDE, 2)).toBe(1);
    });

    it('does nothing for a single slide or an unmeasured width', () => {
        expect(pickSnapIndex(0, -STRIDE, -3000, STRIDE, 1)).toBe(0);
        expect(pickSnapIndex(3, -STRIDE, -3000, 0, 5)).toBe(3);
    });
});

describe('dampingForRelease', () => {
    it('is critically damped without momentum and bounces slightly after a flick', () => {
        expect(dampingForRelease(0)).toBe(DAMPING_DEFAULT);
        expect(dampingForRelease(FLICK_MIN_VELOCITY - 1)).toBe(DAMPING_DEFAULT);
        expect(dampingForRelease(-FLICK_MIN_VELOCITY)).toBe(DAMPING_FLICK);
    });
});

describe('stepSpring', () => {
    it('returns the state unchanged for a non-positive time step', () => {
        const state = { value: 3, velocity: 1 };
        expect(stepSpring(state, 0, { damping: 1, response: SPRING_RESPONSE_S }, 0)).toBe(state);
    });

    it('settles a critically damped spring on the target without overshoot', () => {
        const frames = settle({ value: 0, velocity: 0 }, 1, DAMPING_DEFAULT);
        expect(Math.max(...frames.map(frame => frame.value))).toBeLessThanOrEqual(1 + 1e-9);
        const last = frames[frames.length - 1];
        expect(isSpringAtRest(last, 1)).toBe(true);
    });

    it('overshoots a little and still settles when under-damped', () => {
        const frames = settle({ value: 0, velocity: 0 }, 1, DAMPING_FLICK);
        expect(Math.max(...frames.map(frame => frame.value))).toBeGreaterThan(1);
        expect(Math.max(...frames.map(frame => frame.value))).toBeLessThan(1.1);
        expect(isSpringAtRest(frames[frames.length - 1], 1)).toBe(true);
    });

    it('settles when over-damped without overshoot', () => {
        const frames = settle({ value: 0, velocity: 0 }, 1, 1.6);
        expect(Math.max(...frames.map(frame => frame.value))).toBeLessThanOrEqual(1 + 1e-9);
        expect(isSpringAtRest(frames[frames.length - 1], 1)).toBe(true);
    });

    it('hands the initial velocity off: the first frame moves in the direction of the velocity', () => {
        const fromRest = stepSpring({ value: 0, velocity: 0 }, 0, { damping: 1, response: SPRING_RESPONSE_S }, FRAME);
        const flicked = stepSpring({ value: 0, velocity: 5 }, 0, { damping: 1, response: SPRING_RESPONSE_S }, FRAME);
        expect(fromRest.value).toBe(0);
        expect(flicked.value).toBeGreaterThan(0);
        expect(flicked.velocity).toBeGreaterThan(0);
    });

    it('gives the same result whether advanced in one step or two halves (exact solution)', () => {
        for (const damping of [ 0.8, 1, 1.5 ]) {
            const params = { damping, response: SPRING_RESPONSE_S };
            const start = { value: 0.4, velocity: -2 };
            const whole = stepSpring(start, 2, params, 0.2);
            const halves = stepSpring(stepSpring(start, 2, params, 0.1), 2, params, 0.1);
            expect(halves.value).toBeCloseTo(whole.value, 9);
            expect(halves.velocity).toBeCloseTo(whole.velocity, 9);
        }
    });

    it('is not at rest while still moving', () => {
        expect(isSpringAtRest({ value: 1, velocity: 1 }, 1)).toBe(false);
        expect(isSpringAtRest({ value: 0.9, velocity: 0 }, 1)).toBe(false);
    });
});

describe('wrapDistance and mod', () => {
    it('takes the shortest way round a loop', () => {
        expect(wrapDistance(4, 5)).toBe(-1);
        expect(wrapDistance(-4, 5)).toBe(1);
        expect(wrapDistance(2, 5)).toBe(2);
    });

    it('does not wrap when the carousel does not loop', () => {
        expect(wrapDistance(1, 2)).toBe(1);
        expect(wrapDistance(-1, 2)).toBe(-1);
    });

    it('keeps modulo non-negative', () => {
        expect(mod(-1, 5)).toBe(4);
        expect(mod(6, 5)).toBe(1);
    });
});

describe('slideVisual', () => {
    it('shows the centre slide at full size and opacity, on top', () => {
        const visual = slideVisual(0);
        expect(visual).toEqual({ scale: 1, opacity: 1, contentOpacity: 1, zIndex: 10 });
    });

    it('dims and shrinks a neighbour and hides its copy', () => {
        const visual = slideVisual(-1);
        expect(visual.scale).toBeCloseTo(SIDE_SCALE, 9);
        expect(visual.opacity).toBeCloseTo(SIDE_OPACITY, 9);
        expect(visual.contentOpacity).toBe(0);
        expect(visual.zIndex).toBe(0);
    });

    it('interpolates continuously mid-drag', () => {
        const half = slideVisual(0.5);
        expect(half.scale).toBeGreaterThan(SIDE_SCALE);
        expect(half.scale).toBeLessThan(1);
        expect(half.opacity).toBeGreaterThan(SIDE_OPACITY);
        expect(half.opacity).toBeLessThan(1);
    });

    it('fades far slides out completely so a wrap-around jump is invisible', () => {
        expect(slideVisual(1.5).opacity).toBe(0);
        expect(slideVisual(-2).opacity).toBe(0);
    });
});

describe('rubberBand', () => {
    it('resists more the further past the edge', () => {
        const near = rubberBand(50, 800);
        const far = rubberBand(500, 800);
        expect(near).toBeGreaterThan(0);
        expect(near).toBeLessThan(50);
        expect(far).toBeLessThan(500);
        expect(far / 500).toBeLessThan(near / 50);
    });

    it('keeps the sign and is zero with no overshoot', () => {
        expect(rubberBand(-100, 800)).toBeLessThan(0);
        expect(rubberBand(0, 800)).toBe(0);
    });
});

describe('slideStyle', () => {
    it('centres the middle card exactly', () => {
        expect(slideStyle(0)).toEqual({
            transform: 'translate3d(-50%, 0, 0) translate3d(0px, 0, 0) scale(1)',
            opacity: '1',
            zIndex: '10',
            pointerEvents: '',
            contentOpacity: null
        });
    });

    it('offsets neighbours on opposite sides by the stride and gap, shrunk and dimmed', () => {
        const right = slideStyle(1);
        const left = slideStyle(-1);
        expect(right.transform).toBe(`translate3d(${-50 + STRIDE_FRACTION * 100}%, 0, 0) translate3d(${SLIDE_GAP_PX}px, 0, 0) scale(${SIDE_SCALE})`);
        expect(left.transform).toBe(`translate3d(${-50 - STRIDE_FRACTION * 100}%, 0, 0) translate3d(${-SLIDE_GAP_PX}px, 0, 0) scale(${SIDE_SCALE})`);
        expect(right.opacity).toBe(String(SIDE_OPACITY));
        expect(right.contentOpacity).toBe('0');
    });

    it('stops a fully faded card from catching pointer events', () => {
        expect(slideStyle(2).pointerEvents).toBe('none');
    });
});

describe('SpringAnimator', () => {
    const FRAME_MS = 16;
    let frames: Map<number, (time: number) => void>;
    let nextId: number;

    beforeEach(() => {
        frames = new Map();
        nextId = 1;
        vi.stubGlobal('requestAnimationFrame', (callback: (time: number) => void) => {
            frames.set(nextId, callback);
            nextId += 1;
            return nextId - 1;
        });
        vi.stubGlobal('cancelAnimationFrame', (id: number) => {
            frames.delete(id);
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    function run(maxFrames = 600): void {
        let time = 0;
        for (let i = 0; i < maxFrames && frames.size > 0; i += 1) {
            const [ id, callback ] = frames.entries().next().value as [number, (time: number) => void];
            frames.delete(id);
            time += FRAME_MS;
            callback(time);
        }
    }

    it('updates on every frame and settles exactly on the target', () => {
        const updates: number[] = [];
        const settled: number[] = [];
        const animator = new SpringAnimator(value => updates.push(value), target => settled.push(target));
        animator.start(0, 1, 0, { damping: DAMPING_DEFAULT, response: SPRING_RESPONSE_S });
        expect(animator.running).toBe(true);
        run();

        expect(updates.length).toBeGreaterThan(5);
        expect(updates.every((value, i) => i === 0 || value >= updates[i - 1])).toBe(true);
        expect(settled).toEqual([1]);
        expect(animator.running).toBe(false);
    });

    it('settles at once when already at the target', () => {
        const settled: number[] = [];
        const animator = new SpringAnimator(() => undefined, target => settled.push(target));
        animator.start(2, 2, 0, { damping: DAMPING_DEFAULT, response: SPRING_RESPONSE_S });

        expect(settled).toEqual([2]);
        expect(animator.running).toBe(false);
    });

    it('stops without settling, so a grab can take over from the on-screen value', () => {
        const settled: number[] = [];
        const animator = new SpringAnimator(() => undefined, target => settled.push(target));
        animator.start(0, 1, 0, { damping: DAMPING_DEFAULT, response: SPRING_RESPONSE_S });
        run(3);
        animator.stop();
        run();

        expect(settled).toEqual([]);
        expect(animator.running).toBe(false);
        expect(animator.velocity).toBe(0);
    });

    it('hands the release velocity to the first frames', () => {
        const slow: number[] = [];
        const fast: number[] = [];
        new SpringAnimator(value => slow.push(value), () => undefined).start(0, 1, 0, { damping: DAMPING_DEFAULT, response: SPRING_RESPONSE_S });
        run(2);
        frames.clear();
        new SpringAnimator(value => fast.push(value), () => undefined).start(0, 1, 6, { damping: DAMPING_DEFAULT, response: SPRING_RESPONSE_S });
        run(2);

        expect(fast[0]).toBeGreaterThan(slow[0]);
    });
});

describe('DragGesture', () => {
    const stride = 800;

    function gesture(position = 0): DragGesture {
        return new DragGesture(1, 500, 100, position, stride, false);
    }

    it('stays pending inside the threshold', () => {
        const drag = gesture();
        expect(drag.move(504, 103, 10, 0)).toBe('pending');
        expect(drag.isDragging).toBe(false);
    });

    it('abandons a press that turns vertical', () => {
        expect(gesture().move(503, 130, 10, 0)).toBe('abandon');
    });

    it('commits to a horizontal drag once, then keeps dragging', () => {
        const drag = gesture();
        expect(drag.move(480, 101, 10, 0)).toBe('start');
        expect(drag.move(470, 101, 20, 0)).toBe('drag');
        expect(drag.isDragging).toBe(true);
    });

    it('tracks 1:1 from the point the drag began, without jumping by the threshold', () => {
        const drag = gesture(2);
        drag.move(480, 100, 10, 2);
        expect(drag.positionAt(480)).toBe(2);
        expect(drag.positionAt(480 - stride / 2)).toBeCloseTo(2.5, 9);
        expect(drag.positionAt(480 + stride / 2)).toBeCloseTo(1.5, 9);
    });

    it('starts from the on-screen position of a card that was caught mid-flight', () => {
        const drag = new DragGesture(1, 500, 100, 1.3, stride, true);
        expect(drag.interrupted).toBe(true);
        drag.move(480, 100, 10, 1.3);
        expect(drag.positionAt(480)).toBeCloseTo(1.3, 9);
    });

    it('reports the release velocity from recent moves', () => {
        const drag = gesture();
        drag.move(480, 100, 0, 0);
        drag.move(440, 100, 50, 0);
        drag.move(400, 100, 100, 0);
        expect(drag.releaseVelocity(100)).toBeCloseTo(-800, 6);
        expect(drag.releaseVelocity(100 + VELOCITY_WINDOW_MS + 1)).toBe(0);
    });
});

describe('constrainPosition', () => {
    it('passes positions through inside the range and when looping', () => {
        expect(constrainPosition(0.4, STRIDE, 2)).toBe(0.4);
        expect(constrainPosition(-3.2, STRIDE, 5)).toBe(-3.2);
    });

    it('resists past either end of a non-looping carousel', () => {
        const before = constrainPosition(-0.5, STRIDE, 2);
        const after = constrainPosition(1.5, STRIDE, 2);
        expect(before).toBeLessThan(0);
        expect(before).toBeGreaterThan(-0.5);
        expect(after).toBeGreaterThan(1);
        expect(after).toBeLessThan(1.5);
    });
});
